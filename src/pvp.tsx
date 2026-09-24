// PvP lobby + async matchmaking client and panel.
// Battles resolve authoritatively on the worker (seeded, deterministic);
// this tab handles challenges, accepts, results, and local rewards.
import { useCallback, useEffect, useMemo, useState } from "react";
import { PROXY } from "./embedded.ts";
import {
  EVOLVE_WINS, evolve, grantXp, maxHp, speciesByName, speciesOf, stats,
  type Pet, type Rarity,
} from "./pets.ts";
import { drawPetCard } from "./bsv.ts";
import { EpicBattle } from "./EpicBattle.tsx";
import { useSave, buzz } from "./store.ts";
import { appendLedger, getBsvUsd, usdToSats } from "./chain.ts";
import { gwStake, type GW } from "./gw.ts";
import { embeddedSession } from "./embwallet.tsx";
import { osSession } from "./oswallet.ts";
import { useBsv } from "./bsv.ts";
import type { TwetchSession } from "./twetch.ts";
import { routePath } from "./routes.ts";

export const STAKE_TIERS = [0, 0.05, 0.1, 0.25] as const;
export type StakeTier = (typeof STAKE_TIERS)[number];
export const HOUSE_CUT_BPS = 1000;

export const tierLabel = (t: number) => (t === 0 ? "Free" : `$${t.toFixed(2)}`);

export interface PvpFighter {
  sub?: string;
  handle: string;
  nickname: string;
  species: string;
  level: number;
  wins?: number;
}

export interface PvpChallenge {
  id: string;
  season: string;
  challenger: PvpFighter & { sub: string; wins: number };
  status: "open" | "matched" | "cancelled";
  winner: "challenger" | "opponent" | null;
  winner_sub: string | null;
  winner_handle: string | null;
  winner_nickname: string | null;
  rounds: number | null;
  log: Array<{ actor: string; text: string; dmg: number; aHp: number; bHp: number }> | null;
  opponent?: PvpFighter | null;
  stake_usd: number;
  stakes_paid: { challenger: boolean; acceptor: boolean };
  pot_sats: number;
  claim_address: string | null;
  payout_txid: string | null;
  payout_amount_sats: number;
  created_at: number;
  updated_at: number;
}

export interface PvpResult {
  ok: boolean;
  id: string;
  winner: "challenger" | "opponent";
  winner_nickname: string;
  rounds: number;
  log: PvpChallenge["log"];
  challenger: PvpFighter;
  opponent: PvpFighter;
  stake_usd: number;
  pot_sats: number;
  winner_payout_sats: number;
}

async function pvpReq<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${PROXY}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(String(j.error ?? `request failed (${res.status})`));
  return j as T;
}

export const postChallenge = (input: {
  sub: string; handle: string; petUid: string; nickname: string;
  speciesId: string; level: number; happy: number; wins: number;
  stakeUsd: number; stakeTxid?: string; stakeSats?: number;
}) => pvpReq<{ ok: boolean; id: string }>("/v1/pvp/challenge", input);

export const fetchOpen = () => pvpReq<{ challenges: PvpChallenge[] }>("/v1/pvp/open");

export const acceptFight = (input: {
  id: string; sub: string; handle: string; petUid: string; nickname: string;
  speciesId: string; level: number; happy: number;
  stakeTxid?: string; stakeSats?: number;
}) => pvpReq<PvpResult>("/v1/pvp/accept", input);

export const cancelFight = (id: string, sub: string) =>
  pvpReq<{ ok: boolean }>("/v1/pvp/cancel", { id, sub });

export const claimWin = (id: string, sub: string, address: string) =>
  pvpReq<{ ok: boolean }>("/v1/pvp/claim", { id, sub, address });

export const fetchClaims = () =>
  pvpReq<{ claims: PvpChallenge[] }>("/v1/pvp/claims");

export const recordPayout = (id: string, txid: string) =>
  pvpReq<{ ok: boolean; paid: number }>("/v1/pvp/payout", { id, txid });

export const fetchBoard = () =>
  pvpReq<{ season: string; board: Array<{ handle: string; wins: number }>; recent: PvpChallenge[] }>("/v1/pvp/board");

