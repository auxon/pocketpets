// Synthesized battle SFX — zero assets, pure WebAudio.
// Everything is lazy (first user gesture creates the context) and guarded.
const MUTE_KEY = "pp.muted";

let ctx: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === "1";
} catch {
  /* ignore */
}

export const isMuted = () => muted;
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(opts: {
  freq: number;
  end?: number;
  dur: number;
  type?: OscillatorType;
  vol?: number;
  delay?: number;
}): void {
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + (opts.delay ?? 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = opts.type ?? "sine";
    o.frequency.setValueAtTime(opts.freq, t0);
    if (opts.end) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.end), t0 + opts.dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.vol ?? 0.15, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + opts.dur + 0.05);
  } catch {
    /* ignore */
  }
}

function noise(opts: { dur: number; vol?: number; from?: number; to?: number; delay?: number }): void {
  const c = ac();
  if (!c) return;
  try {
    const t0 = c.currentTime + (opts.delay ?? 0);
    const len = Math.max(1, Math.floor(c.sampleRate * opts.dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(opts.from ?? 3000, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, opts.to ?? 300), t0 + opts.dur);
    const g = c.createGain();
    g.gain.setValueAtTime(opts.vol ?? 0.2, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
  } catch {
    /* ignore */
  }
}

/** Impact thump scaled by damage. */
export function sfxHit(dmg: number): void {
  const big = dmg >= 12;
  tone({ freq: big ? 170 : 220, end: 55, dur: big ? 0.22 : 0.14, type: "sine", vol: big ? 0.28 : 0.18 });
  noise({ dur: 0.09, vol: big ? 0.22 : 0.12, from: 5000, to: 800 });
}

/** Knockout: power-down sweep + boom. */
export function sfxKo(): void {
  tone({ freq: 420, end: 45, dur: 0.7, type: "sawtooth", vol: 0.2 });
  noise({ dur: 0.5, vol: 0.25, from: 2500, to: 60, delay: 0.05 });
}

/** Victory arpeggio. */
export function sfxVictory(): void {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => tone({ freq: f, dur: 0.22, type: "triangle", vol: 0.16, delay: i * 0.11 }));
  tone({ freq: 1318.5, dur: 0.4, type: "triangle", vol: 0.14, delay: 0.46 });
}

/** Defeat descent. */
export function sfxDefeat(): void {
  const notes = [392, 329.63, 261.63];
  notes.forEach((f, i) => tone({ freq: f, dur: 0.3, type: "triangle", vol: 0.14, delay: i * 0.16 }));
}

/** UI tap. */
export function sfxClick(): void {
  tone({ freq: 660, dur: 0.06, type: "square", vol: 0.05 });
}

/** Round bell. */
export function sfxBell(): void {
  tone({ freq: 880, dur: 0.35, type: "sine", vol: 0.12 });
  tone({ freq: 880, dur: 0.3, type: "sine", vol: 0.08, delay: 0.4 });
}
