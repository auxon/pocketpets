// BSV helpers: hashing, explorer links, pot config. No wallet deps here.

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sha256HexSyncFallback(): never {
  throw new Error("use sha256Hex (async)");
}

export const wocTxUrl = (txid: string) => `https://whatsonchain.com/tx/${txid}`;
export const onesatUrl = (origin: string) => `https://1satordinals.com/inscription/${origin.replace("_", ".")}`;

/** Weekly season key, e.g. 2026-W37 */
export function seasonKey(d = new Date()): string {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

// --- pot config (operator can change address in UI; persisted) ---
export const DEFAULT_POT_ADDRESS = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";
export const ENTRY_SATS = 100; // legacy fallback for old entries
export const POT_FEE_BPS = 200; // 2% operator cut of pot on payout
export const MARKET_FEE_BPS = 200; // 2% operator cut of NFT sale price

// --- operator revenue: USD-denominated, converted to sats at pay time ---
export const MINT_FEE_USD = 0.5;
export const ACTION_FEE_USD = 0.02;
export const ENTRY_USD = 0.1;
export const PULL_USD = 0.1;
export const FOOD_REFILL_USD = 0.05;
export const DEFAULT_FEE_ADDRESS = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";
export const FALLBACK_BSV_USD = 25;

let cachedRate: { price: number; at: number } | null = null;

/** Live BSV/USD from Coinbase, cached 5 min. Falls back to $25 offline. */
export async function getBsvUsd(): Promise<{ price: number; live: boolean }> {
  if (cachedRate && Date.now() - cachedRate.at < 5 * 60 * 1000) {
    return { price: cachedRate.price, live: true };
  }
  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://api.coinbase.com/v2/prices/BSV-USD/spot", { signal: ctrl.signal });
    window.clearTimeout(t);
    const j = (await res.json()) as { data?: { amount?: string } };
    const price = Number(j.data?.amount);
    if (Number.isFinite(price) && price > 0) {
      cachedRate = { price, at: Date.now() };
      try {
        localStorage.setItem("pocketpets.bsvusd", JSON.stringify(cachedRate));
      } catch {
        /* ignore */
      }
      return { price, live: true };
    }
  } catch {
    /* fall through to cache/fallback */
  }
  try {
    const raw = localStorage.getItem("pocketpets.bsvusd");
    if (raw) {
      const c = JSON.parse(raw) as { price: number };
      if (Number.isFinite(c.price) && c.price > 0) return { price: c.price, live: false };
    }
  } catch {
    /* ignore */
  }
  return { price: FALLBACK_BSV_USD, live: false };
}

export function usdToSats(usd: number, rate: number): number {
  return Math.max(1, Math.ceil((usd / rate) * 1e8));
}

// --- hash-chained action ledger ---
export interface LedgerEntry {
  seq: number;
  ts: number;
  action: string;
  petUid: string;
  detail: string;
  prev: string;
  hash: string;
  anchorTxid?: string;
}

export async function hashEntry(e: Omit<LedgerEntry, "hash">): Promise<string> {
  return sha256Hex([e.seq, e.ts, e.action, e.petUid, e.detail, e.prev].join("|"));
}

export async function appendLedger(
  prev: LedgerEntry[],
  action: string,
  petUid: string,
  detail: string
): Promise<LedgerEntry[]> {
  const last = prev[prev.length - 1];
  const base = {
    seq: prev.length,
    ts: Date.now(),
    action,
    petUid,
    detail,
    prev: last ? last.hash : "GENESIS",
  };
  const hash = await hashEntry(base);
  return [...prev.slice(-499), { ...base, hash }];
}

export async function verifyLedger(entries: LedgerEntry[]): Promise<{ ok: boolean; badSeq: number }> {
  let prev = "GENESIS";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prev !== prev) return { ok: false, badSeq: e.seq };
    const h = await hashEntry(e);
    if (h !== e.hash) return { ok: false, badSeq: e.seq };
    prev = e.hash;
  }
  return { ok: true, badSeq: -1 };
}

export interface PotEntry {
  txid: string;
  petUid: string;
  nickname: string;
  season: string;
  ts: number;
  anchorHash: string; // ledger tip at entry time
  sats: number; // entry stake paid to pot (excludes fee)
  twsub?: string; // Twetch user id (identity-linked entry)
  handle?: string; // Twetch handle at entry time
}

export interface PotPayout {
  season: string;
  winnerUid: string;
  winnerNickname: string;
  address: string;
  txid: string;
  amountSats: number;
  ts: number;
}
