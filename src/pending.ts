// In-flight transaction tracking: coins spent by our own unconfirmed txs
// must not be reused until they mine. Enables safe rapid-fire actions and
// chained unconfirmed spends (child builds on parent change).
import type { Utxo } from "./embedded.ts";

export interface PendingSpent {
  txid: string;
  vout: number;
}
export interface PendingFresh extends PendingSpent {
  value: number;
  scriptHex?: string;
  address: string;
}
export interface PendingTx {
  txid: string;
  spent: PendingSpent[];
  fresh: PendingFresh[];
  ts: number;
}

const KEY = "pp.pending.v1";
const TTL_MS = 24 * 3600 * 1000;
const MAX = 50;

function mem(): Map<string, string> {
  const g = globalThis as unknown as { __ppMem?: Map<string, string> };
  if (!g.__ppMem) g.__ppMem = new Map();
  return g.__ppMem;
}

function backing(): Storage | Map<string, string> {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* ignore */
  }
  return mem();
}

function load(): PendingTx[] {
  try {
    const store = backing();
    const raw = store instanceof Map ? store.get(KEY) : store.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as PendingTx[];
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list.filter((p) => p && typeof p.txid === "string" && now - (p.ts || 0) < TTL_MS).slice(0, MAX);
  } catch {
    return [];
  }
}

function save(list: PendingTx[]): void {
  try {
    const raw = JSON.stringify(list.slice(0, MAX));
    const store = backing();
    if (store instanceof Map) store.set(KEY, raw);
    else store.setItem(KEY, raw);
  } catch {
    /* ignore */
  }
}

export function recordPending(p: PendingTx): void {
  const list = load().filter((x) => x.txid !== p.txid);
  list.unshift({ ...p, ts: Date.now() });
  save(list);
}

export function dropPending(txid: string): void {
  save(load().filter((x) => x.txid !== txid));
}

export function listPending(): PendingTx[] {
  return load();
}

/**
 * Merge indexed UTXOs with in-flight state for one address:
 * drop outpoints our pending txs consumed, add their fresh change outputs
 * (spendable immediately — chained 0-conf is valid on BSV).
 */
export function spendable(utxos: Utxo[], address: string): Utxo[] {
  const pending = load().filter((p) => p.fresh.some((f) => f.address === address));
  const spent = new Set<string>();
  for (const p of load()) {
    for (const s of p.spent) spent.add(`${s.txid}:${s.vout}`);
  }
  const kept = utxos.filter((u) => !spent.has(`${u.txid}:${u.vout}`));
  const fresh: Utxo[] = [];
  for (const p of pending) {
    for (const f of p.fresh) {
      if (f.address !== address) continue;
      if (spent.has(`${f.txid}:${f.vout}`)) continue; // already re-spent by a child
      fresh.push({ txid: f.txid, vout: f.vout, value: f.value, height: 0, scriptHex: f.scriptHex });
    }
  }
  return [...kept, ...fresh];
}
