// Atomic NFT swaps via SIGHASH_SINGLE | ANYONECANPAY.
//
// Seller pre-signs input 0 (the 1-sat inscription UTXO), committing ONLY to
// output 0 (payment to seller). Anyone can then complete the tx by adding
// funding inputs and the NFT/fee/change outputs. Either the whole swap
// settles or nothing does — no escrow, no operator step.
//
// Fixed template (both sides MUST match): version 2, locktime 0,
// seller sequence 0xffffffff, seller input 0, payment output 0.
import { P2PKH, PrivateKey, Script, Transaction } from "@bsv/sdk";
import { p2pkhScript } from "./embedded.ts";

export const SWAP_VERSION = 2;
export const SWAP_LOCKTIME = 0;
export const SWAP_SEQ = 0xffffffff;
const MINER_RATE_PER_KB = 1000; // 1 sat/vB
const MIN_MINER_FEE = 100;
const DUST = 20;

export interface SwapUtxo {
  txid: string;
  vout: number;
  scriptHex: string;
}

export interface SwapOffer {
  input: { txid: string; vout: number; scriptHex: string; sequence: number };
  unlockHex: string;
  payScriptHex: string;
  priceSats: number;
  version: number;
  lockTime: number;
  unconfirmedParent?: boolean; // mint tx still 0-conf; swap chains behind it
}

/** Seller: sign the swap offer. No broadcast — NFT stays put until bought. */
export async function createSwapOffer(opts: {
  wif: string;
  utxo: SwapUtxo;
  sellerAddress: string;
  priceSats: number;
}): Promise<SwapOffer> {
  if (!Number.isInteger(opts.priceSats) || opts.priceSats < 1) throw new Error("bad price");
  const priv = PrivateKey.fromWif(opts.wif);
  const lock = Script.fromHex(opts.utxo.scriptHex);
  const payScript = p2pkhScript(opts.sellerAddress);
  const tx = new Transaction(SWAP_VERSION, [], [], SWAP_LOCKTIME);
  tx.addInput({
    unlockingScriptTemplate: new P2PKH().unlock(priv, "single", true, 1, lock),
    sourceTXID: opts.utxo.txid,
    sourceOutputIndex: opts.utxo.vout,
    sequence: SWAP_SEQ,
  });
  tx.addOutput({ lockingScript: payScript, satoshis: opts.priceSats });
  await tx.sign();
  const unlock = tx.inputs[0]?.unlockingScript;
  if (!unlock) throw new Error("signing produced no script");
  return {
    input: { txid: opts.utxo.txid, vout: opts.utxo.vout, scriptHex: opts.utxo.scriptHex, sequence: SWAP_SEQ },
    unlockHex: unlock.toHex(),
    payScriptHex: payScript.toHex(),
    priceSats: opts.priceSats,
    version: SWAP_VERSION,
    lockTime: SWAP_LOCKTIME,
  };
}

export interface CompletedSwap {
  hex: string;
  txid: string;
  fee: number;
  spent: Array<{ txid: string; vout: number }>;
  changeSats: number;
  changeVout: number;
  buyerLockHex: string;
}

/** Buyer: complete + sign + (caller broadcasts). Throws if funds short. */
export async function completeSwap(opts: {
  offer: SwapOffer;
  buyerWif: string;
  buyerAddress: string;
  buyerUtxos: Array<{ txid: string; vout: number; value: number }>;
  feeAddress: string;
  feeSats: number;
  memo: string[];
}): Promise<CompletedSwap> {
  const { offer } = opts;
  if (offer.version !== SWAP_VERSION || offer.lockTime !== SWAP_LOCKTIME) {
    throw new Error("offer template mismatch");
  }
  const priv = PrivateKey.fromWif(opts.buyerWif);
  const buyerLock = p2pkhScript(opts.buyerAddress);
  const sellerUnlockLen = opts.offer.unlockHex.length / 2;

  const need = offer.priceSats + 1 + opts.feeSats;
  const sorted = [...opts.buyerUtxos].sort((a, b) => b.value - a.value).slice(0, 30);
  const picked: typeof sorted = [];
  let total = 1; // seller's 1-sat inscription input (funds the NFT output)
  for (const u of sorted) {
    picked.push(u);
    total += u.value;
    if (total >= need + 1 + MIN_MINER_FEE) break;
  }
  if (total < need + 1) throw new Error(`Insufficient funds (have ${total}, need ${need + 1} + fee)`);

  const opLen = memoScriptLen(opts.memo);
  // seller input exact: outpoint(36) + script len varint + unlock + sequence(4)
  const sellerInLen = 36 + 1 + sellerUnlockLen + 4;
  const estVsize =
    10 + 1 + sellerInLen + picked.length * 148 + 1 +
    (8 + 1 + 25) + (8 + 1 + 25) + (8 + 1 + 25) + (8 + 1 + opLen) + (8 + 1 + 25);
  let fee = Math.max(MIN_MINER_FEE, Math.ceil((estVsize / 1000) * MINER_RATE_PER_KB));
  let change = total - offer.priceSats - 1 - opts.feeSats - fee;
  if (change < 0) throw new Error(`Insufficient funds for fee (short ${-change} sats)`);
  const useChange = change >= DUST;
  if (!useChange) fee += change;

  const tx = new Transaction(SWAP_VERSION, [], [], SWAP_LOCKTIME);
  tx.addInput({
    unlockingScript: Script.fromHex(offer.unlockHex),
    sourceTXID: offer.input.txid,
    sourceOutputIndex: offer.input.vout,
    sequence: offer.input.sequence,
  });
  for (const u of picked) {
    tx.addInput({
      unlockingScriptTemplate: new P2PKH().unlock(priv, "all", false, u.value, buyerLock),
      sourceTXID: u.txid,
      sourceOutputIndex: u.vout,
      sequence: SWAP_SEQ,
    });
  }
  tx.addOutput({ lockingScript: Script.fromHex(offer.payScriptHex), satoshis: offer.priceSats });
  tx.addOutput({ lockingScript: buyerLock, satoshis: 1 });
  tx.addOutput({ lockingScript: p2pkhScript(opts.feeAddress), satoshis: opts.feeSats });
  tx.addOutput({ lockingScript: opReturnScript(opts.memo), satoshis: 0 });
  const changeVout = useChange ? tx.outputs.length : -1;
  if (useChange) tx.addOutput({ lockingScript: buyerLock, satoshis: change });
  await tx.sign();
  return {
    hex: tx.toHex(),
    txid: tx.id("hex"),
    fee,
    spent: [
      { txid: offer.input.txid, vout: offer.input.vout },
      ...picked.map((u) => ({ txid: u.txid, vout: u.vout })),
    ],
    changeSats: useChange ? change : 0,
    changeVout,
    buyerLockHex: buyerLock.toHex(),
  };
}

function memoScriptLen(parts: string[]): number {
  // OP_0 OP_RETURN + pushes (short memos)
  let n = 2;
  for (const p of parts) {
    const len = new TextEncoder().encode(p).length;
    n += (len <= 75 ? 1 : 2) + len;
  }
  return n;
}

function opReturnScript(parts: string[]): Script {
  const chunks: { op: number; data?: number[] }[] = [{ op: 0x00 }, { op: 0x6a }];
  for (const p of parts) {
    const bytes = Array.from(new TextEncoder().encode(p));
    chunks.push(bytes.length <= 75 ? { op: bytes.length, data: bytes } : { op: 0x4c, data: [bytes.length, ...bytes] });
  }
  return new Script(chunks);
}
