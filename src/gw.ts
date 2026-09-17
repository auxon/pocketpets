// Unified game wallet: Yours (1Sat) when connected, else the built-in
// self-custody wallet. Callers never touch keys or payment plumbing.
import type { OneSatContext } from "@1sat/actions";
import type { Pet } from "./pets.ts";
import { speciesOf } from "./pets.ts";
import {
  ACTION_FEE_SATS, CUP_ENTRY_SATS, FOOD_REFILL_SATS, MARKET_FEE_BPS, MINT_FEE_SATS, PULL_SATS,
} from "./chain.ts";
import { anchorTip, collectFee, enterCup, mintPetNft, payMany, payoutWinner, petArtworkJpeg } from "./bsv.ts";
import { fetchSpendable, inscriptionScript, p2pkhScript, resolveNftUtxo, sendBuilt } from "./embedded.ts";
import { broadcast } from "./embedded.ts";
import { osBsv } from "./oswallet.ts";
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
export interface OsW {
  kind: "os";
  address: string;
}
export type GW = YoursW | EmbW | OsW;

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
    const feeTxid = await collectFee(gw.ctx, feeAddress, MINT_FEE_SATS, "mint");
    const r = await mintPetNft(gw.ctx, pet);
    return { ...r, feeTxid };
  }
  if (gw.kind === "os") {
    const art = petArtworkJpeg(pet);
    const contentHash = await bytesHashHex(art);
    const dataHex = [...art].map((b) => b.toString(16).padStart(2, "0")).join("");
    const sp = speciesOf(pet);
    const r = await osBsv().inscribe(dataHex, "image/jpeg", undefined,
      { to: feeAddress, sats: MINT_FEE_SATS },
      ["POCKETPETS-MINT", pet.uid, sp.id, contentHash.slice(0, 16)]);
    const script = inscriptionScript(gw.address, "image/jpeg", art);
    return { txid: r.txid, origin: `${r.txid}.0`, contentHash, feeTxid: r.txid, scriptHex: script.toHex() };
  }
  const art = petArtworkJpeg(pet);
  const contentHash = await bytesHashHex(art);
  const script = inscriptionScript(gw.address, "image/jpeg", art);
  const utxos = await fetchSpendable(gw.address);
  const sp = speciesOf(pet);
  const { txid } = await sendBuilt({
    wif: gw.wif,
    utxos,
    payments: [{ address: feeAddress, sats: MINT_FEE_SATS }],
    opReturn: ["POCKETPETS-MINT", pet.uid, sp.id, contentHash.slice(0, 16)],
    inscription: { scriptHex: script.toHex() },
    changeAddress: gw.address,
  });
  return { txid, origin: `${txid}.0`, contentHash, feeTxid: txid, scriptHex: script.toHex() };
}

