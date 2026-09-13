// Built-in self-custody BSV wallet for Pocket Pets.
// Key lives encrypted (PIN) in localStorage; signing happens on-device;
// UTXOs + broadcast go through our CORS proxy (no keys ever leave the phone).
import { OP, P2PKH, PrivateKey, Script, Transaction, Utils } from "@bsv/sdk";
import { recordPending, spendable } from "./pending.ts";

export const PROXY = "https://gatekeep-upstream.richard-hein.workers.dev";
const KEY_STORE = "pocketpets.key.v1";
const FEE_SATS_PER_KB = 1000; // 1 sat/vB — relays reject dust-rate fees
const MIN_MINER_FEE = 100;
const DUST = 20;

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  height: number;
  scriptHex?: string; // exact locking script when known (e.g. own NFT)
}

// ---------- chain via proxy ----------
export async function fetchUtxos(address: string): Promise<{ confirmed: number; unconfirmed: number; utxos: Utxo[] }> {
  const res = await fetch(`${PROXY}/v1/utxos/${address}`);
  if (!res.ok) throw new Error("UTXO lookup failed");
  return (await res.json()) as { confirmed: number; unconfirmed: number; utxos: Utxo[] };
}

export async function broadcast(txHex: string): Promise<string> {
  const res = await fetch(`${PROXY}/v1/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHex }),
  });
  const j = (await res.json().catch(() => ({}))) as { txid?: string; detail?: string; error?: string };
  if (!res.ok || !j.txid) throw new Error(String(j.detail ?? j.error ?? "broadcast rejected").slice(0, 160));
  return j.txid;
}

export interface NftLocation {
  utxo: Utxo;
  unconfirmed: boolean;
}

/**
 * Locate the live NFT outpoint.
 *
 * NOTE: inscription (envelope) outputs map to no address, so no address UTXO
 * index can ever contain them — absence from the index means nothing. The
 * parent mint tx is the source of truth: missing → not yet visible, retry;
 * unconfirmed → build chained behind it; confirmed → resolve (only the
 * owner's key can move it, and our flows record every move we make).
 */
export async function resolveNftUtxo(address: string, originTxid: string, vout = 0): Promise<NftLocation> {
  void address;
  let utx: { utxos: Utxo[] } | null = null;
  try {
    utx = await fetchUtxos(address);
  } catch {
    utx = null; // indexer hiccup — fall through to parent check
  }
  const live = utx?.utxos.find((u) => u.txid === originTxid && u.vout === vout);
  if (live) return { utxo: live, unconfirmed: (live.height ?? 1) <= 0 };
  const res = await fetch(`${PROXY}/v1/tx/${originTxid}`);
  if (!res.ok) {
    throw new Error("Mint tx not found on-chain yet — wait a beat and retry");
  }
  const tx = (await res.json().catch(() => ({}))) as { confirmations?: number };
  return {
    utxo: { txid: originTxid, vout, value: 1, height: (tx.confirmations ?? 0) > 0 ? 1 : 0 },
    unconfirmed: (tx.confirmations ?? 0) <= 0,
  };
}

// ---------- keys ----------
export function createKey(): { wif: string; address: string } {
  const priv = PrivateKey.fromRandom();
  return { wif: priv.toWif(), address: priv.toPublicKey().toAddress() };
}

export function addressFromWif(wif: string): string {
  return PrivateKey.fromWif(wif.trim()).toPublicKey().toAddress();
}

async function pinKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(`pp-${pin}`), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 120000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function storeKeyEncrypted(wif: string, pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pinKey(pin, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(wif));
  const rec = {
    salt: Utils.toBase64(Array.from(salt)),
    iv: Utils.toBase64(Array.from(iv)),
    data: Utils.toBase64(Array.from(new Uint8Array(ct))),
  };
  (storage()).setItem(KEY_STORE, JSON.stringify(rec));
}

export async function loadKeyEncrypted(pin: string): Promise<string | null> {
  try {
    const raw = (storage()).getItem(KEY_STORE);
    if (!raw) return null;
    const rec = JSON.parse(raw) as { salt: string; iv: string; data: string };
    const key = await pinKey(pin, new Uint8Array(Utils.toArray(rec.salt, "base64")));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(Utils.toArray(rec.iv, "base64")) as BufferSource },
      key,
      new Uint8Array(Utils.toArray(rec.data, "base64")) as BufferSource
    );
    const wif = new TextDecoder().decode(pt);
    addressFromWif(wif); // throws if wrong PIN / corrupt
    return wif;
  } catch {
    return null;
  }
}

export const hasStoredKey = (): boolean => {
  try {
    return !!(storage()).getItem(KEY_STORE);
  } catch {
    return false;
  }
};

export function forgetKey(): void {
  try {
    (storage()).removeItem(KEY_STORE);
  } catch {
    /* ignore */
  }
}

function storage(): Storage {
  if (typeof localStorage !== "undefined") return localStorage;
  const mem = new Map<string, string>();
  return {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

// ---------- scripts ----------
function push(data: Uint8Array): { op: number; data?: number[] } {
  const bytes = Array.from(data);
  if (bytes.length <= 75) return { op: bytes.length, data: bytes };
  if (bytes.length <= 255) return { op: 0x4c, data: [bytes.length, ...bytes] };
  return { op: 0x4d, data: [bytes.length & 0xff, (bytes.length >> 8) & 0xff, ...bytes] };
}

const utf8 = (s: string): Uint8Array => new Uint8Array(Utils.toArray(s, "utf8"));

export function p2pkhScript(address: string): Script {
  return new P2PKH().lock(address);
}

/** OP_0 OP_RETURN <push>... */
export function opReturnScript(parts: string[]): Script {
  const chunks: { op: number; data?: number[] }[] = [{ op: OP.OP_0 }, { op: OP.OP_RETURN }];
  for (const p of parts) chunks.push(push(utf8(p)));
  return new Script(chunks);
}

/** P2PKH lock + 1Sat Ordinal envelope (image renders as the NFT). */
export function inscriptionScript(address: string, contentType: string, content: Uint8Array): Script {
  const base = p2pkhScript(address).chunks;
  return new Script([
    ...base,
    { op: OP.OP_0 },
    { op: OP.OP_IF },
    push(utf8("ord")),
    { op: OP.OP_1 },
    push(utf8(contentType)),
    { op: OP.OP_0 },
    push(content),
    { op: OP.OP_ENDIF },
  ]);
}

// ---------- tx builder ----------
export interface BuilderPayment {
  address: string;
  sats: number;
  scriptHex?: string; // override (e.g. inscription output)
}

export interface BuiltTx {
  tx: Transaction;
  fee: number;
  inputs: number;
  picked: Array<Utxo & { script: Script }>;
  changeSats: number;
  changeVout: number; // -1 when folded into fee
  ownLockHex: string;
}

/** Build + sign a tx. Inscription (if any) is always vout 0. */
export function buildTx(opts: {
  wif: string;
  utxos: Utxo[];
  payments: BuilderPayment[];
  opReturn?: string[];
  inscription?: { scriptHex: string };
  changeAddress: string;
}): BuiltTx {
  const priv = PrivateKey.fromWif(opts.wif);
  const ownLock = p2pkhScript(opts.changeAddress);
  const withScript = opts.utxos.map((u) => ({
    ...u,
    script: u.scriptHex ? Script.fromHex(u.scriptHex) : p2pkhScript(opts.changeAddress),
  }));
  const need = opts.payments.reduce((a, p) => a + p.sats, 0) + (opts.inscription ? 1 : 0);
  const sorted = [...withScript].sort((a, b) => b.value - a.value).slice(0, 30);
  const picked: typeof sorted = [];
  let total = 0;
  for (const u of sorted) {
    picked.push(u);
    total += u.value;
    if (total >= need + MIN_MINER_FEE) break;
  }
  if (total < need) throw new Error(`Insufficient funds (have ${total}, need ${need} + fee)`);

  const outLens: number[] = [];
  if (opts.inscription) outLens.push(8 + 1 + opts.inscription.scriptHex.length / 2);
  for (const p of opts.payments) {
    const script = p.scriptHex ? Script.fromHex(p.scriptHex) : p2pkhScript(p.address);
    outLens.push(8 + 1 + script.toHex().length / 2);
  }
  let opLen = 0;
  if (opts.opReturn?.length) {
    opLen = 8 + 1 + opReturnScript(opts.opReturn).toHex().length / 2;
    outLens.push(opLen);
  }
  const estVsize = 10 + 1 + picked.length * 148 + 1 + outLens.reduce((a, b) => a + b, 0) + 8 + 1 + 34;
  let fee = Math.max(MIN_MINER_FEE, Math.ceil((estVsize / 1000) * FEE_SATS_PER_KB));
  let change = total - need - fee;
  if (change < 0) throw new Error(`Insufficient funds for fee (short ${-change} sats)`);
  const useChange = change >= DUST;
  if (!useChange) fee += change;

  const tx = new Transaction();
  for (const u of picked) {
    tx.addInput({
      unlockingScriptTemplate: new P2PKH().unlock(priv, "all", false, u.value, u.script),
      sourceTXID: u.txid,
      sourceOutputIndex: u.vout,
    });
  }
  if (opts.inscription) {
    tx.addOutput({ lockingScript: Script.fromHex(opts.inscription.scriptHex), satoshis: 1 });
  }
  for (const p of opts.payments) {
    tx.addOutput({
      lockingScript: p.scriptHex ? Script.fromHex(p.scriptHex) : p2pkhScript(p.address),
      satoshis: p.sats,
    });
  }
  if (opts.opReturn?.length) tx.addOutput({ lockingScript: opReturnScript(opts.opReturn), satoshis: 0 });
  // change vout = current output count (inscription + payments + opreturn precede it)
  const changeVout = useChange ? tx.outputs.length : -1;
  if (useChange) tx.addOutput({ lockingScript: ownLock, satoshis: change });

  return { tx, fee, inputs: picked.length, picked, changeSats: useChange ? change : 0, changeVout, ownLockHex: ownLock.toHex() };
}

export async function signTx(tx: Transaction): Promise<{ hex: string; txid: string }> {
  await tx.sign();
  return { hex: tx.toHex(), txid: tx.id("hex") };
}

/** One call: build, sign, broadcast. Returns txid + miner fee. */
export async function sendBuilt(opts: {
  wif: string;
  utxos: Utxo[];
  payments: BuilderPayment[];
  opReturn?: string[];
  inscription?: { scriptHex: string };
  changeAddress: string;
}): Promise<{ txid: string; fee: number; txStatus: string | null }> {
  const built = buildTx(opts);
  const { hex, txid } = await signTx(built.tx);
  const res = await fetch(`${PROXY}/v1/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHex: hex }),
  });
  const j = (await res.json().catch(() => ({}))) as { txid?: string; txStatus?: string; detail?: string; error?: string };
  if (!res.ok || !j.txid) throw new Error(String(j.detail ?? j.error ?? "broadcast rejected").slice(0, 160));
  const bc = j.txid;
  // Reserve spent coins + advertise fresh change so rapid follow-up actions
  // build on this tx instead of double-spending it.
  const fresh: Array<{ txid: string; vout: number; value: number; scriptHex?: string; address: string }> = [];
  if (built.changeVout >= 0 && built.changeSats > 0) {
    fresh.push({ txid: bc, vout: built.changeVout, value: built.changeSats, scriptHex: built.ownLockHex, address: opts.changeAddress });
  }
  if (opts.inscription) {
    fresh.push({ txid: bc, vout: 0, value: 1, scriptHex: opts.inscription.scriptHex, address: opts.changeAddress });
  }
  recordPending({
    txid: bc,
    spent: built.picked.map((u) => ({ txid: u.txid, vout: u.vout })),
    fresh,
    ts: Date.now(),
  });
  return { txid: bc, fee: built.fee, txStatus: j.txStatus ?? null };
}

/** Chain status for watch/reconcile (SEEN_ON_NETWORK, MINED, REJECTED…). */
export async function arcStatus(txid: string): Promise<{
  txStatus: string;
  blockHeight: number;
  competingTxs: string[] | null;
  extraInfo: string | null;
}> {
  const res = await fetch(`${PROXY}/v1/txstatus/${txid}`);
  if (!res.ok) return { txStatus: "UNKNOWN", blockHeight: 0, competingTxs: null, extraInfo: null };
  const j = (await res.json()) as { txStatus?: string; blockHeight?: number; competingTxs?: string[] | null; extraInfo?: string | null };
  return {
    txStatus: j.txStatus ?? "UNKNOWN",
    blockHeight: j.blockHeight ?? 0,
    competingTxs: j.competingTxs ?? null,
    extraInfo: j.extraInfo ?? null,
  };
}

/**
 * Spendable coins = indexed UTXOs minus our in-flight spends plus our
 * unconfirmed change. Use everywhere instead of raw fetchUtxos.
 */
export async function fetchSpendable(address: string): Promise<Utxo[]> {
  const u = await fetchUtxos(address);
  return spendable(u.utxos, address);
}
