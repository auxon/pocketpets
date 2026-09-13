// Shared NFT order book (gatekeep worker + D1). No auth keys —
// listings are anchored by on-chain escrow/payment txs verified server-side.
import { PROXY } from "./embedded";

export interface MarketListing {
  origin: string;
  nickname: string;
  species: string;
  emoji: string;
  rarity: string;
  level: number;
  price_sats: number;
  seller: string;
  seller_handle: string;
  escrow_txid: string;
  escrow_address: string;
  buy_txid: string | null;
  buyer_handle: string | null;
  transfer_txid: string | null;
  status: "active" | "paid" | "sold" | "cancelled";
  seller_unlock: string | null; // atomic swap pre-signature (no escrow)
  pay_script: string | null;
  created_at: number;
  updated_at: number;
}

async function req(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${PROXY}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string; debug?: unknown } & Record<string, unknown>;
  if (!res.ok) {
    const err = new Error(String(j.error ?? `request failed (${res.status})`));
    (err as Error & { code?: string; debug?: unknown }).code = j.code;
    (err as Error & { code?: string; debug?: unknown }).debug = j.debug;
    throw err;
  }
  return j;
}

export async function listMarket(): Promise<MarketListing[]> {
  const j = (await req("/v1/market")) as { listings: MarketListing[] };
  return j.listings ?? [];
}

export async function fetchRecentSales(): Promise<MarketListing[]> {
  const j = (await req("/v1/market/recent")) as { listings: MarketListing[] };
  return j.listings ?? [];
}

/** Single listing in any status (sold history, deep links). Null when unknown. */
export async function fetchListing(origin: string): Promise<MarketListing | null> {
  try {
    const j = (await req(`/v1/market/listing/${origin}`)) as { listing: MarketListing };
    return j.listing ?? null;
  } catch {
    return null;
  }
}

export interface NewListing {
  origin: string;
  nickname: string;
  species: string;
  emoji: string;
  rarity: string;
  level: number;
  priceSats: number;
  seller: string;
  sellerHandle: string;
  escrowTxid: string;
  escrowAddress: string;
  sellerUnlock?: string; // atomic path
  payScript?: string; // atomic path
}

export async function postListing(l: NewListing): Promise<void> {
  await req("/v1/market/list", l);
}

export async function markBought(origin: string, buyTxid: string, buyerHandle: string): Promise<void> {
  await req("/v1/market/buy", { origin, buyTxid, buyerHandle });
}

export async function markSettled(origin: string, transferTxid: string): Promise<void> {
  await req("/v1/market/settle", { origin, transferTxid });
}

export async function cancelListing(origin: string, seller: string): Promise<void> {
  await req("/v1/market/cancel", { origin, seller });
}

export interface TxVout {
  value?: number;
  n?: number;
  scriptPubKey?: { addresses?: string[] };
}

export async function fetchTxDetails(txid: string): Promise<{ vin?: Array<{ txid?: string; vout?: number }>; vout?: TxVout[] }> {
  const res = await fetch(`${PROXY}/v1/tx/${txid}`);
  if (!res.ok) throw new Error("tx not found on-chain yet");
  return (await res.json()) as { vin?: Array<{ txid?: string; vout?: number }>; vout?: TxVout[] };
}