export const fetchMine = (sub: string) =>
  pvpReq<{ open: PvpChallenge[]; recent: PvpChallenge[] }>(`/v1/pvp/mine?sub=${encodeURIComponent(sub)}`);

const short = (s: string, n = 8) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const shortAddr = short;

export function PvpPanel({ say, busy, setBusy, tw, onLogin, onEvolve }: {
  say(t: string): void;
  busy: string | null;
  setBusy(s: string | null): void;
  tw: TwetchSession | null;
  onLogin(): void;
  onEvolve(pet: Pet, fromName: string): void;
}) {
  const [save, setSave] = useSave();
  const bsv = useBsv();
  const [open, setOpen] = useState<PvpChallenge[]>([]);
  const [mineOpen, setMineOpen] = useState<PvpChallenge[]>([]);
  const [mineRecent, setMineRecent] = useState<PvpChallenge[]>([]);
  const [board, setBoard] = useState<Array<{ handle: string; wins: number }>>([]);
  const [recent, setRecent] = useState<PvpChallenge[]>([]);
  const [season, setSeason] = useState("");
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<PvpResult | null>(null);
  const [tier, setTier] = useState<StakeTier>(0);
  const [rate, setRate] = useState<number | null>(null);
  const [claims, setClaims] = useState<PvpChallenge[]>([]);
  const [claimAddr, setClaimAddr] = useState("");
  const [focusId, setFocusId] = useState<string | null>(() => {
    const m = window.location.hash.match(/^#pvp-([0-9a-f]{16})$/);
    return m ? m[1]! : null;
  });

  useEffect(() => {
    getBsvUsd().then((r) => setRate(r.price)).catch(() => undefined);
  }, []);

  const active = useMemo(
    () => save.pets.find((p) => p.uid === save.activeUid) ?? save.pets[0] ?? null,
    [save]
  );

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [o, b] = await Promise.all([fetchOpen(), fetchBoard()]);
      setOpen(o.challenges);
      setBoard(b.board);
      setRecent(b.recent);
      setSeason(b.season);
      try {
        setClaims((await fetchClaims()).claims);
      } catch {
        /* ignore */
      }
      if (tw) {
        const m = await fetchMine(tw.sub);
        setMineOpen(m.open);
        setMineRecent(m.recent);
      }
    } catch {
      if (!quiet) say("Lobby load failed — try again");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [say, tw]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const needTw = () => {
    if (!tw) {
      say("Sign in with Twetch to play PvP");
      onLogin();
      return false;
    }
    return true;
  };

  const needGw = (): GW | null => {
    const os = osSession();
    if (os) return { kind: "os", ...os };
    if (bsv.ctx) return { kind: "yours", ctx: bsv.ctx };
    const s = embeddedSession();
    if (s) return { kind: "embedded", ...s };
    say("Connect Yours or unlock the built-in wallet (BSV tab)");
    return null;
  };

  const stakeSatsFor = (usd: number): number | null =>
    usd === 0 || rate === null ? (usd === 0 ? 0 : null) : usdToSats(usd, rate);

  /** Pay the tier stake to the pot. Returns {txid, sats}. */
  const payStake = async (gw: GW, usd: number, label: string) => {
    const sats = stakeSatsFor(usd);
    if (sats === null) throw new Error("price feed still loading — wait a beat");
    const { txid } = await gwStake(gw, save.potAddress, save.feeAddress, sats, label);
    return { txid, sats };
  };

  const snapshot = (pet: Pet) => {
    const sp = speciesOf(pet);
    return {
      petUid: pet.uid, nickname: pet.nickname, speciesId: sp.id,
      level: pet.level, happy: pet.happy, wins: pet.wins,
    };
  };

  const applyResult = async (myPet: Pet, won: boolean, rounds: number, foeName: string) => {
    let next = grantXp(
      { ...myPet, energy: Math.max(0, myPet.energy - 15), wins: myPet.wins + (won ? 1 : 0) },
      won ? 22 : 8
    ).pet;
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
    const ledger = await appendLedger(save.ledger, won ? "pvp_win" : "pvp_loss", myPet.uid, `vs ${foeName} ${rounds} rounds`);
    setSave((s) => ({ ...s, ledger, pets: s.pets.map((p) => (p.uid === myPet.uid ? next : p)) }));
    for (const e of evos) {
      const l2 = await appendLedger(save.ledger, "evolve", myPet.uid, `${e.from} -> ${e.to} (pvp ${next.wins} wins)`);
      setSave((s) => ({ ...s, ledger: l2 }));
    }
    if (evos.length > 0) onEvolve(next, evos[0]!.from);
    return evos.length > 0;
  };

  const create = async () => {
    if (!needTw() || !tw || !active) return;
    if (active.energy < 10) return say("Too tired — Rest first!");
    const gw = tier > 0 ? needGw() : null;
    if (tier > 0 && !gw) return;
    setBusy("pvp");
    try {
      let stakeTxid: string | undefined;
      let stakeSats = 0;
      if (tier > 0 && gw) {
        say(`Paying $${tier.toFixed(2)} stake…`);
        const st = await payStake(gw, tier, `open-${active.uid.slice(0, 8)}`);
        stakeTxid = st.txid;
        stakeSats = st.sats;
      }
      const { id } = await postChallenge({
        sub: tw.sub, handle: tw.handle, ...snapshot(active),
        stakeUsd: tier, stakeTxid, stakeSats,
      });
      const ledger = await appendLedger(save.ledger, "pvp_challenge", active.uid, `open ${id.slice(0, 8)} ${tierLabel(tier)}`);
      setSave((s) => ({ ...s, ledger }));
      say(tier > 0 ? `Staked fight posted — $${tier.toFixed(2)} locked` : "Challenge posted — share it or wait for a fighter");
      setFocusId(id);
      try {
        window.history.replaceState(null, "", `#pvp-${id}`);
      } catch {
        /* ignore */
      }
      void refresh(true);
    } catch (e) {
      say(`Challenge failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(null);
    }
  };

  const accept = async (c: PvpChallenge) => {
    if (!needTw() || !tw || !active) return;
    if (active.energy < 10) return say("Too tired — Rest first!");
    const need = c.stake_usd ?? 0;
    const gw = need > 0 ? needGw() : null;
    if (need > 0 && !gw) return;
    setBusy("pvp");
    try {
      let stakeTxid: string | undefined;
      let stakeSats = 0;
      if (need > 0 && gw) {
        say(`Paying $${need.toFixed(2)} stake…`);
        const st = await payStake(gw, need, `accept-${c.id.slice(0, 8)}`);
        stakeTxid = st.txid;
        stakeSats = st.sats;
      }
      const res = await acceptFight({
        id: c.id, sub: tw.sub, handle: tw.handle, ...snapshot(active), stakeTxid, stakeSats,
      });
      const iWon = res.winner === "opponent";
      const foe = res.winner === "opponent" ? res.challenger.nickname : res.opponent.nickname;
      const evolved = await applyResult(active, iWon, res.rounds, foe);
      setResult(res);
      say(
        iWon
          ? evolved
            ? `🌟 You win + EVOLVE into season legend!`
            : `🏆 You beat ${res.challenger.nickname}!`
          : `${res.winner_nickname} takes it. Rematch?`
      );
      if (iWon && need > 0) say(`🏆 Winner! Claim ${(res.winner_payout_sats ?? 0).toLocaleString()} sats below.`);
      buzz(iWon ? 60 : 25);
      void refresh(true);
    } catch (e) {
      say(`Fight failed: ${e instanceof Error ? e.message : "taken — pick another"}`);
      void refresh(true);
    } finally {
      setBusy(null);
    }
  };

  const quickMatch = async () => {
    if (!needTw() || !tw || !active) return;
    if (active.energy < 10) return say("Too tired — Rest first!");
    setBusy("pvp");
    try {
      const { challenges } = await fetchOpen();
      const foe = challenges.find((c) => c.challenger.sub !== tw.sub && (c.stake_usd ?? 0) === tier);
      if (!foe) {
        say(tier > 0 ? `No open ${tierLabel(tier)} fights — posting yours instead` : "No open fights — posting yours instead");
        setBusy(null);
        await create();
        return;
      }
      setBusy(null);
      await accept(foe);
    } finally {
      setBusy(null);
    }
  };

  const claim = async (id: string, address: string) => {
    if (!tw) return;
    const addr = address.trim();
    if (!/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr)) return say("That doesn't look like a BSV address");
    setBusy("pvp");
    try {
      await claimWin(id, tw.sub, addr);
      const ledger = await appendLedger(save.ledger, "pvp_claim", active?.uid ?? "-", `${id.slice(0, 8)} -> ${addr.slice(0, 12)}`);
      setSave((s) => ({ ...s, ledger, payoutAddress: s.payoutAddress || addr }));
      say("Claimed — operator pays out shortly. Watch this space.");
      void refresh(true);
    } catch (e) {
      say(`Claim failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(null);
    }
  };

  const settle = async (id: string, amountSats: number, claimTo: string) => {
    const os = osSession();
    let gw: GW | null = null;
    if (os) gw = { kind: "os", ...os };
    else if (bsv.ctx) gw = { kind: "yours", ctx: bsv.ctx };
    else {
      const s = embeddedSession();
      if (s) gw = { kind: "embedded", ...s };
    }
    if (!gw) return say("Connect a funded wallet to settle (BSV tab)");
    setBusy("pvp");
    try {
      let txid: string;
      if (gw.kind === "yours") {
        const { payoutWinner } = await import("./bsv.ts");
        txid = await payoutWinner(gw.ctx, claimTo, amountSats, season, `pvp-${id.slice(0, 8)}`);
      } else if (gw.kind === "os") {
        const { gwPayout } = await import("./gw.ts");
        txid = await gwPayout(gw, claimTo, amountSats, season, `pvp-${id.slice(0, 8)}`);
      } else {
        const { fetchSpendable, sendBuilt } = await import("./embedded.ts");
        const utxos = await fetchSpendable(gw.address);
        ({ txid } = await sendBuilt({
          wif: gw.wif,
          utxos,
          payments: [{ address: claimTo, sats: amountSats }],
          opReturn: ["POCKETPETS-PAYOUT", season, `pvp-${id.slice(0, 8)}`],
          changeAddress: gw.address,
        }));
      }
      await recordPayout(id, txid);
      const ledger = await appendLedger(save.ledger, "pvp_payout", active?.uid ?? "-", `${id.slice(0, 8)} ${amountSats}sats ${txid.slice(0, 12)}`);
      setSave((s) => ({ ...s, ledger }));
      say(`💸 Paid ${amountSats.toLocaleString()} sats!`);
      void refresh(true);
    } catch (e) {
      say(`Settle failed: ${e instanceof Error ? e.message : "declined"}`);
    } finally {
      setBusy(null);
    }
  };
  const cancel = async (id: string) => {
    if (!tw) return;
    setBusy("pvp");
    try {
      await cancelFight(id, tw.sub);
      say("Challenge withdrawn");
      if (focusId === id) {
        setFocusId(null);
        try {
          window.history.replaceState(null, "", routePath());
        } catch {
          /* ignore */
        }
      }
      void refresh(true);
    } catch (e) {
      say(`Cancel failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(null);
    }
  };

  const share = async (id: string) => {
    const url = `${window.location.origin}${routePath()}#pvp-${id}`;
    const text = `⚔️ Fight my ${active?.nickname ?? "pet"} in Pocket Pets! ${url}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else await navigator.clipboard.writeText(text);
      say("Challenge link copied");
    } catch {
      /* ignore */
    }
  };

  const focused = focusId ? [...open, ...mineOpen].find((c) => c.id === focusId) ?? null : null;
  const myWins = tw ? board.find((b) => b.handle === tw.handle)?.wins ?? 0 : 0;

    if (result) {
    const won = result.winner === "opponent";
    const mkFighter = (f: { nickname: string; species: string; level: number; handle: string }) => {
      const sp = speciesByName(f.species);
      const pseudo: Pet = {
        uid: f.nickname, speciesId: sp.id, nickname: f.nickname, level: f.level,
        xp: 0, hp: 1, happy: 70, energy: 100, wins: 0, pulls: 0,
      };
      let art: string | null = null;
      try {
        art = drawPetCard({ ...pseudo, hp: maxHp(pseudo) });
      } catch {
        art = null;
      }
      return {
        name: f.nickname, sub: `Lv ${f.level} · @${f.handle}`, art,
        emoji: sp.emoji, color: sp.color, maxHp: stats(pseudo).hp,
      };
    };
    return (
      <section className="card">
        <EpicBattle
          a={mkFighter(result.challenger)}
          b={mkFighter(result.opponent)}
          log={result.log ?? []}
          playerWon={won}
          onDone={() => undefined}
          endActions={
            <>
              {result.stake_usd > 0 && (
                <p className="muted">💰 Staked {tierLabel(result.stake_usd)} each · pot {(result.pot_sats ?? 0).toLocaleString()} sats · winner takes {(result.winner_payout_sats ?? 0).toLocaleString()} (10% house){won ? " — claim below in the lobby!" : ""}</p>
              )}
              <p className="muted">deterministic replay (seed: {result.id.slice(0, 8)})</p>
              <div className="row2">
                <button className="primary" onClick={() => { setResult(null); void quickMatch(); }}>Rematch</button>
                <button onClick={() => { setResult(null); setFocusId(null); void refresh(true); }}>Lobby</button>
              </div>
            </>
          }
        />
      </section>
    );
  }

  return (
    <div className="bsvwrap">
      <section className="card">
        <h2>⚔️ PvP Arena {season && <small>· {season}</small>}</h2>
        {tw ? (
          <p className="muted">Fighting as <b>@{tw.handle}</b> · {myWins} season wins · winner takes 90%, house 10%</p>
        ) : (
          <p className="muted">Sign in with Twetch to enter the arena — every fighter is identity-linked.</p>
        )}
        <div className="seg">
          {STAKE_TIERS.map((t) => (
            <button key={t} className={tier === t ? "segbtn on" : "segbtn"} onClick={() => setTier(t)}>
              {tierLabel(t)}
            </button>
          ))}
        </div>
        <p className="muted">{tier === 0 ? "Friendly — glory only." : `Staked $${tier.toFixed(2)} each${rate ? ` (~${usdToSats(tier, rate).toLocaleString()} sats + fee)` : ""} · winner takes 90%.`}</p>
        <div className="row2">
          <button className="primary" disabled={busy === "pvp"} onClick={() => void quickMatch()}>
            {busy === "pvp" ? "…" : "⚡ Quick Match"}
          </button>
          <button disabled={busy === "pvp"} onClick={() => void (tw ? create() : onLogin())}>+ Post fight</button>
        </div>
      </section>

      {focused && (
        <section className="card">
          <h2>🎯 {focused.challenger.nickname} <small>Lv {focused.challenger.level} · @{focused.challenger.handle}</small></h2>
          <p className="muted">{focused.challenger.species} · {focused.challenger.wins} career wins · {(focused.stake_usd ?? 0) > 0 ? `staked ${tierLabel(focused.stake_usd)}` : "friendly"} · waiting</p>
          <div className="row2">
            <button className="primary" disabled={busy === "pvp"} onClick={() => void accept(focused)}>Accept fight</button>
            <button onClick={() => void share(focused.id)}>📤 Share</button>
          </div>
          {tw && focused.challenger.sub === tw.sub && (
            <button className="linkbtn" onClick={() => void cancel(focused.id)}>Withdraw challenge</button>
          )}
        </section>
      )}

      <section className="card">
        <div className="wrow">
          <h2>🏟️ Lobby {open.length > 0 && <small>({open.length})</small>}</h2>
          <button className="linkbtn" onClick={() => void refresh()}>↻</button>
        </div>
        {loading ? <p className="muted">Loading…</p> : open.length === 0 ? (
          <p className="muted">Empty arena. Post the first fight.</p>
        ) : open.map((c) => (
          <div key={c.id} className="brow">
            <span>{emojiFor(c.challenger.species)} <b>{c.challenger.nickname}</b> <small>Lv {c.challenger.level} · @{c.challenger.handle}{(c.stake_usd ?? 0) > 0 ? ` · ${tierLabel(c.stake_usd)}` : ""}{tw && c.challenger.sub === tw.sub ? " (you)" : ""}</small></span>
            {tw && c.challenger.sub === tw.sub
              ? <button className="linkbtn" onClick={() => void cancel(c.id)}>Withdraw</button>
              : <button className="linkbtn" disabled={busy === "pvp"} onClick={() => void accept(c)}>Fight</button>}
          </div>
        ))}
      </section>

      {tw && mineOpen.length > 0 && (
        <section className="card">
          <h2>⏳ Your open fights</h2>
          {mineOpen.map((c) => (
            <div key={c.id} className="brow">
              <span>{emojiFor(c.challenger.species)} {c.challenger.nickname} <small>{(c.stake_usd ?? 0) > 0 ? `${tierLabel(c.stake_usd)} · ` : ""}waiting…</small></span>
              <span>
                <button className="linkbtn" onClick={() => void share(c.id)}>Share</button>{" "}
                <button className="linkbtn" onClick={() => void cancel(c.id)}>Withdraw</button>
              </span>
            </div>
          ))}
        </section>
      )}

      {tw && (() => {
        const claimable = mineRecent.filter(
          (r) => r.winner_sub === tw.sub && (r.stake_usd ?? 0) > 0 && !r.payout_txid
        );
        if (claimable.length === 0) return null;
        return (
          <section className="card">
            <h2>💰 Your winnings</h2>
            {claimable.map((r) => {
              const pot = r.pot_sats ?? 0;
              const payout = Math.floor((pot * (10000 - HOUSE_CUT_BPS)) / 10000);
              return (
                <div key={r.id}>
                  <div className="brow">
                    <span>🏆 {r.winner_nickname} <small>{r.stake_usd > 0 ? tierLabel(r.stake_usd) : ""} each · pot {pot.toLocaleString()} → you {payout.toLocaleString()} sats</small></span>
                    {!r.claim_address ? (
                      <button
                        className="linkbtn"
                        disabled={busy === "pvp"}
                        onClick={() => {
                          const addr = window.prompt("BSV payout address for your winnings", save.payoutAddress);
                          if (addr) void claim(r.id, addr);
                        }}
                      >Claim</button>
                    ) : (
                      <small className="muted">claimed — operator paying…</small>
                    )}
                  </div>
                </div>
              );
            })}
            <p className="muted">Claim with the address from your BSV tab (prefilled). Winners take 90%, house 10%.</p>
          </section>
        );
      })()}

      {claims.length > 0 && (
        <section className="card">
          <h2>🧾 Settle queue (operator)</h2>
          {claims.map((c) => {
            const pot = c.pot_sats ?? 0;
            const payout = Math.floor((pot * (10000 - HOUSE_CUT_BPS)) / 10000);
            return (
              <div key={c.id} className="brow">
                <span>@{c.winner_handle} <small>{c.winner_nickname} · pot {pot.toLocaleString()} → pay {payout.toLocaleString()} to {shortAddr(c.claim_address!)}</small></span>
                <button
                  className="linkbtn"
                  disabled={busy === "pvp"}
                  onClick={() => void settle(c.id, payout, c.claim_address!)}
                >Pay {payout.toLocaleString()}</button>
              </div>
            );
          })}
          <p className="muted">Pays from the connected wallet, then records the txid (verified ≥90% of pot).</p>
        </section>
      )}

      <section className="card">
        <h2>🏆 Season board</h2>
        {board.length === 0 ? <p className="muted">No settled fights yet this season.</p> : (
          <div className="board">{board.map((b, i) => (
            <div key={b.handle} className="brow"><span>{i + 1}. @{b.handle}</span><b>{b.wins}W</b></div>
          ))}</div>
        )}
        {recent.length > 0 && (
          <>
            <h3>Recent</h3>
            {recent.slice(0, 6).map((r) => (
              <p key={r.id} className="muted">
                {r.winner_nickname} beat {r.winner === "challenger" ? r.opponent?.nickname : r.challenger.nickname} · {r.rounds} rounds
              </p>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

function emojiFor(speciesId: string): string {
  const map: Record<string, string> = {
    mochi: "🍡", pebble: "🪨", sprout: "🌱", puff: "☁️", tidal: "🐚", zippy: "🐝",
    mossy: "🍄", niblet: "🧀", ember: "🔥", bubbles: "🫧", nocti: "🦉", glimmer: "✨",
    torto: "🐢", zephyr: "🍃", gumbo: "🍲", volti: "⚡", corali: "🪸", prism: "🔮",
    thorn: "🌵", cosmo: "🌌", aurum: "🐉", celeste: "🦄", umbra: "🌑",
  };
  return map[speciesId] ?? "🐾";
}
