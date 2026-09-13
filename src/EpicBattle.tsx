// EpicBattle — cinematic turn-by-turn player shared by wild + PvP fights.
// Full fighter cards in the ring, readable pacing (tap or auto), floating
// damage, screen shake, KO slow-mo, and synthesized sound. No assets.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { isMuted, setMuted, sfxBell, sfxDefeat, sfxHit, sfxKo, sfxVictory } from "./sound.ts";

export interface EpicFighter {
  name: string;
  sub: string;
  art: string | null;
  emoji: string;
  color: string;
  maxHp: number;
}

export interface EpicTurn {
  actor: string;
  text: string;
  dmg: number;
  aHp: number;
  bHp: number;
}

export function EpicBattle({ a, b, log, playerWon, turnMs = 950, onDone, endActions }: {
  a: EpicFighter;
  b: EpicFighter;
  log: EpicTurn[];
  playerWon: boolean;
  turnMs?: number;
  onDone(): void;
  endActions: ReactNode;
}) {
  const end = log.length - 1;
  const [idx, setIdx] = useState(-1);
  const [auto, setAuto] = useState(true);
  const [mutedUi, setMutedUi] = useState(isMuted());
  const doneFired = useRef(false);
  const done = idx >= end && end >= 0;

  // faceoff bell, then first turn
  useEffect(() => {
    sfxBell();
    const t = window.setTimeout(() => setIdx(0), 750);
    return () => window.clearTimeout(t);
  }, []);

  // auto-advance
  useEffect(() => {
    if (!auto || done || idx < 0) return;
    const t = window.setTimeout(() => setIdx((i) => Math.min(i + 1, end)), turnMs);
    return () => window.clearTimeout(t);
  }, [auto, done, idx, end, turnMs]);

  // per-turn + finale sounds
  useEffect(() => {
    if (idx < 0 || log.length === 0) return;
    const turn = log[Math.min(idx, end)];
    if (!turn) return;
    if (turn.aHp === 0 || turn.bHp === 0) {
      sfxKo();
    } else {
      sfxHit(turn.dmg);
    }
    if (idx >= end && !doneFired.current) {
      doneFired.current = true;
      window.setTimeout(() => {
        if (playerWon) sfxVictory();
        else sfxDefeat();
        onDone();
      }, 650);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);

  // empty log: finish immediately
  useEffect(() => {
    if (log.length === 0 && !doneFired.current) {
      doneFired.current = true;
      onDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log.length]);

  const turn = idx >= 0 && log.length > 0 ? log[Math.min(idx, end)] : null;
  const aHp = turn ? turn.aHp : a.maxHp;
  const bHp = turn ? turn.bHp : b.maxHp;
  const defender: "a" | "b" = turn ? (turn.actor === a.name ? "b" : "a") : "a";
  const heavy = !!turn && (turn.dmg >= 12 || turn.aHp === 0 || turn.bHp === 0);
  const ko = done && (aHp === 0 || bHp === 0);
  const round = idx < 0 ? 1 : Math.floor(idx / 2) + 1;

  const advance = () => {
    if (done) return;
    setIdx((i) => Math.min(i + 1, Math.max(end, 0)));
  };

  const hpColor = (hp: number, max: number) => {
    const r = max > 0 ? hp / max : 0;
    return r > 0.5 ? "#4ade80" : r > 0.25 ? "#facc15" : "#ef4444";
  };

  const card = (f: EpicFighter, hp: number, side: "a" | "b", hit: boolean) => (
    <div className={`ecard${hit ? " hitflash" : ""}`} style={{ borderColor: f.color }}>
      {f.art
        ? <img src={f.art} alt={f.name} draggable={false} />
        : <div className="eemoji">{f.emoji}</div>}
      <b>{f.name}</b>
      <small>{f.sub}</small>
      <div className="ebar"><i style={{ width: `${Math.max(0, (hp / f.maxHp) * 100)}%`, background: hpColor(hp, f.maxHp) }} /></div>
      <small className="ehp">{Math.max(0, Math.round(hp))}/{f.maxHp} HP</small>
      {hit && turn && (
        <motion.span
          key={`dmg-${idx}`}
          className="floater"
          initial={{ opacity: 1, y: 6, scale: 0.7 }}
          animate={{ opacity: 0, y: -46, scale: 1.25 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >-{turn.dmg}</motion.span>
      )}
    </div>
  );

  return (
    <div className="epic" onClick={advance}>
      <div className="epic-top">
        <div className="eprog"><i style={{ width: log.length ? `${((Math.max(idx, 0) + 1) / log.length) * 100}%` : "100%" }} /></div>
        <div className="ectrls">
          <button className="iconbtn" onClick={(e) => { e.stopPropagation(); setAuto((v) => !v); }} title={auto ? "Pause auto-play" : "Resume auto-play"}>
            {auto ? "⏸" : "▶"}
          </button>
          <button className="iconbtn" onClick={(e) => {
            e.stopPropagation();
            const m = !mutedUi;
            setMuted(m);
            setMutedUi(m);
          }} title="Sound on/off">{mutedUi ? "🔇" : "🔊"}</button>
          {!done && (
            <button className="iconbtn" onClick={(e) => { e.stopPropagation(); setIdx(Math.max(end, 0)); }} title="Skip to result">⏩</button>
          )}
        </div>
      </div>

      <div className="ering">
        {heavy && <div key={`shake-${idx}`} className="shakefx" />}
        <div className="ecards">
          {card(a, aHp, "a", !!turn && defender === "a")}
          <div className="evs">VS</div>
          {card(b, bHp, "b", !!turn && defender === "b")}
        </div>

        <AnimatePresence mode="wait">
          {idx < 0 ? (
            <motion.div key="faceoff" className="faceoff" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              ⚔️ FIGHT!
            </motion.div>
          ) : turn ? (
            <motion.div
              key={`turn-${idx}`}
              className="turnbanner"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <small>ROUND {round}</small>
              <div>{turn.text}</div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {ko && (
          <motion.div className="kobanner" initial={{ scale: 2.2, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.4 }}>
            K.O.!
          </motion.div>
        )}
      </div>

      {done && (
        <motion.div className="endpanel" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <h3>{playerWon ? "🏆 Victory!" : "💔 Defeat"}</h3>
          {endActions}
        </motion.div>
      )}
      {!done && <p className="muted taphint">tap to advance · auto-plays</p>}
    </div>
  );
}
