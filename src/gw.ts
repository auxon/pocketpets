// Unified game wallet: Yours (1Sat) when connected, else the built-in
// self-custody wallet. Callers never touch keys or payment plumbing.
import type { OneSatContext } from "@1sat/actions";
import type { Pet } from "./pets";
import { speciesOf } from "./pets";
import {
  ACTION_FEE_USD, ENTRY_USD, FOOD_REFILL_USD, MARKET_FEE_BPS, MINT_FEE_USD, PULL_USD, getBsvUsd, usdToSats,
} from "./chain";
import { anchorTip, collectFee, enterCup, mintPetNft, payMany, payoutWinner, petArtworkJpeg } from "./bsv";
import { fetchSpendable, inscriptionScript, p2pkhScript, resolveNftUtxo, sendBuilt } from "./embedded.ts";
import { broadcast } from "./embedded.ts";
import { recordPending } from "./pending.ts";
import { completeSwap, createSwapOffer, type SwapOffer } from "./atomic.ts";

export interface YoursW {
  kind: "yours";
  ctx: OneSatContext;
}
export interface EmbW {
  kind: "embedded";
  wif: string;
  address: string;
}
export type GW = YoursW | EmbW;

export interface MintOut {
  txid: string;
  origin: string;
  contentHash?: string;
  feeTxid: string;
  scriptHex?: string;
}

const bytesHashHex = async (bytes: Uint8Array): Promise<string> => {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Mint pet as NFT. Embedded does fee + inscription in ONE tx/signature. */
export async function gwMint(gw: GW, pet: Pet, feeAddress: string): Promise<MintOut> {
  if (gw.kind === "yours") {
    const { price } = await getBsvUsd();
    const feeSats = usdToSats(MINT_FEE_USD, price);
    const feeTxid = await collectFee(gw.ctx, feeAddress, feeSats, "mint");
    const r = await mintPetNft(gw.ctx, pet);
    return { ...r, feeTxid };
  }
  const art = petArtworkJpeg(pet);
  const contentHash = await bytesHashHex(art);
  const script = inscriptionScript(gw.address, "image/jpeg", art);
  const { price } = await getBsvUsd();
  const feeSats = usdToSats(MINT_FEE_USD, price);
  const utxos = await fetchSpendable(gw.address);
  const sp = speciesOf(pet);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [{ address: feeAddress, sats: feeSats }],
    opReturn: ["POCKETPETS-MINT", pet.uid, sp.id, contentHash.slice(0, 16)],
    inscription: { scriptHex: script.toHex() },
    changeAddress: gw.address,
  });
  return { txid, origin: `${txid}.0`, contentHash, feeTxid: txid, scriptHex: script.toHex() };
}

export async function gwAnchor(gw: GW, pot: string, feeAddr: string, tip: string): Promise<{ txid: string; feeSats: number }> {
  const { price } = await getBsvUsd();
  const feeSats = usdToSats(ACTION_FEE_USD, price);
  if (gw.kind === "yours") return { txid: await anchorTip(gw.ctx, pot, feeAddr, feeSats, tip), feeSats };
  const utxos = await fetchSpendable(gw.address);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [
      { address: pot, sats: 1 },
      { address: feeAddr, sats: feeSats },
    ],
    opReturn: ["POCKETPETS-ANCHOR", tip],
    changeAddress: gw.address,
  });
  return { txid, feeSats };
}

export async function gwEnter(
  gw: GW, pot: string, feeAddr: string, petUid: string, tip: string
): Promise<{ txid: string; entrySats: number; feeSats: number }> {
  const { price } = await getBsvUsd();
  const entrySats = usdToSats(ENTRY_USD, price);
  const feeSats = usdToSats(ACTION_FEE_USD, price);
  if (gw.kind === "yours") {
    return { txid: await enterCup(gw.ctx, pot, feeAddr, entrySats, feeSats, petUid, tip), entrySats, feeSats };
  }
  const utxos = await fetchSpendable(gw.address);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [
      { address: pot, sats: entrySats },
      { address: feeAddr, sats: feeSats },
    ],
    opReturn: ["POCKETPETS-ENTRY", petUid, tip],
    changeAddress: gw.address,
  });
  return { txid, entrySats, feeSats };
}

