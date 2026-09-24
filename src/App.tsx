import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import QRCode from "qrcode";
import {
  EVOLVE_WINS, MAX_FOOD, RARITY_COLOR, battle, ensureFoodDay, evolve, feed, grantXp, hatch, maxHp, msUntilMidnight, play, rest,
  rollMutation, rollRarity, rollSpecies, speciesByName, speciesOf, stats, wildOpponent, xpForLevel,
  type BattleResult, type Pet, type Rarity,
} from "./pets";
import { buzz, useSave } from "./store";
import {
  ACTION_FEE_SATS, CUP_ENTRY_SATS, ENTRY_SATS, FOOD_REFILL_SATS, MARKET_FEE_BPS, MINT_FEE_SATS, POT_FEE_BPS, PULL_SATS,
  appendLedger, onesatUrl, seasonKey, verifyLedger, wocTxUrl,
} from "./chain";
import { drawPetCard, useBsv } from "./bsv";
import { arcStatus, p2pkhScript } from "./embedded.ts";
import { embeddedSession, useEmbeddedWallet } from "./embwallet";
import { ensureOsAddress, isOsWallet, osBsv, osSession } from "./oswallet";
import { gwAnchor, gwAtomicBuy, gwAtomicList, gwEnter, gwFoodRefill, gwMarketBuy, gwMint, gwPayout, gwPull, gwTransferNft, type GW } from "./gw";
import { cancelListing, fetchListing, fetchRecentSales, fetchTxDetails, listMarket, markBought, markSettled, postListing, type MarketListing } from "./market";
import { startLogin, useTwetch, type TwetchSession } from "./twetch";
import { PvpPanel } from "./pvp.tsx";

type Tab = "home" | "gacha" | "battle" | "pets" | "market" | "bsv";

const short = (s: string, n = 8) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const potTotal = (list: { sats?: number }[]) => list.reduce((a, e) => a + (e.sats ?? ENTRY_SATS), 0);

/** Poll ARC a few times; report terminal MINED/REJECTED once. Module-level so every tab can watch. */
function watchTxStatus(txid: string, cb: (st: "MINED" | "REJECTED") => void): void {
  const delays = [20000, 60000, 150000];
  const poll = async (left: number[]): Promise<void> => {
    let status = "UNKNOWN";
    try {
      status = (await arcStatus(txid)).txStatus;
    } catch {
      /* indexer hiccup — next tick or manual reconcile covers it */
    }
    if (status === "MINED" || status === "REJECTED") {
      cb(status);
      return;
    }
    const [d, ...rest] = left;
    if (d !== undefined) window.setTimeout(() => void poll(rest), d);
  };
  window.setTimeout(() => void poll(delays), delays[0] ?? 20000);
}

