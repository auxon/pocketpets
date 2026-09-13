import { useMemo } from "react";
import { createContext, inscribe, sendBsv, type OneSatContext } from "@1sat/actions";
import { OneSatServices } from "@1sat/client";
import { useWallet } from "@1sat/react";
import type { Pet } from "./pets";
import { speciesOf, stats } from "./pets";

const services = new OneSatServices("main");

export function useOneSatCtx(): OneSatContext | null {
  const { wallet, status } = useWallet();
  return useMemo(() => {
    if (status !== "connected" || !wallet) return null;
    return createContext(wallet, { chain: "main", services });
  }, [wallet, status]);
}

export function useBsv() {
  const { status, connect, disconnect, identityKey } = useWallet();
  const ctx = useOneSatCtx();
  return { status, connect, disconnect, identityKey, ctx, connected: status === "connected" && !!ctx };
}

function dataUrlToBase64(dataUrl: string): { base64: string; contentType: string } {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error("Invalid image data URL");
  return { contentType: m[1] || "image/png", base64: m[2]! };
}

/** Paint the shareable pet card onto a 640x360-style context. */
function paintCard(g: CanvasRenderingContext2D, W: number, H: number, pet: Pet): void {
  const s = W / 640;
  const sp = speciesOf(pet);
  const st = stats(pet);
  const stars = { common: "★", rare: "★★", epic: "★★★", legendary: "★★★★" }[sp.rarity];
  g.fillStyle = "#171321";
  g.fillRect(0, 0, W, H);
  g.strokeStyle = sp.color;
  g.lineWidth = 10 * s;
  g.strokeRect(5 * s, 5 * s, W - 10 * s, H - 10 * s);
  g.fillStyle = sp.color;
  g.font = `bold ${22 * s}px system-ui`;
  g.fillText(`${stars} ${sp.rarity.toUpperCase()}`, 24 * s, 40 * s);
  g.fillStyle = sp.color;
  g.font = `${150 * s}px serif`;
  g.fillText(sp.emoji, 60 * s, 230 * s);
  g.fillStyle = "#fff";
  g.font = `bold ${44 * s}px system-ui`;
  g.fillText(pet.nickname.slice(0, 18), 250 * s, 120 * s);
  g.font = `${28 * s}px system-ui`;
  g.fillStyle = "#c4b5fd";
  g.fillText(`${sp.name} · ${sp.rarity} · Lv ${pet.level}`, 250 * s, 165 * s);
  g.fillStyle = "#a5b4fc";
  g.fillText(`ATK ${st.atk}  DEF ${st.def}  SPD ${st.spd}`, 250 * s, 210 * s);
  g.fillStyle = "#8b839e";
  g.font = `italic ${24 * s}px system-ui`;
  g.fillText(`"${sp.blurb}"`, 250 * s, 248 * s);
  g.fillStyle = "#6b7280";
  g.font = `${22 * s}px system-ui`;
  g.fillText("Pocket Pets · on BSV", 250 * s, 292 * s);
}

/** Draw the shareable pet card; used for PNG download AND NFT artwork. */
export function drawPetCard(pet: Pet): string {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 360;
  paintCard(c.getContext("2d")!, 640, 360, pet);
  return c.toDataURL("image/png");
}

/** Compact JPEG artwork bytes for on-chain inscription (embedded wallet). */
export function petArtworkJpeg(pet: Pet, width = 512): Uint8Array {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = Math.round((width * 9) / 16);
  paintCard(c.getContext("2d")!, c.width, c.height, pet);
  const url = c.toDataURL("image/jpeg", 0.82);
  const b64 = url.split(",", 2)[1] ?? "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface MintResult {
  txid: string;
  origin: string;
  contentHash?: string;
}

/** Mint the pet as a 1Sat Ordinal NFT owned by the connected wallet. */
export async function mintPetNft(ctx: OneSatContext, pet: Pet): Promise<MintResult> {
  const sp = speciesOf(pet);
  const st = stats(pet);
  const { base64, contentType } = dataUrlToBase64(drawPetCard(pet));
  const res = await inscribe.execute(ctx, {
    base64Content: base64,
    contentType,
    map: {
      app: "pocketpets",
      type: "pet",
      uid: pet.uid,
      species: sp.id,
      name: pet.nickname.slice(0, 64),
      rarity: sp.rarity,
      level: String(pet.level),
      atk: String(st.atk),
      def: String(st.def),
      spd: String(st.spd),
      ...(pet.evolvedFrom && pet.evolvedFrom.length > 0 ? { lineage: pet.evolvedFrom.join(">") } : {}),
    },
  });
  if (res.error || !res.txid) throw new Error(res.error || "Inscribe returned no txid");
  return { txid: res.txid, origin: `${res.txid}.0`, contentHash: res.contentHash };
}

/** Generic multi-output BSV payment for Yours wallets (one signature). */
export async function payMany(
  ctx: OneSatContext,
  requests: Array<{ address: string; satoshis: number; data?: string[] }>,
  errLabel: string
): Promise<string> {
  const res = await sendBsv.execute(ctx, { requests });
  if (res.error || !res.txid) throw new Error(res.error || errLabel);
  return res.txid;
}
export async function collectFee(
  ctx: OneSatContext,
  feeAddress: string,
  feeSats: number,
  memo: string
): Promise<string> {
  const res = await sendBsv.execute(ctx, {
    requests: [{ address: feeAddress, satoshis: feeSats, data: ["POCKETPETS-FEE", memo] }],
  });
  if (res.error || !res.txid) throw new Error(res.error || "Fee payment failed");
  return res.txid;
}

/**
 * Anchor the ledger tip hash on-chain.
 * Single wallet signature, two outputs: 1 sat to pot (+memo) + $0.02 fee.
 */
export async function anchorTip(
  ctx: OneSatContext,
  potAddress: string,
  feeAddress: string,
  feeSats: number,
  tipHash: string
): Promise<string> {
  const res = await sendBsv.execute(ctx, {
    requests: [
      { address: potAddress, satoshis: 1, data: ["POCKETPETS-ANCHOR", tipHash] },
      { address: feeAddress, satoshis: feeSats, data: ["POCKETPETS-FEE", "anchor"] },
    ],
  });
  if (res.error || !res.txid) throw new Error(res.error || "Anchor payment failed");
  return res.txid;
}

/**
 * Pay the cup entry fee to the pot with an on-chain entry memo.
 * Single wallet signature: stake to pot + $0.02 fee.
 */
export async function enterCup(
  ctx: OneSatContext,
  potAddress: string,
  feeAddress: string,
  entrySats: number,
  feeSats: number,
  petUid: string,
  tipHash: string
): Promise<string> {
  const res = await sendBsv.execute(ctx, {
    requests: [
      { address: potAddress, satoshis: entrySats, data: ["POCKETPETS-ENTRY", petUid, tipHash] },
      { address: feeAddress, satoshis: feeSats, data: ["POCKETPETS-FEE", "entry"] },
    ],
  });
  if (res.error || !res.txid) throw new Error(res.error || "Entry payment failed");
  return res.txid;
}

/** Operator pays the winner (same primitive, explicit). */
export async function payoutWinner(
  ctx: OneSatContext,
  winnerAddress: string,
  amountSats: number,
  season: string,
  winnerUid: string
): Promise<string> {
  const res = await sendBsv.execute(ctx, {
    requests: [{ address: winnerAddress, satoshis: amountSats, data: ["POCKETPETS-PAYOUT", season, winnerUid] }],
  });
  if (res.error || !res.txid) throw new Error(res.error || "Payout failed");
  return res.txid;
}