/** Food refill: $0.05 operator fee on-chain, bowl topped to full. */
export async function gwFoodRefill(
  gw: GW, feeAddress: string
): Promise<{ txid: string; refillSats: number }> {
  const { price } = await getBsvUsd();
  const refillSats = usdToSats(FOOD_REFILL_USD, price);
  if (gw.kind === "yours") {
    const feeTxid = await collectFee(gw.ctx, feeAddress, refillSats, "food");
    return { txid: feeTxid, refillSats };
  }
  const utxos = await fetchSpendable(gw.address);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [{ address: feeAddress, sats: refillSats }],
    opReturn: ["POCKETPETS-FOOD"],
    changeAddress: gw.address,
  });
  return { txid, refillSats };
}

/** Stake payment to the pot for a PvP fight (stake + $0.02 action fee, one signature). */
export async function gwStake(
  gw: GW, potAddress: string, feeAddress: string, amountSats: number, matchLabel: string
): Promise<{ txid: string; feeSats: number }> {
  const { price } = await getBsvUsd();
  const feeSats = usdToSats(ACTION_FEE_USD, price);
  if (gw.kind === "yours") {
    const txid = await payMany(gw.ctx, [
      { address: potAddress, satoshis: amountSats, data: ["POCKETPETS-STAKE", matchLabel] },
      { address: feeAddress, satoshis: feeSats, data: ["POCKETPETS-FEE", "stake"] },
    ], "Stake payment failed");
    return { txid, feeSats };
  }
  const utxos = await fetchSpendable(gw.address);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [
      { address: potAddress, sats: amountSats },
      { address: feeAddress, sats: feeSats },
    ],
    opReturn: ["POCKETPETS-STAKE", matchLabel],
    changeAddress: gw.address,
  });
  return { txid, feeSats };
}

/** Gacha pull: $0.10 operator fee on-chain, pet uid in the memo. */
export async function gwPull(
  gw: GW, feeAddress: string, petUid: string
): Promise<{ txid: string; pullSats: number }> {
  const { price } = await getBsvUsd();
  const pullSats = usdToSats(PULL_USD, price);
  if (gw.kind === "yours") {
    const feeTxid = await collectFee(gw.ctx, feeAddress, pullSats, "pull");
    return { txid: feeTxid, pullSats };
  }
  const utxos = await fetchSpendable(gw.address);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [{ address: feeAddress, sats: pullSats }],
    opReturn: ["POCKETPETS-PULL", petUid],
    changeAddress: gw.address,
  });
  return { txid, pullSats };
}

export async function gwPayout(  gw: GW, addr: string, sats: number, season: string, uid: string
): Promise<string> {
  if (gw.kind === "yours") return payoutWinner(gw.ctx, addr, sats, season, uid);
  const utxos = await fetchSpendable(gw.address);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [{ address: addr, sats }],
    opReturn: ["POCKETPETS-PAYOUT", season, uid],
    changeAddress: gw.address,
  });
  return txid;
}

/** Buy a listed NFT: price to seller + 2% market fee, one signature. */
export async function gwMarketBuy(
  gw: GW, seller: string, priceSats: number, feeAddr: string, origin: string
): Promise<{ txid: string; feeSats: number }> {
  const feeSats = Math.max(1, Math.floor((priceSats * MARKET_FEE_BPS) / 10000));
  if (gw.kind === "yours") {
    const { sendBsv } = await import("@1sat/actions");
    const res = await sendBsv.execute(gw.ctx, {
      requests: [
        { address: seller, satoshis: priceSats, data: ["POCKETPETS-BUY", origin] },
        { address: feeAddr, satoshis: feeSats, data: ["POCKETPETS-FEE", "market"] },
      ],
    });
    if (res.error || !res.txid) throw new Error(res.error || "Payment failed");
    return { txid: res.txid, feeSats };
  }
  const utxos = await fetchSpendable(gw.address);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [
      { address: seller, sats: priceSats },
      { address: feeAddr, sats: feeSats },
    ],
    opReturn: ["POCKETPETS-BUY", origin],
    changeAddress: gw.address,
  });
  return { txid, feeSats };
}