export default function App() {
  const [save, setSave] = useSave();
  // Shared listing URLs must land on the Market tab — the detail sheet
  // only exists there; otherwise buyers just see their active pet.
  const [tab, setTab] = useState<Tab>(() => {
    try {
      if (/\/listing\/[0-9a-fA-F]{64}\.0\/?$/.test(window.location.pathname)) return "market";
      if (window.location.hash.startsWith("#listing-")) return "market";
      if (/^#pvp-[0-9a-f]{16}$/.test(window.location.hash)) return "battle";
    } catch {
      /* ignore */
    }
    return "home";
  });
  const [toast, setToast] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Pet | null>(null);
  const [enemy, setEnemy] = useState<Pet | null>(null);
  const [result, setResult] = useState<BattleResult | null>(null);
  const [battling, setBattling] = useState(false);
  const [mintingUid, setMintingUid] = useState<string | null>(null);
  const [battleMode, setBattleMode] = useState<"wild" | "pvp">(() => {
    try {
      return /^#pvp-[0-9a-f]{16}$/.test(window.location.hash) ? "pvp" : "wild";
    } catch {
      return "wild";
    }
  });
  const [refilling, setRefilling] = useState(false);
  const [evoReveal, setEvoReveal] = useState<{ pet: Pet; fromName: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const bsv = useBsv();
  const season = seasonKey();
  const tw = useTwetch();

  useEffect(() => {
    void tw.settleCallback().then((ok) => {
      if (ok) say("Signed in with Twetch 🎉");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tw.authError) say(tw.authError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tw.authError]);

  const say = (t: string) => {
    setToast(t);
    window.clearTimeout(timer.current ?? undefined);
    timer.current = window.setTimeout(() => setToast(null), 2400);
  };

  const active = useMemo(
    () => save.pets.find((p) => p.uid === save.activeUid) ?? save.pets[0] ?? null,
    [save]
  );

  const record = async (action: string, petUid: string, detail: string) => {
    const next = await appendLedger(save.ledger, action, petUid, detail);
    setSave((s) => ({ ...s, ledger: next }));
    return next;
  };

  /**
   * Background confirmation watch. Broadcast-accepted is not confirmed:
   * unwind the local record on REJECTED so the user can retry.
   */
  const watchTx = (txid: string, kind: "mint" | "other", petUid?: string) => {
    watchTxStatus(txid, (st) => {
      if (st === "MINED") return;
      // REJECTED: unwind so the user can retry — funds were never moved.
      if (kind === "mint" && petUid) {
        setSave((s) => ({
          ...s,
          pets: s.pets.map((p) => (p.uid === petUid ? { ...p, nft: undefined } : p)),
        }));
        void record("mint_failed", petUid, `rejected ${txid.slice(0, 12)} — not charged, tap Mint again`);
        say("Mint didn't confirm (lost a coin race) — you weren't charged. Tap Mint again.");
      } else {
        void record("tx_failed", petUid ?? "-", `${kind} ${txid.slice(0, 12)} rejected`);
        say("A recent transaction was rejected by the network — nothing moved. Retry it.");
      }
    });
  };

  const patchPet = (uid: string, fn: (p: Pet) => Pet) =>
    setSave((s) => ({ ...s, pets: s.pets.map((p) => (p.uid === uid ? fn(p) : p)) }));

  const doRefill = async () => {
    const gw = needWallet();
    if (!gw) return;
    if (ensureFoodDay(save.food).left >= MAX_FOOD) {
      say("Bowl's already full!");
      return;
    }
    setRefilling(true);
    try {
      say(`Paying ${FOOD_REFILL_SATS} sat for a full bowl…`);
      const { txid, refillSats } = await gwFoodRefill(gw, save.feeAddress);
      const ledger = await appendLedger(save.ledger, "food_refill", active?.uid ?? "-", `${refillSats} sats refill ${txid.slice(0, 12)}`);
      setSave((s) => ({ ...s, ledger, food: { ...ensureFoodDay(s.food), left: MAX_FOOD } }));
      say(`🍖 Bowl refilled! ${short(txid)}`);
      watchTx(txid, "other", active?.uid);
      buzz(40);
    } catch (e) {
      say(`Refill failed: ${e instanceof Error ? e.message : "wallet declined"}`);
    } finally {
      setRefilling(false);
    }
  };

  const careAction = async (kind: "feed" | "play" | "rest") => {
    if (!active) return;
    if (kind === "play" && active.energy < 10) {
      say("Too tired — Rest first!");
      return;
    }
    if (kind === "feed") {
      const bowl = ensureFoodDay(save.food);
      if (bowl.left <= 0) {
        say("🍖 Bowl's empty — food refills at midnight!");
        return;
      }
      setSave((s) => ({ ...s, food: { ...ensureFoodDay(s.food), left: ensureFoodDay(s.food).left - 1 } }));
    }
    const base = kind === "feed" ? feed(active) : kind === "play" ? play(active) : rest(active);
    const verb = kind === "feed" ? "+hp/happy" : kind === "play" ? "+happy -energy" : "+energy";
    let next = base;
    // small chance of mutation on every care action — same species line, next rarity
    if (rollMutation(kind)) {
      const ev = evolve(base);
      if (ev) {
        next = ev.pet;
        patchPet(active.uid, () => next);
        await record(kind, active.uid, verb);
        await record("evolve", active.uid, `${ev.from.name} -> ${ev.to.name} (mutation)`);
        setEvoReveal({ pet: next, fromName: ev.from.name });
        say(`🌟 MUTATION! ${active.nickname} became ${ev.to.name}!`);
        buzz(80);
        return;
      }
    }
    patchPet(active.uid, () => next);
    buzz(kind === "rest" ? 10 : 15);
    if (kind === "rest") say("😴 rested!");
    await record(kind, active.uid, verb);
  };

  const needWallet = (): GW | null => {
    const os = osSession();
    if (os) return { kind: "os", ...os };
    if (bsv.connected && bsv.ctx) return { kind: "yours", ctx: bsv.ctx };
    const s = embeddedSession();
    if (s) return { kind: "embedded", ...s };
    say("Connect Yours or unlock the built-in wallet (BSV tab)");
    setTab("bsv");
    return null;
  };

  const doMint = async (pet: Pet) => {
    if (pet.nft || mintingUid) return;
    const gw = needWallet();
    if (!gw) return;
    setMintingUid(pet.uid);
    try {
      say(gw.kind === "embedded" ? "Minting (fee + inscription, one signature)…" : `Paying ${MINT_FEE_SATS} sat mint fee…`);
      const r = await gwMint(gw, pet, save.feeAddress);
      patchPet(pet.uid, (p) => ({
        ...p,
        nft: {
          origin: r.origin, txid: r.txid, contentHash: r.contentHash, mintedAt: Date.now(),
          scriptHex: r.scriptHex, mintAddress: gw.kind === "embedded" ? gw.address : undefined,
        },
      }));
      await record("mint", pet.uid, `fee ${r.feeTxid.slice(0, 12)} ordinal ${r.origin}${gw.kind === "embedded" ? " 1tx" : ""}`);
      say(`🎴 Minted! ${short(r.txid)}`);
      watchTx(r.txid, "mint", pet.uid);
      buzz(50);
    } catch (e) {
      say(`Mint failed: ${e instanceof Error ? e.message : "wallet declined"}`);
    } finally {
      setMintingUid(null);
    }
  };

  // --- onboarding: pick-an-egg ---
  if (save.pets.length === 0) {
    return (
      <div className="shell">
        <div className="hero">
          <div className="logo">🥚</div>
          <h1>Pocket Pets</h1>
          <p>Pick an egg. Raise it. Mint it as an NFT. Battle for the BSV pot.</p>
        </div>
        <div className="eggs">
          {["🥚", "🦕", "🌟"].map((e) => (
            <motion.button
              key={e} className="egg" whileTap={{ scale: 0.9 }}
              onClick={async () => {
                const sp = rollSpecies(rollRarity(0));
                const pet = { ...hatch(sp), nickname: sp.name };
                const ledger = await appendLedger([], "hatch", pet.uid, `${sp.id} from egg`);
                setSave((s) => ({ ...s, pets: [pet], activeUid: pet.uid, totalPulls: 1, ledger }));
                setRevealed(pet);
                buzz(30);
              }}
            >
              <span>{e}</span>
            </motion.button>
          ))}
        </div>
        <AnimatePresence>{revealed && <Reveal pet={revealed} onClose={() => setRevealed(null)} />}</AnimatePresence>
      </div>
    );
  }


  const doPull = async () => {
    const gw = needWallet();
    if (!gw) return;
    setBusy("pull");
    try {
      const pity = save.pity + 1;
      const rarity = rollRarity(pity);
      const sp = rollSpecies(rarity);
      const pet = hatch(sp, pity);
      say(`Paying ${PULL_SATS} sat per pull…`);
      const { txid, pullSats } = await gwPull(gw, save.feeAddress, pet.uid);
      const hitLegend = rarity === "legendary";
      const ledger = await appendLedger(save.ledger, "pull", pet.uid, `${sp.id}/${rarity} pity=${pity} fee ${txid.slice(0, 12)} (${pullSats}sats)`);
      setSave((s) => ({
        ...s,
        pets: [...s.pets, pet],
        activeUid: s.activeUid ?? pet.uid,
        pity: hitLegend ? 0 : pity,
        totalPulls: s.totalPulls + 1,
        ledger,
      }));
      setRevealed(pet);
      buzz(hitLegend ? 60 : 25);
      watchTx(txid, "other", pet.uid);
    } catch (e) {
      say(`Pull failed: ${e instanceof Error ? e.message : "wallet declined"}`);
    } finally {
      setBusy(null);
    }
  };

  const doBattle = async () => {
    if (!active || battling) return;
    if (active.energy < 10) {
      say("Too tired — Rest first!");
      return;
    }
    const foe = wildOpponent(active.level);
    const res = battle(active, foe);
    setEnemy(foe);
    setResult(res);
    setBattling(true);
    const ledger = await appendLedger(save.ledger, "battle_start", active.uid, `vs wild ${foe.nickname} L${foe.level}`);
    setSave((s) => ({ ...s, ledger }));
    // EpicBattle drives playback and calls finishBattle via onDone.
  };

  const finishBattle = async (res: BattleResult) => {
    const cur = save.pets.find((p) => p.uid === save.activeUid) ?? save.pets[0];
    if (!cur) return;
    const won = res.winnerUid === cur.uid;
    const last = res.log[res.log.length - 1];
    const hpLeft = Math.max(1, Math.round(last?.aHp ?? maxHp(cur)));
    let next: Pet = grantXp({
      ...cur,
      hp: won ? Math.max(hpLeft, Math.floor(maxHp(cur) * 0.25)) : Math.floor(maxHp(cur) * 0.25),
      energy: Math.max(0, cur.energy - 15),
      wins: cur.wins + (won ? 1 : 0),
    }, won ? 22 : 8).pet;
    // win milestones: common 100 -> rare, rare 250 -> epic, epic 500 -> legendary
    const evos: Array<{ from: string; to: string }> = [];
    if (won) {
      for (;;) {
        const need = EVOLVE_WINS[speciesOf(next).rarity as Rarity];
        if (need === undefined || next.wins < need) break;
        const ev = evolve(next);
        if (!ev) break;
        evos.push({ from: ev.from.name, to: ev.to.name });
        next = ev.pet;
      }
    }
    setSave((s) => ({ ...s, pets: s.pets.map((p) => (p.uid === cur.uid ? next : p)) }));
    await record(won ? "battle_win" : "battle_loss", cur.uid, `${res.rounds} rounds`);
    for (const e of evos) {
      await record("evolve", cur.uid, `${e.from} -> ${e.to} (${next.wins} wins)`);
    }
    setBattling(false);
    if (evos.length > 0) {
      const lastEvo = evos[evos.length - 1]!;
      setEvoReveal({ pet: next, fromName: evos[0]!.from });
      say(`🌟 EVOLUTION! ${cur.nickname} became ${lastEvo.to}!`);
      buzz(80);
    } else {
      say(won ? `🏆 ${cur.nickname} wins! +22 XP` : `Wild wins… +8 XP`);
      buzz(won ? 50 : 20);
    }
  };

  const seasonEntries = save.entries.filter((e) => e.season === season);
  const potSats = potTotal(seasonEntries);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">🐾 Pocket Pets</div>
        <div className="topright">
          <div className="wallet">🎰 {PULL_SATS} sat/pull <span>· 🏆 {potSats.toLocaleString()}</span></div>
          {tw.session ? (
            <button className="acct" onClick={() => setTab("bsv")} title={`@${tw.session.handle}`}>
              {tw.session.avatar ? <img src={tw.session.avatar} alt="" /> : <span>🐾</span>}
            </button>
          ) : tw.authBusy ? (
            <div className="wallet"><span>signing in…</span></div>
          ) : (
            <button className="signinbtn" onClick={() => startLogin()}>Sign in</button>
          )}
        </div>
      </header>

      <main className="main">
        {tw.session && save.pets.length === 0 && (
          <p className="muted">
            Coming from the old <code>entangleit.com/pocketpets</code>?{" "}
            <a href="https://entangleit.com/pocketpets/migrate">Move your pets &amp; wallet →</a>
          </p>
        )}
        {tab === "home" && active && (
          <HomeTab
            pet={active}
            minting={mintingUid === active.uid}
            foodLeft={ensureFoodDay(save.food).left}
            foodMax={MAX_FOOD}
            refilling={refilling}
            onRefill={() => void doRefill()}
            onFeed={() => void careAction("feed")}
            onPlay={() => void careAction("play")}
            onRest={() => void careAction("rest")}
            onMint={() => void doMint(active)}
          />
        )}
        {tab === "gacha" && (
          <section className="card">
            <h2>✨ Gacha Pulls</h2>
            <p className="muted">pity {save.pity} (boosts legendary) · every pull pays {PULL_SATS} sat on-chain</p>
            <div className="rates">
              {(["common", "rare", "epic", "legendary"] as const).map((r) => (
                <span key={r} className="pill" style={{ borderColor: RARITY_COLOR[r] }}>{r}</span>
              ))}
            </div>
            <motion.button className="primary big" whileTap={{ scale: 0.96 }} onClick={() => void doPull()} disabled={busy === "pull"}>
              {busy === "pull" ? "Paying…" : `🎲 Pull — ${PULL_SATS} sat`}
            </motion.button>
            <p className="muted">First pet is free. Paid pulls are hash-logged with their payment txid. Mint winners as 1Sat Ordinals ({MINT_FEE_SATS} sat fee) from Home.</p>
          </section>
        )}
        {tab === "battle" && (
          <>
            <div className="seg">
              {(["wild", "pvp"] as const).map((m) => (
                <button key={m} className={battleMode === m ? "segbtn on" : "segbtn"} onClick={() => setBattleMode(m)}>
                  {m === "wild" ? "🐾 Wild" : "⚔️ PvP"}
                </button>
              ))}
            </div>
            {battleMode === "wild" ? (
          <section className="card">
            <h2>⚔️ Wild Battle</h2>
            {!result || !enemy || !active ? (
              <>
                <p className="muted">Your {active?.nickname} (Lv {active?.level}) vs a wild pet. Winner earns XP. All battles logged — wins count toward the Battle Cup.</p>
                <button className="primary big" onClick={() => void doBattle()} disabled={battling}>Start battle</button>
              </>
            ) : (
              <WildArena
                active={active} enemy={enemy} result={result}
                onDone={() => { if (result) void finishBattle(result); }}
                onRematch={() => { setResult(null); setEnemy(null); }}
                onQuit={() => { setResult(null); setEnemy(null); setTab("home"); }}
              />
            )}
          </section>
            ) : (
              <PvpPanel
                say={say} busy={busy} setBusy={setBusy} tw={tw.session} onLogin={() => startLogin()}
                onEvolve={(pet, fromName) => { setEvoReveal({ pet, fromName }); say(`🌟 EVOLUTION! ${pet.nickname} evolved from ${fromName}!`); }}
              />
            )}
          </>
        )}
        {tab === "pets" && (
          <CollectionTab
            pets={save.pets} activeUid={active?.uid ?? null}
            mintingUid={mintingUid}
            onSelect={(uid) => { setSave((s) => ({ ...s, activeUid: uid })); say("Active pet set!"); }}
            onShare={(p) => void sharePet(p)}
            onMint={(p) => void doMint(p)}
            onRename={(p) => {
              const n = window.prompt("Nickname", p.nickname)?.slice(0, 16);
              if (n) patchPet(p.uid, (x) => ({ ...x, nickname: n }));
            }}
          />
        )}
        {tab === "market" && (
          <MarketTab busy={busy} setBusy={setBusy} say={say} tw={tw.session} onLogin={() => startLogin()} />
        )}
        {tab === "bsv" && (
          <BsvTab busy={busy} setBusy={setBusy} say={say} verifyMsg={verifyMsg} setVerifyMsg={setVerifyMsg} tw={tw.session} onLogin={() => startLogin()} onLogout={() => { tw.logout(); say("Signed out"); }} />
        )}
      </main>

      <AnimatePresence>{revealed && <Reveal pet={revealed} onClose={() => setRevealed(null)} />}</AnimatePresence>
      <AnimatePresence>{evoReveal && (
        <Reveal pet={evoReveal.pet} onClose={() => setEvoReveal(null)} subtitle={`evolved from ${evoReveal.fromName}!`} />
      )}</AnimatePresence>
      {toast && <div className="toast">{toast}</div>}

      <nav className="tabs tabs6">
        {([["home", "🏠", "Home"], ["gacha", "🎲", "Gacha"], ["battle", "⚔️", "Battle"], ["pets", "📦", "Pets"], ["market", "🛒", "Market"], ["bsv", "⛓️", "BSV"]] as Array<[Tab, string, string]>).map(([id, icon, label]) => (
          <button key={id} className={tab === id ? "tab on" : "tab"} onClick={() => { setTab(id); buzz(10); }}>
            <span>{icon}</span><small>{label}</small>
          </button>
        ))}
      </nav>
    </div>
  );
}

function Bar({ value, color }: { value: number; color: string }) {
  return <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} /></div>;
}

function NftBadge({ pet }: { pet: Pet }) {
  if (!pet.nft) return <span className="pill ghost">not minted</span>;
  return (
    <a className="pill" style={{ borderColor: "#fbbf24" }} href={wocTxUrl(pet.nft.txid)} target="_blank" rel="noreferrer">
      🎴 NFT {short(pet.nft.txid)}
    </a>
  );
}

function HomeTab({ pet, minting, foodLeft, foodMax, refilling, onRefill, onFeed, onPlay, onRest, onMint }: {
  pet: Pet; minting: boolean; foodLeft: number; foodMax: number; refilling: boolean;
  onRefill(): void; onFeed(): void; onPlay(): void; onRest(): void; onMint(): void;
}) {
  const sp = speciesOf(pet);
  const st = stats(pet);
  const need = xpForLevel(pet.level);
  const evoAt = EVOLVE_WINS[sp.rarity as Rarity];
  const refillIn = useMemo(() => {
    const ms = msUntilMidnight();
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }, []);
  return (
    <section className="card petcard">
      <motion.div className="avatar" style={{ background: `${sp.color}33`, borderColor: sp.color }}
        animate={{ y: [0, -6, 0] }} transition={{ repeat: Infinity, duration: 2.4 }}>
        {sp.emoji}
      </motion.div>
      <h2>{pet.nickname} <small>Lv {pet.level} · {sp.name} · “{sp.blurb}”</small></h2>
      <div><span className="pill" style={{ borderColor: RARITY_COLOR[sp.rarity] }}>{sp.rarity}{pet.wins > 0 ? ` · ${pet.wins}🏆` : ""}</span> <NftBadge pet={pet} /></div>
      {pet.evolvedFrom && pet.evolvedFrom.length > 0 && (
        <p className="muted">🧬 evolved: {pet.evolvedFrom.join(" → ")} → {sp.name}</p>
      )}
      {evoAt !== undefined ? (
        <div className="evobar"><label>🌟 evolves at {evoAt} wins ({pet.wins}/{evoAt})</label><Bar value={(pet.wins / evoAt) * 100} color="#c084fc" /></div>
      ) : (
        <p className="muted">👑 max rarity reached</p>
      )}
      {!pet.nft && <button className="mintbtn" onClick={onMint} disabled={minting}>{minting ? "Minting…" : `🎴 Mint as NFT — ${MINT_FEE_SATS} sat fee`}</button>}
      <div className="stats">
        <div><label>HP {pet.hp}/{maxHp(pet)}</label><Bar value={(pet.hp / maxHp(pet)) * 100} color="#4ade80" /></div>
        <div><label>😊 {pet.happy}</label><Bar value={pet.happy} color="#f472b6" /></div>
        <div><label>⚡ {pet.energy}</label><Bar value={pet.energy} color="#facc15" /></div>
        <div><label>XP {pet.xp}/{need}</label><Bar value={(pet.xp / need) * 100} color="#60a5fa" /></div>
      </div>
      <div className="atk">ATK {st.atk} · DEF {st.def} · SPD {st.spd}</div>
      <div className="foodrow">
        <label>🍖 Food {foodLeft}/{foodMax}{foodLeft <= 0 ? ` · refills in ${refillIn}` : ""}</label>
        <Bar value={(foodLeft / foodMax) * 100} color={foodLeft <= 0 ? "#ef4444" : "#fb923c"} />
        {foodLeft < foodMax && (
          <button className="refillbtn" onClick={onRefill} disabled={refilling}>
            {refilling ? "Paying…" : `🍖 Refill bowl — ${FOOD_REFILL_SATS} sat`}
          </button>
        )}
      </div>
      <p className="muted">✨ feeding, playing & resting can trigger a wild mutation</p>
      <div className="row3">
        <button onClick={onFeed} disabled={foodLeft <= 0}>{foodLeft <= 0 ? "🚫 No food" : "🍖 Feed"}</button>
        <button onClick={onPlay}>🎾 Play</button>
        <button onClick={onRest}>😴 Rest</button>
      </div>
    </section>
  );
}

function Reveal({ pet, onClose, subtitle }: { pet: Pet; onClose(): void; subtitle?: string }) {
  const sp = speciesOf(pet);
  return (
    <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="reveal" initial={{ scale: 0.6, rotate: -4 }} animate={{ scale: 1, rotate: 0 }}
        style={{ borderColor: RARITY_COLOR[sp.rarity] }} onClick={(e) => e.stopPropagation()}>
        <div className="bigemoji">{sp.emoji}</div>
        <h3>{pet.nickname}!</h3>
        {subtitle && <p className="evosub">{subtitle}</p>}
        <span className="pill" style={{ borderColor: RARITY_COLOR[sp.rarity] }}>{sp.rarity}</span>
        <p className="muted">Mint it as an NFT ({MINT_FEE_SATS} sat) from Home 🎴</p>
        <button className="primary" onClick={onClose}>Keep!</button>
      </motion.div>
    </motion.div>
  );
}

import { EpicBattle, type EpicFighter } from "./EpicBattle.tsx";
import { routePath } from "./routes.ts";

function fighterCard(pet: Pet, sub: string): EpicFighter {
  const sp = speciesOf(pet);
  let art: string | null = null;
  try {
    art = drawPetCard(pet);
  } catch {
    art = null;
  }
  return { name: pet.nickname, sub, art, emoji: sp.emoji, color: sp.color, maxHp: stats(pet).hp };
}

function WildArena({ active, enemy, result, onDone, onRematch, onQuit }: {
  active: Pet; enemy: Pet; result: BattleResult;
  onDone(): void; onRematch(): void; onQuit(): void;
}) {
  const a = useMemo(() => fighterCard(active, `Lv ${active.level}`), [active]);
  const b = useMemo(() => fighterCard(enemy, `Wild Lv ${enemy.level}`), [enemy]);
  return (
    <EpicBattle
      a={a}
      b={b}
      log={result.log}
      playerWon={result.winnerUid === active.uid}
      onDone={onDone}
      endActions={
        <div className="row2">
          <button className="primary" onClick={onRematch}>Rematch</button>
          <button onClick={onQuit}>Home</button>
        </div>
      }
    />
  );
}

function CollectionTab({ pets, activeUid, mintingUid, onSelect, onShare, onMint, onRename }: {
  pets: Pet[]; activeUid: string | null; mintingUid: string | null;
  onSelect(uid: string): void; onShare(p: Pet): void; onMint(p: Pet): void; onRename(p: Pet): void;
}) {
  return (
    <section>
      <div className="grid">
        {pets.map((p) => {
          const sp = speciesOf(p);
          return (
            <button key={p.uid} className={p.uid === activeUid ? "mini on" : "mini"} onClick={() => onSelect(p.uid)}>
              <span className="me">{sp.emoji}</span>
              <b>{p.nickname}</b>
              <small>Lv {p.level} · {sp.rarity}{p.nft ? " · 🎴" : ""}</small>
              <span className="minrow">
                <i onClick={(e) => { e.stopPropagation(); onShare(p); }}>📤</i>
                {!p.nft && <i onClick={(e) => { e.stopPropagation(); onMint(p); }}>{mintingUid === p.uid ? "⏳" : "🎴"}</i>}
                <i onClick={(e) => { e.stopPropagation(); onRename(p); }}>✏️</i>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function WalletCard({ say }: { say(t: string): void }) {
  const bsv = useBsv();
  const emb = useEmbeddedWallet();
  const osAvail = isOsWallet();
  const [which, setWhich] = useState<"yours" | "builtin" | "os">(
    osAvail ? "os" : bsv.status === "connected" ? "yours" : "builtin",
  );
  const [osAddr, setOsAddr] = useState<string | null>(null);
  const [osBal, setOsBal] = useState<number | null>(null);
  const [osErr, setOsErr] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (which !== "builtin" || !emb.address) return;
    setQr(null);
  }, [which, emb.address]);

  const showQr = async () => {
    if (!emb.address) return;
    try {
      setQr(await QRCode.toDataURL(emb.address, { width: 200, margin: 1 }));
    } catch {
      say("QR failed — copy the address instead");
    }
  };

  const run = (p: Promise<unknown>, ok: string) =>
    p.then(() => say(ok)).catch((e: unknown) => say(e instanceof Error ? e.message : "failed"));

  const osRefresh = async () => {
    try {
      const addr = await ensureOsAddress();
      setOsAddr(addr);
      const b = await osBsv().getBalance();
      setOsBal(b.confirmed + b.unconfirmed);
      setOsErr(null);
    } catch (e) {
      setOsErr(e instanceof Error ? e.message : "OS wallet unreachable");
    }
  };

  useEffect(() => {
    if (osAvail && which === "os" && !osAddr) void osRefresh();
  });

  const osTabs: Array<"yours" | "builtin" | "os"> = osAvail ? ["os", "yours", "builtin"] : ["yours", "builtin"];

  return (
    <div>
      <div className="seg">
        {osTabs.map((w) => (
          <button key={w} className={which === w ? "segbtn on" : "segbtn"} onClick={() => setWhich(w)}>
            {w === "yours" ? "Yours" : w === "os" ? "OS" : "Built-in"}
          </button>
        ))}
      </div>
      {which === "os" ? (
        <div>
          <div className="wrow">
            <span className="pill ok">OS custody · {osAddr ? short(osAddr, 6) : "…"}</span>
            <button onClick={() => void osRefresh()}>↻ {osBal === null ? "…" : `${osBal.toLocaleString()} sats`}</button>
          </div>
          <p className="muted">Keys live in the OS daemon under policy — nothing to back up or export here. Approve spends in the wallet panel.</p>
          {osErr && <p className="muted">{osErr}</p>}
          {osAddr && <div className="row3">
            <button onClick={() => void navigator.clipboard.writeText(osAddr).then(() => say("Address copied"))}>📋 Copy</button>
          </div>}
        </div>
      ) : which === "yours" ? (
        bsv.status === "connected" ? (
          <div className="wrow">
            <span className="pill ok">connected{bsv.identityKey ? ` · ${short(bsv.identityKey, 6)}` : ""}</span>
            <button onClick={() => bsv.disconnect()}>Disconnect</button>
          </div>
        ) : (
          <button className="primary" onClick={() => void bsv.connect().catch((e: unknown) => say(`Connect failed: ${e instanceof Error ? e.message : "no wallet"}`))}>
            Connect Yours Wallet
          </button>
        )
      ) : emb.mode === "unlocked" && emb.address ? (
        <div>
          <div className="wrow">
            <span className="pill ok">built-in · {short(emb.address, 6)}</span>
            <button onClick={() => { void emb.refresh(); }}>↻ {emb.loadingBal ? "…" : `${emb.balance.toLocaleString()} sats`}</button>
          </div>
          <div className="row3">
            <button onClick={() => { void navigator.clipboard.writeText(emb.address!).then(() => say("Address copied")); }}>📋 Copy</button>
            <button onClick={() => void showQr()}>📷 QR</button>
            <button onClick={() => emb.lock()}>🔒 Lock</button>
          </div>
          {qr && <div className="qrzone"><img src={qr} alt="receive QR" /><small>Scan to fund (a few cents of BSV covers many actions)</small></div>}
          <div className="row2">
            <button onClick={() => {
              if (window.confirm("Show private key (WIF)? Anyone with it owns the funds.")) {
                const w = emb.wif();
                if (w) void navigator.clipboard.writeText(w).then(() => say("WIF copied — back it up offline"));
              }
            }}>🔑 Export</button>
            <button onClick={() => { if (window.confirm("Forget this wallet on this device? (Keep your backup!)")) { emb.forget(); say("Wallet forgotten"); } }}>🗑️ Forget</button>
          </div>
        </div>
      ) : emb.mode === "locked" ? (
        <div>
          <p className="muted">Built-in wallet locked. Enter PIN to unlock.</p>
          <label className="fld"><span>PIN</span>
            <input type="password" inputMode="numeric" value={emb.pin} onChange={(e) => emb.setPin(e.target.value)} />
          </label>
          <div className="row2">
            <button className="primary" onClick={() => void emb.unlock(emb.pin).then((ok) => say(ok ? "Unlocked 🔓" : "Wrong PIN"))}>Unlock</button>
            <button onClick={() => { if (window.confirm("Forget this wallet on this device?")) emb.forget(); }}>Forget</button>
          </div>
        </div>
      ) : (
        <div>
          <p className="muted">No Yours? Create a free built-in wallet — self-custody, PIN-encrypted on this phone.</p>
          {!emb.showImport ? (
            <>
              <label className="fld"><span>New PIN (4+ chars, encrypts the key)</span>
                <input type="password" inputMode="numeric" value={emb.pin} onChange={(e) => emb.setPin(e.target.value)} />
              </label>
              <div className="row2">
                <button className="primary" onClick={() => void run(emb.create(emb.pin), "Wallet created 🎉 — fund it to play on-chain")}>Create wallet</button>
                <button onClick={() => emb.setShowImport(true)}>Import WIF</button>
              </div>
            </>
          ) : (
            <>
              <label className="fld"><span>Private key (WIF)</span>
                <input value={emb.importWif} placeholder="K..." onChange={(e) => emb.setImportWif(e.target.value)} />
              </label>
              <label className="fld"><span>New PIN</span>
                <input type="password" inputMode="numeric" value={emb.pin} onChange={(e) => emb.setPin(e.target.value)} />
              </label>
              <div className="row2">
                <button className="primary" onClick={() => void run(emb.doImport(emb.importWif, emb.pin), "Wallet imported 🎉")}>Import</button>
                <button onClick={() => emb.setShowImport(false)}>Back</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ListingDetail({ l, mine, busy, onClose, onBuy, onSettle, onCancel, settleTx, setSettleTx, say }: {
  l: MarketListing; mine: boolean; busy: string | null; onClose(): void;
  onBuy(): void; onSettle(): void; onCancel(): void;
  settleTx: string; setSettleTx(v: string): void; say(t: string): void;
}) {
  const sp = speciesByName(l.species);
  const pseudo: Pet = useMemo(() => ({
    uid: l.origin, speciesId: sp.id, nickname: l.nickname, level: l.level,
    xp: 0, hp: 1, happy: 70, energy: 100, wins: 0, pulls: 0,
  }), [l.origin, l.nickname, l.level, sp.id]);
  const st = stats(pseudo);
  const art = useMemo(() => {
    try {
      return drawPetCard({ ...pseudo, hp: maxHp(pseudo) });
    } catch {
      return null;
    }
  }, [pseudo]);
  const fee = Math.max(1, Math.floor((l.price_sats * MARKET_FEE_BPS) / 10000));
  const isAtomic = !!l.seller_unlock;
  const shareUrl = `${window.location.origin}${routePath(`listing/${l.origin}`)}`;
  const listed = new Date(l.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <motion.div className="overlay scroll" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="sheet" initial={{ y: 60 }} animate={{ y: 0 }} exit={{ y: 60 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheetbar" />
        {art && <img className="detailart" src={art} alt={`${l.nickname} card`} />}
        <h2>{l.nickname} <small>Lv {l.level} · {l.species}</small></h2>
        <div>
          <span className="pill" style={{ borderColor: RARITY_COLOR[sp.rarity as keyof typeof RARITY_COLOR] ?? "#9ca3af" }}>{l.rarity}</span>{" "}
          <span className="pill">{isAtomic ? "⚡ atomic" : "🔒 escrow"}</span>{" "}
          <span className="pill" style={{ borderColor: l.status === "paid" ? "#facc15" : undefined }}>{l.status}</span>
        </div>
        <p className="muted">“{sp.blurb}”</p>
        <div className="statgrid">
          <div><b>{st.atk}</b><small>ATK</small></div>
          <div><b>{st.def}</b><small>DEF</small></div>
          <div><b>{st.spd}</b><small>SPD</small></div>
          <div><b>{st.hp}</b><small>HP</small></div>
        </div>
        <div className="priceline">💰 {l.price_sats.toLocaleString()} sats <small>+ {fee.toLocaleString()} fee = {(l.price_sats + fee).toLocaleString()} total</small></div>
        <div className="prov">
          <div><span>Seller</span><b>{l.seller_handle ? `@${l.seller_handle}` : short(l.seller, 8)}</b></div>
          <div><span>Listed</span><b>{listed}</b></div>
          <div><span>Origin</span><b><a href={onesatUrl(l.origin)} target="_blank" rel="noreferrer">1sat</a> · <a href={wocTxUrl(l.origin.split(".")[0]!)} target="_blank" rel="noreferrer">WoC</a></b></div>
          {!isAtomic && l.escrow_txid && <div><span>Escrow tx</span><b><a href={wocTxUrl(l.escrow_txid)} target="_blank" rel="noreferrer">{short(l.escrow_txid)}</a></b></div>}
          {l.buy_txid && <div><span>{l.status === "sold" ? "Sale tx" : "Payment tx"}</span><b><a href={wocTxUrl(l.buy_txid)} target="_blank" rel="noreferrer">{short(l.buy_txid)}</a>{l.buyer_handle ? ` by @${l.buyer_handle}` : ""}</b></div>}
          {l.transfer_txid && l.transfer_txid !== l.buy_txid && <div><span>Delivery tx</span><b><a href={wocTxUrl(l.transfer_txid)} target="_blank" rel="noreferrer">{short(l.transfer_txid)}</a></b></div>}
        </div>
        {l.status === "active" && !mine && (
          <button className="primary big" disabled={busy === "buy"} onClick={onBuy}>
            {busy === "buy" ? "…" : isAtomic ? `⚡ Swap — ${(l.price_sats + fee).toLocaleString()} sats` : `Buy — ${(l.price_sats + fee).toLocaleString()} sats`}
          </button>
        )}
        {l.status === "paid" && (
          <>
            <label className="fld"><span>Operator: escrow→buyer transfer txid</span>
              <input value={settleTx} placeholder="paste txid after delivering" onChange={(e) => setSettleTx(e.target.value)} />
            </label>
            <button disabled={busy === "settle"} onClick={onSettle}>{busy === "settle" ? "…" : "Confirm delivery"}</button>
          </>
        )}
        {l.status === "active" && (
          <button className="linkbtn" onClick={onCancel}>Cancel listing</button>
        )}
        <div className="row2">
          <button onClick={() => {
            const text = `🐾 ${l.nickname} (${l.species} Lv${l.level}) — ${l.price_sats.toLocaleString()} sats ${shareUrl}`;
            if (navigator.share) void navigator.share({ text }).catch(() => undefined);
            else void navigator.clipboard.writeText(text).then(() => say("Link copied"));
          }}>📤 Share</button>
          <button onClick={onClose}>Close</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function MarketTab({ busy, setBusy, say, tw, onLogin }: {
  busy: string | null; setBusy(s: string | null): void; say(t: string): void;
  tw: TwetchSession | null; onLogin(): void;
}) {
  const [save, setSave] = useSave();
  const bsv = useBsv();
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [recent, setRecent] = useState<MarketListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [extra, setExtra] = useState<Record<string, MarketListing>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [manual, setManual] = useState<Record<string, { escrowTxid: string; seller: string }>>({});
  const [settleTx, setSettleTx] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<string | null>(() => {
    const m = window.location.pathname.match(/\/listing\/([0-9a-fA-F]{64}\.0)\/?$/);
    if (m) return m[1]!;
    return window.location.hash.startsWith("#listing-") ? window.location.hash.slice("#listing-".length) : null;
  });

  const openDetail = (origin: string) => {
    setDetail(origin);
    try {
      window.history.replaceState(null, "", routePath(`listing/${origin}`));
    } catch {
      /* ignore */
    }
  };
  const closeDetail = () => {
    setDetail(null);
    try {
      window.history.replaceState(null, "", routePath());
    } catch {
      /* ignore */
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [open, sold] = await Promise.all([listMarket(), fetchRecentSales()]);
      setListings(open);
      setRecent(sold);
    } catch {
      say("Market load failed — try again");
    } finally {
      setLoading(false);
    }
  }, [say]);

  useEffect(() => { void refresh(); }, [refresh]);

  const recordHere = async (action: string, petUid: string, detail: string) => {
    const next = await appendLedger(save.ledger, action, petUid, detail);
    setSave((s) => ({ ...s, ledger: next }));
  };

  const gw = (): GW | null => {
    const os = osSession();
    if (os) return { kind: "os", ...os };
    if (bsv.ctx) return { kind: "yours", ctx: bsv.ctx };
    const s = embeddedSession();
    return s ? { kind: "embedded", ...s } : null;
  };

  const embAddr = embeddedSession()?.address ?? null;
  const listedByOrigin = useMemo(() => {
    const m = new Map<string, MarketListing>();
    for (const l of listings) m.set(l.origin, l);
    for (const [k, v] of Object.entries(extra)) if (!m.has(k)) m.set(k, v);
    for (const r of recent) if (!m.has(r.origin)) m.set(r.origin, r);
    return m;
  }, [listings, extra, recent]);

  // Deep links (path or hash) can point at sold history — fetch it on demand.
  const [probed, setProbed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!detail || loading || listedByOrigin.has(detail) || probed[detail]) return;
    let live = true;
    void fetchListing(detail).then((row) => {
      if (!live) return;
      if (row) setExtra((e) => ({ ...e, [detail]: row }));
      setProbed((p) => ({ ...p, [detail]: true }));
    });
    return () => {
      live = false;
    };
  }, [detail, loading, listedByOrigin, probed]);

  const feeFor = (price: number) => Math.max(1, Math.floor((price * MARKET_FEE_BPS) / 10000));

  /** Adopt a delivered escrow purchase into the local collection. */
  const trackDelivery = async (origin: string) => {
    const sold = recent.find((r) => r.origin === origin);
    const pending = save.pendingAcquisition.find((a) => a.origin === origin);
    const meta = sold ?? pending;
    if (!meta || !sold?.transfer_txid) return say("No delivery on-chain yet — check back after the operator transfers it");
    const myAddr = embeddedSession()?.address ?? save.payoutAddress;
    if (!myAddr) return say("Set a payout address (BSV tab) so delivery can find you");
    setBusy("track");
    try {
      const tx = await fetchTxDetails(sold.transfer_txid);
      const hit = (tx.vout ?? []).find(
        (o) => Math.round((o.value ?? -1) * 1e8) === 1 && (o.scriptPubKey?.addresses ?? []).includes(myAddr)
      );
      if (!hit) {
        say("Delivery exists but not to your address — contact the operator with your buy txid");
        setBusy(null);
        return;
      }
      const sp = speciesByName(meta.species);
      const vout = hit.n ?? 0;
      const arrived: Pet = {
        uid: `bought-${origin.slice(0, 12)}`,
        speciesId: sp.id,
        nickname: meta.nickname.slice(0, 16),
        level: Math.max(1, Math.min(30, meta.level || 1)),
        xp: 0, hp: 1, happy: 70, energy: 100, wins: 0, pulls: 0,
        nft: {
          origin, txid: sold.transfer_txid, vout,
          scriptHex: p2pkhScript(myAddr).toHex(), mintedAt: Date.now(), mintAddress: myAddr,
        },
      };
      arrived.hp = maxHp(arrived);
      const ledger = await appendLedger(save.ledger, "market_claim", arrived.uid, `${meta.nickname} delivered ${sold.transfer_txid.slice(0, 12)}:${vout}`);
      setSave((s) => ({
        ...s,
        ledger,
        pets: [...s.pets, arrived],
        activeUid: s.activeUid ?? arrived.uid,
        pendingAcquisition: s.pendingAcquisition.filter((a) => a.origin !== origin),
      }));
      say(`📦 ${meta.nickname} delivered — welcome to the collection!`);
      buzz(50);
    } catch (e) {
      say(`Track failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(null);
    }
  };

  const doList = async (pet: Pet) => {
    if (!tw) return say("Sign in with Twetch to sell");
    if (!pet.nft) return;
    const price = Math.floor(Number(prices[pet.uid] ?? "50000"));
    if (!Number.isInteger(price) || price < 1) return say("Enter a price in sats (min 1)");
    const escrow = save.feeAddress;
    const sp = speciesOf(pet);
    const os = osSession();
    const s = embeddedSession();
    const w = os ? { kind: "os" as const, ...os } : s ? { kind: "embedded" as const, ...s } : null;
    setBusy("list");
    const postAtomic = async () => {
      const nft = pet.nft;
      if (!w || !nft || (w.kind === "embedded" && !nft.scriptHex)) {
        throw new Error("atomic needs a wallet (OS runner or built-in)");
      }
      // preflight 1: dead mint (rejected tx) — clear it instead of listing a corpse
      try {
        const st = await arcStatus(nft.txid);
        if (st.txStatus === "REJECTED") {
          setSave((prev) => ({
            ...prev,
            pets: prev.pets.map((x) => (x.uid === pet.uid ? { ...x, nft: undefined } : x)),
          }));
          await recordHere("mint_failed", pet.uid, `rejected ${nft.txid.slice(0, 12)} — cleared before list`);
          throw new Error("That mint never confirmed (double-spend). Record cleared — tap Mint again first.");
        }
      } catch (e) {
        if (e instanceof Error && /cleared before list/.test(e.message)) throw e;
        // status unknown — proceed, server is authoritative
      }
      // preflight 2: this NFT was minted into a different wallet
      if (nft.mintAddress && nft.mintAddress !== w.address) {
        throw new Error(`This NFT lives in another wallet (minted to ${short(nft.mintAddress, 6)}). Unlock that wallet to list it.`);
      }
      // atomic: pre-sign only — NFT stays in your wallet until bought
      const offer = await gwAtomicList(w, pet, price);
      await postListing({
        origin: nft.origin, nickname: pet.nickname, species: sp.name, emoji: sp.emoji,
        rarity: sp.rarity, level: pet.level, priceSats: price, seller: offer.seller,
        sellerHandle: tw.handle, escrowTxid: "", escrowAddress: "",
        sellerUnlock: offer.unlockHex, payScript: offer.payScriptHex,
      });
      await recordHere("market_list", pet.uid, `atomic ${price}sats, stays in wallet`);
      say(offer.unconfirmedParent
        ? `⚡ Listed! Mint still confirming — sale completes once it mines.`
        : `⚡ Listed atomic for ${price.toLocaleString()} sats — no escrow needed!`);
    };
    try {
      if (s && pet.nft.scriptHex) {
        // local move history: our flows record every move we make. An escrow
        // move means the origin outpoint is spent — atomic can't use it.
        const moved = save.ledger.find(
          (e) => e.petUid === pet.uid && (e.action === "transfer" || (e.action === "market_list" && e.detail.includes("escrow")))
        );
        if (moved) {
          say("This NFT already moved out (transfer/escrow — see ledger). Atomic needs it in your wallet.");
          setBusy(null);
          return;
        }
        try {
          await postAtomic();
        } catch (e) {
          // indexer lag between our check and the server's: one retry after a beat
          const code = (e as Error & { code?: string }).code;
          if (code === "PARENT_MISSING" || code === "ALREADY_SOLD") throw e;
          const msg = e instanceof Error ? e.message : "error";
          if (/not found on-chain|failed to fetch|network/i.test(msg)) {
            say("Chain index lagging — retrying once…");
            await new Promise((r) => window.setTimeout(r, 8000));
            await postAtomic();
          } else {
            throw e;
          }
        }
      } else {
        // legacy escrow path (Yours wallets): NFT must sit with the operator first
        const m = manual[pet.uid];
        if (!m?.escrowTxid || !m?.seller) {
          say("Transfer the NFT to escrow in your wallet first, then paste the txid + seller address");
          setBusy(null);
          return;
        }
        const escrowTxid = m.escrowTxid.trim();
        const seller = m.seller.trim();
        await postListing({
          origin: pet.nft.origin, nickname: pet.nickname, species: sp.name, emoji: sp.emoji,
          rarity: sp.rarity, level: pet.level, priceSats: price, seller,
          sellerHandle: tw.handle, escrowTxid, escrowAddress: escrow,
        });
        setSave((prev) => ({
          ...prev,
          pets: prev.pets.map((x) => x.uid === pet.uid && x.nft ? { ...x, nft: { ...x.nft, txid: escrowTxid } } : x),
        }));
        await recordHere("market_list", pet.uid, `${price}sats escrow ${escrowTxid.slice(0, 12)}`);
        say(`Listed for ${price.toLocaleString()} sats!`);
      }
      buzz(40);
      void refresh();
    } catch (e) {
      say(`List failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(null);
    }
  };

  const doBuy = async (l: MarketListing) => {
    if (!tw) return say("Sign in with Twetch to buy");
    const atomic = !!l.seller_unlock;
    if (atomic) {
      const os = osSession();
      const s = embeddedSession();
      const w = os ? { kind: "os" as const, ...os } : s ? { kind: "embedded" as const, ...s } : null;
      if (!w) return say("Atomic buys need a wallet (OS runner or built-in, BSV tab)");
      setBusy("buy");
      try {
        const { txid, feeSats, nftVout, nftScriptHex } = await gwAtomicBuy(
          w,
          { origin: l.origin, price_sats: l.price_sats, seller_unlock: l.seller_unlock!, pay_script: l.pay_script! },
          save.feeAddress
        );
        await markBought(l.origin, txid, tw.handle);
        const sp = speciesByName(l.species);
        const bought: Pet = {
          uid: `bought-${l.origin.slice(0, 12)}`,
          speciesId: sp.id,
          nickname: l.nickname.slice(0, 16),
          level: Math.max(1, Math.min(30, l.level || 1)),
          xp: 0,
          hp: 1,
          happy: 70,
          energy: 100,
          wins: 0,
          pulls: 0,
          nft: { origin: l.origin, txid, vout: nftVout, scriptHex: nftScriptHex, mintedAt: Date.now(), mintAddress: w.address },
        };
        bought.hp = maxHp(bought);
        const ledger = await appendLedger(save.ledger, "market_buy", bought.uid, `atomic ${l.nickname} ${l.price_sats}sats + ${feeSats} fee ${txid.slice(0, 12)}`);
        setSave((prev) => ({
          ...prev,
          ledger,
          pets: [...prev.pets, bought],
          activeUid: prev.activeUid ?? bought.uid,
        }));
        say(`⚡ Swapped! ${l.nickname} joined your collection. ${short(txid)}`);
        closeDetail();
        watchTxStatus(txid, (st) => {
          if (st === "REJECTED") {
            setSave((prev) => ({ ...prev, pets: prev.pets.filter((p) => p.uid !== bought.uid) }));
            void recordHere("tx_failed", "-", `swap ${txid.slice(0, 12)} rejected — pet removed`);
            say("Swap tx rejected — nothing moved. Check funds and retry.");
          }
        });
        buzz(50);
        void refresh();
      } catch (e) {
        say(`Swap failed: ${e instanceof Error ? e.message : "declined"}`);
      } finally {
        setBusy(null);
      }
      return;
    }
    const w = gw();
    if (!w) return say("Connect Yours or unlock the built-in wallet (BSV tab)");
    setBusy("buy");
    try {
      const { txid, feeSats } = await gwMarketBuy(w, l.seller, l.price_sats, save.feeAddress, l.origin);
      await markBought(l.origin, txid, tw.handle);
      const ledger = await appendLedger(save.ledger, "market_buy", "-", `${l.nickname} ${l.price_sats}sats + ${feeSats} fee ${txid.slice(0, 12)}`);
      setSave((s) => ({
        ...s,
        ledger,
        pendingAcquisition: [
          ...s.pendingAcquisition.filter((a) => a.origin !== l.origin),
          {
            origin: l.origin, nickname: l.nickname, species: l.species, emoji: l.emoji,
            rarity: l.rarity, level: l.level, buyTxid: txid, ts: Date.now(),
          },
        ],
      }));
      say(`Bought ${l.nickname}! Track delivery below once the operator transfers it.`);
      watchTxStatus(txid, (st) => {
        if (st === "REJECTED") {
          void recordHere("tx_failed", "-", `buy ${txid.slice(0, 12)} rejected`);
          say("Payment tx rejected — nothing moved. Retry it.");
        }
      });
      buzz(50);
      void refresh();
    } catch (e) {
      say(`Buy failed: ${e instanceof Error ? e.message : "declined"}`);
    } finally {
      setBusy(null);
    }
  };

  const doSettle = async (l: MarketListing) => {
    const txid = (settleTx[l.origin] ?? "").trim();
    if (!txid) return say("Paste the escrow→buyer transfer txid");
    setBusy("settle");
    try {
      await markSettled(l.origin, txid);
      await recordHere("market_settle", "-", `${l.nickname} -> ${txid.slice(0, 12)}`);
      say("Settled — NFT delivered 🎉");
      void refresh();
    } catch (e) {
      say(`Settle failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(null);
    }
  };

  const doCancel = async (l: MarketListing) => {
    const seller = embAddr ?? window.prompt("Seller address (must match listing)", l.seller) ?? "";
    if (!seller) return;
    setBusy("cancel");
    try {
      await cancelListing(l.origin, seller.trim());
      await recordHere("market_cancel", "-", l.nickname);
      say("Listing cancelled. NFT stays in escrow — contact the operator with your escrow txid to reclaim.");
      void refresh();
    } catch (e) {
      say(`Cancel failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(null);
    }
  };

  const sellable = save.pets.filter((p) => p.nft && !listedByOrigin.has(p.nft.origin));

  return (
    <div className="bsvwrap">
      <section className="card">
        <h2>🛒 NFT Market</h2>
        <p className="muted">
          ⚡ Atomic swaps settle in one tx — NFT and payment move together, no escrow.
          🔒 Escrow sales (Yours mints): seller locks the NFT with the operator first, operator delivers after payment.
          Every step carries a txid. {tw ? <>Trading as <b>@{tw.handle}</b>.</> : <><button className="linkbtn" onClick={onLogin}>Sign in with Twetch</button> to trade.</>}
        </p>
        <p className="muted">Escrow: <code>{short(save.feeAddress, 8)}</code></p>
        <div className="row2">
          <button onClick={() => void refresh()} disabled={loading}>{loading ? "Loading…" : "↻ Refresh"}</button>
          <span className="muted">{listings.length} open</span>
        </div>
      </section>

      {listings.map((l) => {
        const mine = embAddr !== null && l.seller === embAddr;
        const total = l.price_sats + feeFor(l.price_sats);
        const isAtomic = !!l.seller_unlock;
        return (
          <section className="card" key={l.origin}>
            <div className="versus click" style={{ gridTemplateColumns: "1fr auto" }} onClick={() => openDetail(l.origin)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") openDetail(l.origin); }}>
              <div className="fighter"><span>{l.emoji || "🎴"}</span><b>{l.nickname}</b>
                <small>{l.species} · {l.rarity} · Lv {l.level} · tap for details ›</small>
              </div>
              <span className={l.status === "paid" ? "pill" : "pill ok"} style={{ borderColor: l.status === "paid" ? "#facc15" : undefined }}>
                {l.status === "paid" ? "paid — awaiting delivery" : `${l.price_sats.toLocaleString()} sats`}
              </span>
            </div>
            <p className="muted">{isAtomic ? "⚡ atomic swap — settles in one tx, no escrow" : "🔒 escrow sale — operator delivers"} ·
              seller {l.seller_handle ? `@${l.seller_handle}` : short(l.seller, 6)} ·{" "}
              {!isAtomic && <>escrow <a href={wocTxUrl(l.escrow_txid)} target="_blank" rel="noreferrer">{short(l.escrow_txid)}</a> · </>}
              <a href={onesatUrl(l.origin)} target="_blank" rel="noreferrer">1sat</a></p>
            {l.status === "active" && !mine && (
              <>
                <button className="primary" disabled={busy === "buy"} onClick={() => void doBuy(l)}>
                  {busy === "buy" ? "Swapping…" : isAtomic ? `⚡ Swap — ${total.toLocaleString()} sats (instant)` : `Buy — ${total.toLocaleString()} sats (incl. fee)`}
                </button>
              </>
            )}
            {l.status === "paid" && (
              <>
                <p className="muted">✅ paid by {l.buyer_handle ? `@${l.buyer_handle}` : "buyer"} · <a href={wocTxUrl(l.buy_txid!)} target="_blank" rel="noreferrer">{short(l.buy_txid!)}</a></p>
                <label className="fld"><span>Operator: escrow→buyer transfer txid</span>
                  <input value={settleTx[l.origin] ?? ""} placeholder="paste txid after delivering" onChange={(e) => setSettleTx((m) => ({ ...m, [l.origin]: e.target.value }))} />
                </label>
                <button disabled={busy === "settle"} onClick={() => void doSettle(l)}>{busy === "settle" ? "…" : "Confirm delivery"}</button>
              </>
            )}
            {l.status === "active" && (
              <button className="linkbtn" onClick={() => void doCancel(l)}>Cancel listing</button>
            )}
          </section>
        );
      })}

      <AnimatePresence>
        {detail && listedByOrigin.get(detail) && (
          <ListingDetail
            l={listedByOrigin.get(detail)!}
            mine={embAddr !== null && listedByOrigin.get(detail)!.seller === embAddr}
            busy={busy}
            onClose={closeDetail}
            onBuy={() => void doBuy(listedByOrigin.get(detail)!)}
            onSettle={() => void doSettle(listedByOrigin.get(detail)!)}
            onCancel={() => { void doCancel(listedByOrigin.get(detail)!); closeDetail(); }}
            settleTx={settleTx[detail] ?? ""}
            setSettleTx={(v) => setSettleTx((m) => ({ ...m, [detail]: v }))}
            say={say}
          />
        )}
        {detail && !loading && !listedByOrigin.get(detail) && probed[detail] && (
          <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeDetail}>
            <div className="reveal" onClick={(e) => e.stopPropagation()}>
              <p>This listing is no longer available (sold or cancelled).</p>
              <button className="primary" onClick={closeDetail}>Back to market</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="card">
        <h2>📦 Your deliveries</h2>
        {save.pendingAcquisition.length === 0
          ? <p className="muted">Nothing in transit. Escrow buys appear here until you track their delivery into your collection. Atomic swaps land instantly.</p>
          : save.pendingAcquisition.map((a) => {
            const sold = recent.find((r) => r.origin === a.origin);
            return (
              <div key={a.origin} className="brow">
                <span>{a.emoji} {a.nickname} {sold?.transfer_txid ? "· delivered ✅" : "· awaiting operator"}</span>
                <button
                  className="linkbtn"
                  disabled={busy === "track" || !sold?.transfer_txid}
                  onClick={() => void trackDelivery(a.origin)}
                >{busy === "track" ? "…" : sold?.transfer_txid ? "Track into collection" : "Waiting…"}</button>
              </div>
            );
          })}
      </section>

      <section className="card">
        <h2>🏷️ Sell yours</h2>
        {sellable.length === 0
          ? <p className="muted">No unlisted NFTs — mint a pet first 🎴</p>
          : sellable.map((p) => {
            const sp = speciesOf(p);
            const auto = !!(embeddedSession() && p.nft?.scriptHex);
            const m = manual[p.uid] ?? { escrowTxid: "", seller: "" };
            return (
              <div key={p.uid} className="sellrow">
                <div className="fighter"><span>{sp.emoji}</span><b>{p.nickname}</b><small>Lv {p.level} · {sp.rarity}</small></div>
                <label className="fld"><span>Price (sats, +{MARKET_FEE_BPS / 100}% fee on buy)</span>
                  <input type="number" min={1} value={prices[p.uid] ?? "50000"} onChange={(e) => setPrices((v) => ({ ...v, [p.uid]: e.target.value }))} />
                </label>
                {!auto && (
                  <>
                    <p className="muted">Yours mints sell via escrow: transfer the NFT to <code>{short(save.feeAddress, 8)}</code> in your wallet first.</p>
                    <label className="fld"><span>Escrow transfer txid</span>
                      <input value={m.escrowTxid} placeholder="txid…" onChange={(e) => setManual((v) => ({ ...v, [p.uid]: { ...m, escrowTxid: e.target.value } }))} />
                    </label>
                    <label className="fld"><span>Your seller (receiving) address</span>
                      <input value={m.seller} placeholder="1..." onChange={(e) => setManual((v) => ({ ...v, [p.uid]: { ...m, seller: e.target.value } }))} />
                    </label>
                  </>
                )}
                <button className="primary" disabled={busy === "list"} onClick={() => void doList(p)}>
                  {busy === "list" ? "Listing…" : auto ? "⚡ List atomic (stays in wallet)" : "List via escrow"}
                </button>
              </div>
            );
          })}
      </section>
    </div>
  );
}

function BsvTab({ busy, setBusy, say, verifyMsg, setVerifyMsg, tw, onLogin, onLogout }: {
  busy: string | null; setBusy(s: string | null): void; say(t: string): void;
  verifyMsg: string | null; setVerifyMsg(s: string | null): void;
  tw: TwetchSession | null; onLogin(): void; onLogout(): void;
}) {
  const [save, setSave] = useSave();
  const bsv = useBsv();
  const season = seasonKey();
  const [winnerUid, setWinnerUid] = useState(save.activeUid ?? save.pets[0]?.uid ?? "");
  const [payAddr, setPayAddr] = useState(save.payoutAddress);
  const [manualTx, setManualTx] = useState("");
  const [amount, setAmount] = useState<number | null>(null);

  // Reconcile: clear NFT records whose mint tx died on-chain (e.g. lost a
  // double-spend race) so the pet can be re-minted. Funds never moved.
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current) return;
    reconciled.current = true;
    const minted = save.pets.filter((p) => p.nft);
    if (minted.length === 0) return;
    void (async () => {
      for (const p of minted) {
        let st: { txStatus: string };
        try {
          st = await arcStatus(p.nft!.txid);
        } catch {
          continue;
        }
        if (st.txStatus === "REJECTED") {
          const ledger = await appendLedger(save.ledger, "mint_failed", p.uid, `rejected ${p.nft!.txid.slice(0, 12)} — not charged`);
          setSave((s) => ({
            ...s,
            ledger,
            pets: s.pets.map((x) => (x.uid === p.uid ? { ...x, nft: undefined } : x)),
          }));
          say(`${p.nickname}'s mint didn't confirm — cleared. Tap Mint again, you weren't charged.`);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seasonEntries = save.entries.filter((e) => e.season === season);
  const potSats = potTotal(seasonEntries);
  const seasonPayouts = save.payouts.filter((p) => p.season === season);
  const paidOut = seasonPayouts.reduce((a, p) => a + p.amountSats, 0);
  const lastAnchor = save.anchors[save.anchors.length - 1];
  const anchorIdx = lastAnchor ? save.ledger.findIndex((e) => e.hash === lastAnchor.tipHash) : save.ledger.length - 1;
  const unanchored = anchorIdx >= 0 ? save.ledger.length - 1 - anchorIdx : save.ledger.length;
  const tip = save.ledger.length ? save.ledger[save.ledger.length - 1]!.hash : "GENESIS";
  const active = save.pets.find((p) => p.uid === save.activeUid) ?? save.pets[0];

  const recordHere = async (action: string, petUid: string, detail: string) => {
    const next = await appendLedger(save.ledger, action, petUid, detail);
    setSave((s) => ({ ...s, ledger: next }));
  };

  const board = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of save.ledger) {
      if (e.action !== "battle_win") continue;
      if (seasonKey(new Date(e.ts)) !== season) continue;
      m.set(e.petUid, (m.get(e.petUid) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [save.ledger, season]);

  const nameOf = (uid: string) => save.pets.find((p) => p.uid === uid)?.nickname ?? short(uid, 6);
  const handleOf = (uid: string) => {
    const es = save.entries.filter((e) => e.petUid === uid && e.handle);
    return es.length ? es[es.length - 1]!.handle! : null;
  };
  const payoutDefault = Math.max(0, Math.floor((potSats - paidOut) * (1 - POT_FEE_BPS / 10000)));

  const gw = (): GW | null => {
    const os = osSession();
    if (os) return { kind: "os", ...os };
    if (bsv.ctx) return { kind: "yours", ctx: bsv.ctx };
    const s = embeddedSession();
    return s ? { kind: "embedded", ...s } : null;
  };

  const onAnchor = async () => {
    const w = gw();
    if (!w) return say("Connect Yours or unlock the built-in wallet below");
    setBusy("anchor");
    try {
      const { txid, feeSats: f } = await gwAnchor(w, save.potAddress, save.feeAddress, tip);
      const ledger = await appendLedger(save.ledger, "anchor", active?.uid ?? "-", `tip ${tip.slice(0, 12)} -> ${txid.slice(0, 12)} fee ${f}sats`);
      setSave((s) => ({ ...s, ledger, anchors: [...s.anchors, { tipHash: tip, txid, ts: Date.now() }] }));
      say(`⛓️ Anchored! ${short(txid)}`);
    } catch (e) {
      say(`Anchor failed: ${e instanceof Error ? e.message : "declined"}`);
    } finally {
      setBusy(null);
    }
  };

  const onEnter = async () => {
    if (!active) return;
    if (!tw) return say("Sign in with Twetch first — cup entries are identity-linked");
    const w = gw();
    if (!w) return say("Connect Yours or unlock the built-in wallet below");
    setBusy("enter");
    try {
      const { txid, entrySats: es, feeSats: f } = await gwEnter(w, save.potAddress, save.feeAddress, active.uid, tip);
      const ledger = await appendLedger(save.ledger, "pot_entry", active.uid, `@${tw.handle} ${es} sats + ${f} sats fee ${txid.slice(0, 12)}`);
      setSave((s) => ({
        ...s,
        ledger,
        entries: [...s.entries, { txid, petUid: active.uid, nickname: active.nickname, season, ts: Date.now(), anchorHash: tip, sats: es, twsub: tw.sub, handle: tw.handle }],
      }));
      say(`🎟️ Entered as @${tw.handle}! ${short(txid)}`);
      buzz(40);
    } catch (e) {
      say(`Entry failed: ${e instanceof Error ? e.message : "declined"}`);
    } finally {
      setBusy(null);
    }
  };

  const onPayout = async () => {
    setBusy("payout");
    try {
      let txid = manualTx.trim();
      const amt = amount ?? payoutDefault;
      if (!txid) {
        const w = gw();
        if (!w) { say("Connect operator wallet or paste a txid"); setBusy(null); return; }
        if (!payAddr) { say("Winner BSV address required"); setBusy(null); return; }
        txid = await gwPayout(w, payAddr, amt, season, winnerUid);
      }
      const w = save.pets.find((p) => p.uid === winnerUid);
      const ledger = await appendLedger(save.ledger, "payout", winnerUid, `${amt}sats -> ${txid.slice(0, 12)}`);
      setSave((s) => ({
        ...s,
        ledger,
        payouts: [...s.payouts, { season, winnerUid, winnerNickname: w?.nickname ?? winnerUid, address: payAddr || "(recorded)", txid, amountSats: amt, ts: Date.now() }],
      }));
      say(`💸 Paid! ${short(txid)}`);
      setManualTx("");
    } catch (e) {
      say(`Payout failed: ${e instanceof Error ? e.message : "declined"}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bsvwrap">
      <section className="card">
        <h2>𝕋 Twetch identity</h2>
        {tw ? (
          <div className="wrow">
            <span className="twchip">
              {tw.avatar && <img src={tw.avatar} alt="" />}
              <b>@{tw.handle}</b><small>id:{tw.sub}</small>
            </span>
            <button onClick={onLogout}>Sign out</button>
          </div>
        ) : (
          <>
            <p className="muted">Sign in to track your pets, link cup entries to your name, and appear on the leaderboard.</p>
            <button className="primary" onClick={onLogin}>Sign in with Twetch</button>
          </>
        )}
      </section>
      <section className="card">
        <h2>👛 Wallet</h2>
        <WalletCard say={say} />
        <p className="muted">Fixed fees: {MINT_FEE_SATS} sat mint (+1 sat inscription) · {PULL_SATS} sat pull · {FOOD_REFILL_SATS} sat refill · {ACTION_FEE_SATS} sat action fee for cup, anchor and paid PvP · pot fee {POT_FEE_BPS / 100}%. Network fees are additional. Paid PvP dollar stakes and market prices + {MARKET_FEE_BPS / 100}% fees are unchanged.</p>
        <label className="fld"><span>Your BSV payout address (winnings go here)</span>
          <input value={payAddr} placeholder="1..." onChange={(e) => { setPayAddr(e.target.value); setSave((s) => ({ ...s, payoutAddress: e.target.value })); }} />
        </label>
        <label className="fld"><span>Pot address (operator)</span>
          <input value={save.potAddress} placeholder="1..." onChange={(e) => setSave((s) => ({ ...s, potAddress: e.target.value }))} />
        </label>
        <label className="fld"><span>Fee address (operator revenue)</span>
          <input value={save.feeAddress} placeholder="1..." onChange={(e) => setSave((s) => ({ ...s, feeAddress: e.target.value }))} />
        </label>
      </section>

      <section className="card">
        <h2>⛓️ Action ledger</h2>
        <p className="muted">{save.ledger.length} actions · tip <code>{short(tip, 8)}</code> · {unanchored} unanchored</p>
        <div className="row2">
          <button disabled={busy === "anchor" || !save.ledger.length} onClick={() => void onAnchor()}>
            {busy === "anchor" ? "Anchoring…" : `Anchor tip (1 sat tip + ${ACTION_FEE_SATS} sat fee)`}
          </button>
          <button onClick={() => void verifyLedger(save.ledger).then((r) => setVerifyMsg(r.ok ? `✅ chain valid (${save.ledger.length})` : `❌ broken at seq ${r.badSeq}`))}>
            Verify chain
          </button>
        </div>
        {verifyMsg && <p className="muted">{verifyMsg}</p>}
        {lastAnchor && <p className="muted">Last anchor: <a href={wocTxUrl(lastAnchor.txid)} target="_blank" rel="noreferrer">{short(lastAnchor.txid)}</a></p>}
        <div className="log">
          {save.ledger.slice(-10).reverse().map((e) => (
            <div key={e.seq} className="logrow"><code>#{e.seq}</code> <b>{e.action}</b> <span>{e.detail.slice(0, 40)}</span> <span>{short(e.hash, 6)}</span></div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>🏆 Battle Cup · {season}</h2>
        <p className="muted">Pot: <b>{potSats.toLocaleString()} sats</b> ({seasonEntries.length} entries) · fee {POT_FEE_BPS / 100}% · <a href={wocTxUrl(save.potAddress)} target="_blank" rel="noreferrer">pot address</a></p>
        <button className="primary big" disabled={busy === "enter"} onClick={() => void onEnter()}>
          {busy === "enter" ? "Paying…" : `🎟️ Enter cup — ${CUP_ENTRY_SATS} sat + ${ACTION_FEE_SATS} sat fee`}
        </button>
        <p className="muted">Pays {CUP_ENTRY_SATS} sat to pot + {ACTION_FEE_SATS} sat fee, one signature. {tw ? `Entering as @${tw.handle}.` : "Requires Twetch sign-in."}</p>
        {seasonEntries.slice(-5).reverse().map((e) => (
          <p key={e.txid} className="muted">🎟️ {e.nickname}{e.handle ? ` (@${e.handle})` : ""} · <a href={wocTxUrl(e.txid)} target="_blank" rel="noreferrer">{short(e.txid)}</a></p>
        ))}
        <h3>Leaderboard (season wins)</h3>
        {board.length === 0 ? <p className="muted">No wins yet — battle, then enter the cup.</p> : (
          <div className="board">{board.map(([uid, w], i) => {
            const h = handleOf(uid);
            return <div key={uid} className="brow"><span>{i + 1}. {nameOf(uid)}{h ? ` (@${h})` : ""}</span><b>{w}W</b></div>;
          })}</div>
        )}
        <h3>Settle & payout</h3>
        <label className="fld"><span>Winner</span>
          <select value={winnerUid} onChange={(e) => setWinnerUid(e.target.value)}>
            {save.pets.map((p) => <option key={p.uid} value={p.uid}>{p.nickname} (Lv {p.level})</option>)}
          </select>
        </label>
        <label className="fld"><span>Winner address</span>
          <input value={payAddr} placeholder="1..." onChange={(e) => { setPayAddr(e.target.value); setSave((s) => ({ ...s, payoutAddress: e.target.value })); }} />
        </label>
        <label className="fld"><span>Amount (sats, pot minus {POT_FEE_BPS / 100}% fee = {payoutDefault.toLocaleString()})</span>
          <input type="number" value={amount ?? payoutDefault} onChange={(e) => setAmount(Number(e.target.value))} />
        </label>
        <label className="fld"><span>Manual payout txid (optional — skip wallet pay)</span>
          <input value={manualTx} placeholder="paste txid if paid outside" onChange={(e) => setManualTx(e.target.value)} />
        </label>
        <button className="primary" disabled={busy === "payout"} onClick={() => void onPayout()}>
          {busy === "payout" ? "Paying…" : "💸 Pay winner in BSV"}
        </button>
        {seasonPayouts.map((p) => (
          <p key={p.txid + p.ts} className="muted">💸 {p.amountSats.toLocaleString()} sats → {p.winnerNickname} · <a href={wocTxUrl(p.txid)} target="_blank" rel="noreferrer">{short(p.txid)}</a></p>
        ))}
        {paidOut > 0 && <p className="muted">Paid out this season: {paidOut.toLocaleString()} sats</p>}
      </section>

      <section className="card">
        <h2>🎴 Your NFTs</h2>
        {save.pets.filter((p) => p.nft).length === 0
          ? <p className="muted">None yet — mint from Home or Pets ({MINT_FEE_SATS} sat fee). Each mint is a real 1Sat Ordinal you own.</p>
          : save.pets.filter((p) => p.nft).map((p) => (
            <div key={p.uid}>
              <p className="muted">🎴 {p.nickname} · <a href={onesatUrl(p.nft!.origin)} target="_blank" rel="noreferrer">1sat</a> · <a href={wocTxUrl(p.nft!.txid)} target="_blank" rel="noreferrer">{short(p.nft!.txid)}</a></p>
              {p.nft!.scriptHex && <TransferRow pet={p} say={say} setBusy={setBusy} busy={busy === "transfer"} />}
            </div>
          ))}
      </section>
    </div>
  );
}

function TransferRow({ pet, say, setBusy, busy }: {
  pet: Pet; say(t: string): void; setBusy(s: string | null): void; busy: boolean;
}) {
  const [save, setSave] = useSave();
  const [to, setTo] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) return <button className="linkbtn" onClick={() => setOpen(true)}>Send NFT…</button>;
  return (
    <div>
      <label className="fld"><span>Recipient BSV address</span>
        <input value={to} placeholder="1..." onChange={(e) => setTo(e.target.value)} />
      </label>
      <div className="row2">
        <button disabled={busy || !/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(to.trim())}           onClick={() => void (async () => {
          const os = osSession();
          const s = embeddedSession();
          const w = os ? { kind: "os" as const, ...os } : s ? { kind: "embedded" as const, ...s } : null;
          if (!w) return say("Unlock a wallet first (OS runner or built-in)");
          setBusy("transfer");
          try {
            const r = await gwTransferNft(w, pet, to.trim());
            const ledger = await appendLedger(save.ledger, "transfer", pet.uid, `-> ${to.trim().slice(0, 12)} ${r.txid.slice(0, 12)}`);
            setSave((prev) => ({
              ...prev, ledger,
              pets: prev.pets.map((x) => x.uid === pet.uid && x.nft ? { ...x, nft: { ...x.nft, txid: r.txid, vout: r.vout, scriptHex: r.scriptHex } } : x),
            }));
            say(`Sent! ${short(r.txid)}`);
            setOpen(false);
          } catch (e) {
            say(`Transfer failed: ${e instanceof Error ? e.message : "declined"}`);
          } finally {
            setBusy(null);
          }
        })()}>{busy ? "Sending…" : "Send (miner fee only)"}</button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <p className="muted">Yours-minted NFTs transfer inside the Yours app.</p>
    </div>
  );
}

async function sharePet(p: Pet) {
  const sp = speciesOf(p);
  const st = stats(p);
  const evo = p.evolvedFrom && p.evolvedFrom.length > 0 ? ` (evolved: ${p.evolvedFrom.join("→")})` : "";
  const text = `🐾 My ${p.nickname} (${sp.name}, ${sp.rarity} Lv${p.level})${evo} — ATK ${st.atk} DEF ${st.def} SPD ${st.spd} ${sp.emoji} #PocketPets`;
  try {
    const url = drawPetCard(p);
    const a = document.createElement("a");
    a.href = url; a.download = `${p.nickname}-pocketpet.png`; a.click();
  } catch { /* ignore */ }
  try {
    if (navigator.share) await navigator.share({ text });
    else await navigator.clipboard.writeText(text);
  } catch { /* ignore */ }
}