export async function gwAnchor(gw: GW, pot: string, feeAddr: string, tip: string): Promise<{ txid: string; feeSats: number }> {
  const feeSats = ACTION_FEE_SATS;
  if (gw.kind === "yours") return { txid: await anchorTip(gw.ctx, pot, feeAddr, feeSats, tip), feeSats };
  if (gw.kind === "os") {
    const { txid } = await osBsv().spend(
      [{ to: pot, sats: 1 }, { to: feeAddr, sats: feeSats }],
      ["POCKETPETS-ANCHOR", tip]);
    return { txid, feeSats };
  }
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
  const entrySats = CUP_ENTRY_SATS;
  const feeSats = ACTION_FEE_SATS;
  if (gw.kind === "yours") {
    return { txid: await enterCup(gw.ctx, pot, feeAddr, entrySats, feeSats, petUid, tip), entrySats, feeSats };
  }
  if (gw.kind === "os") {
    const { txid } = await osBsv().spend(
      [{ to: pot, sats: entrySats }, { to: feeAddr, sats: feeSats }],
      ["POCKETPETS-ENTRY", petUid, tip]);
    return { txid, entrySats, feeSats };
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

export async function gwFoodRefill(
  gw: GW, feeAddress: string
): Promise<{ txid: string; refillSats: number }> {
  const refillSats = FOOD_REFILL_SATS;
  if (gw.kind === "yours") {
    const feeTxid = await collectFee(gw.ctx, feeAddress, refillSats, "food");
    return { txid: feeTxid, refillSats };
  }
  if (gw.kind === "os") {
    const { txid } = await osBsv().spend(
      [{ to: feeAddress, sats: refillSats }],
      ["POCKETPETS-FOOD"]);
    return { txid, refillSats };
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

export async function gwStake(
  gw: GW, potAddress: string, feeAddress: string, amountSats: number, matchLabel: string
): Promise<{ txid: string; feeSats: number }> {
  const feeSats = ACTION_FEE_SATS;
  if (gw.kind === "yours") {
    const txid = await payMany(gw.ctx, [
      { address: potAddress, satoshis: amountSats, data: ["POCKETPETS-STAKE", matchLabel] },
      { address: feeAddress, satoshis: feeSats, data: ["POCKETPETS-FEE", "stake"] },
    ], "Stake payment failed");
    return { txid, feeSats };
  }
  if (gw.kind === "os") {
    const { txid } = await osBsv().spend(
      [{ to: potAddress, sats: amountSats }, { to: feeAddress, sats: feeSats }],
      ["POCKETPETS-STAKE", matchLabel]);
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

export async function gwPull(
  gw: GW, feeAddress: string, petUid: string
): Promise<{ txid: string; pullSats: number }> {
  const pullSats = PULL_SATS;
  if (gw.kind === "yours") {
    const feeTxid = await collectFee(gw.ctx, feeAddress, pullSats, "pull");
    return { txid: feeTxid, pullSats };
  }
  if (gw.kind === "os") {
    const { txid } = await osBsv().spend(
      [{ to: feeAddress, sats: pullSats }],
      ["POCKETPETS-PULL", petUid]);
    return { txid, pullSats };
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
  if (gw.kind === "os") {
    const { txid } = await osBsv().spend(
      [{ to: addr, sats }],
      ["POCKETPETS-PAYOUT", season, uid]);
    return txid;
  }
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
  if (gw.kind === "os") {
    // NOTE: direct (non-atomic) buys move no NFT — same semantics as embedded.
    const { txid } = await osBsv().spend(
      [{ to: seller, sats: priceSats }, { to: feeAddr, sats: feeSats }],
      ["POCKETPETS-BUY", origin]);
    return { txid, feeSats };
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
  gw: EmbW | OsW, pet: Pet, priceSats: number
): Promise<SwapOffer & { seller: string }> {
  if (gw.kind === "os") {
    if (!pet.nft) throw new Error("Pet is not minted");
    const [originTx] = pet.nft.origin.split(".");
    // liveness preflight (read-only); the daemon re-resolves chain truth at sign time
    const { unconfirmed } = await resolveNftUtxo(gw.address, originTx, pet.nft.vout ?? 0);
    const offer = await osBsv().signSwapOffer(originTx, pet.nft.vout ?? 0, priceSats);
    if (unconfirmed) offer.unconfirmedParent = true;
    return { ...offer, seller: gw.address };
  }
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
  gw: EmbW | OsW, listing: { origin: string; price_sats: number; seller_unlock: string; pay_script: string },
  feeAddr: string
): Promise<{ txid: string; feeSats: number; nftVout: number; nftScriptHex: string }> {
  const feeSats = Math.max(1, Math.floor((listing.price_sats * MARKET_FEE_BPS) / 10000));
  if (gw.kind === "os") {
    const [originTx] = listing.origin.split(".");
    const r = await osBsv().completeSwap({
      input: { txid: originTx, vout: 0, scriptHex: "", sequence: 0xffffffff },
      unlockHex: listing.seller_unlock,
      payScriptHex: listing.pay_script,
      priceSats: listing.price_sats,
      version: 2,
      lockTime: 0,
    }, { to: feeAddr, sats: feeSats }, ["POCKETPETS-BUY", listing.origin]);
    return { txid: r.txid, feeSats, nftVout: 1, nftScriptHex: p2pkhScript(gw.address).toHex() };
  }
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
export async function gwTransferNft(gw: EmbW | OsW, pet: Pet, toAddress: string): Promise<{ txid: string; vout: number; scriptHex: string }> {
  if (gw.kind === "os") {
    if (!pet.nft) throw new Error("Pet is not minted");
    const [curTx] = pet.nft.txid.split(".");
    const r = await osBsv().transferNft(curTx, pet.nft.vout ?? 0, toAddress, ["POCKETPETS-TRANSFER", pet.uid]);
    return { txid: r.txid, vout: 0, scriptHex: p2pkhScript(toAddress).toHex() };
  }
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