/** Atomic list: pre-sign the swap. NFT never leaves the seller's wallet. */
export async function gwAtomicList(
  gw: EmbW, pet: Pet, priceSats: number
): Promise<SwapOffer & { seller: string }> {
  if (!pet.nft?.scriptHex) throw new Error("No local inscription data");
  const [originTx] = pet.nft.origin.split(".");
  const { utxo: nftUtxo, unconfirmed } = await resolveNftUtxo(gw.address, originTx, pet.nft.vout ?? 0);
  const utxoForOffer = { txid: originTx, vout: pet.nft.vout ?? 0, scriptHex: pet.nft.scriptHex };
  void nftUtxo;
  const offer = await createSwapOffer({
    wif: gw.wif,
    utxo: utxoForOffer,
    sellerAddress: gw.address,
    priceSats,
  });
  if (unconfirmed) offer.unconfirmedParent = true;
  return { ...offer, seller: gw.address };
}

/** Atomic buy: complete the swap, broadcast, return txid (settlement included). */
export async function gwAtomicBuy(
  gw: EmbW, listing: { origin: string; price_sats: number; seller_unlock: string; pay_script: string },
  feeAddr: string
): Promise<{ txid: string; feeSats: number; nftVout: number; nftScriptHex: string }> {
  const feeSats = Math.max(1, Math.floor((listing.price_sats * MARKET_FEE_BPS) / 10000));
  const utxos = await fetchSpendable(gw.address);
  const [originTx] = listing.origin.split(".");
  const done = await completeSwap({
    offer: {
      input: { txid: originTx, vout: 0, scriptHex: "", sequence: 0xffffffff },
      unlockHex: listing.seller_unlock,
      payScriptHex: listing.pay_script,
      priceSats: listing.price_sats,
      version: 2,
      lockTime: 0,
    },
    buyerWif: gw.wif,
    buyerAddress: gw.address,
    buyerUtxos: utxos,
    feeAddress: feeAddr,
    feeSats,
    memo: ["POCKETPETS-BUY", listing.origin],
  });
  const txid = await broadcast(done.hex);
  recordPending({
    txid,
    spent: done.spent,
    fresh: done.changeVout >= 0
      ? [{ txid, vout: done.changeVout, value: done.changeSats, address: gw.address }]
      : [],
    ts: Date.now(),
  });
  // NFT output is always vout 1 in our swap template (pay, nft, fee, memo, change)
  return { txid, feeSats, nftVout: 1, nftScriptHex: p2pkhScript(gw.address).toHex() };
}

/** Transfer an embedded-held NFT. Returns new location (plain P2PKH output). */
export async function gwTransferNft(gw: EmbW, pet: Pet, toAddress: string): Promise<{ txid: string; vout: number; scriptHex: string }> {
  if (!pet.nft?.scriptHex) throw new Error("No local inscription data (Yours mints transfer in-wallet)");
  const [curTx] = pet.nft.txid.split(".");
  const curVout = pet.nft.vout ?? 0;
  const { utxo: insc } = await resolveNftUtxo(gw.address, curTx, curVout);
  const utxos = await fetchSpendable(gw.address);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos: [{ txid: insc.txid, vout: insc.vout, value: 1, height: insc.height, scriptHex: pet.nft.scriptHex }, ...utxos.filter((u) => !(u.txid === insc.txid && u.vout === insc.vout))],
    payments: [{ address: toAddress, sats: 1 }],
    opReturn: ["POCKETPETS-TRANSFER", pet.uid],
    changeAddress: gw.address,
  });
  return { txid, vout: 0, scriptHex: p2pkhScript(toAddress).toHex() };
}
