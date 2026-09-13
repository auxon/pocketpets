import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey, Script, Spend, Transaction } from "@bsv/sdk";
import { inscriptionScript, p2pkhScript } from "../src/embedded.ts";
import { completeSwap, createSwapOffer } from "../src/atomic.ts";

/** Real script-interpreter validation per input (no chain/fees involved). */
async function spendsValid(tx, sources) {
  for (let i = 0; i < tx.inputs.length; i++) {
    const s = sources[i];
    const spend = new Spend({
      sourceTXID: s.txid,
      sourceOutputIndex: s.vout,
      sourceSatoshis: s.satoshis,
      lockingScript: s.script,
      unlockingScript: tx.inputs[i].unlockingScript,
      transactionVersion: tx.version,
      lockTime: tx.lockTime,
      inputIndex: i,
      inputSequence: tx.inputs[i].sequence ?? 0xffffffff,
      outputs: tx.outputs,
      otherInputs: tx.inputs.filter((_, j) => j !== i),
    });
    try {
      if (!(await spend.validate())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function keys() {
  const priv = PrivateKey.fromRandom();
  return { wif: priv.toWif(), address: priv.toPublicKey().toAddress() };
}

async function setup() {
  const seller = keys();
  const buyer = keys();
  const feeAddr = keys().address;
  const insc = inscriptionScript(seller.address, "image/jpeg", new TextEncoder().encode("pet-art"));
  const sellerSrc = new Transaction();
  sellerSrc.addOutput({ lockingScript: insc, satoshis: 1 });
  const buyerSrc = new Transaction();
  buyerSrc.addOutput({ lockingScript: p2pkhScript(buyer.address), satoshis: 5_000_000 });
  return { seller, buyer, feeAddr, insc, sellerSrc, buyerSrc };
}

test("seller pre-signature uses SINGLE|ANYONECANPAY", async () => {
  const { seller, sellerSrc } = await setup();
  const offer = await createSwapOffer({
    wif: seller.wif,
    utxo: { txid: sellerSrc.id("hex"), vout: 0, scriptHex: sellerSrc.outputs[0].lockingScript.toHex() },
    sellerAddress: seller.address,
    priceSats: 100_000,
  });
  const chunks = Script.fromHex(offer.unlockHex).chunks;
  const sig = chunks[0]?.data;
  assert.ok(sig && sig.length > 8);
  assert.equal(sig[sig.length - 1], 0xc3, "sighash SINGLE|ANYONECANPAY|FORKID");
  assert.equal(offer.input.sequence, 0xffffffff);
});

test("full atomic swap verifies offline; tampered payment fails", async () => {
  const { seller, buyer, feeAddr, sellerSrc, buyerSrc } = await setup();
  const utxo = { txid: sellerSrc.id("hex"), vout: 0, scriptHex: sellerSrc.outputs[0].lockingScript.toHex() };
  const offer = await createSwapOffer({ wif: seller.wif, utxo, sellerAddress: seller.address, priceSats: 100_000 });
  const done = await completeSwap({
    offer,
    buyerWif: buyer.wif,
    buyerAddress: buyer.address,
    buyerUtxos: [{ txid: buyerSrc.id("hex"), vout: 0, value: 5_000_000 }],
    feeAddress: feeAddr,
    feeSats: 2000,
    memo: ["POCKETPETS-BUY", "origin.test"],
  });
  const tx = Transaction.fromHex(done.hex);
  assert.equal(tx.outputs[0]?.satoshis, 100_000);
  assert.equal(tx.outputs[0]?.lockingScript?.toHex(), offer.payScriptHex);
  assert.equal(tx.outputs[1]?.satoshis, 1);
  const outSum = tx.outputs.reduce((a, o) => a + (o.satoshis ?? 0), 0);
  assert.equal(outSum + done.fee, 5_000_001);

  // link sources for script verification
  const sources = [
    { txid: utxo.txid, vout: 0, satoshis: 1, script: Script.fromHex(utxo.scriptHex) },
    { txid: buyerSrc.id("hex"), vout: 0, satoshis: 5_000_000, script: p2pkhScript(buyer.address) },
  ];
  assert.ok(await spendsValid(tx, sources), "honest swap verifies");

  // tamper: +1 sat to seller payment breaks the SINGLE commitment
  const evil = Transaction.fromHex(done.hex);
  evil.outputs[0].satoshis = 100_001;
  assert.equal(await spendsValid(evil, sources), false, "tampered payment must not verify");

  // tamper 2: redirect NFT output — seller input still valid (not its concern),
  // but buyer input commits ALL outputs, so the full tx no longer verifies
  const evil2 = Transaction.fromHex(done.hex);
  evil2.outputs[1] = { lockingScript: p2pkhScript(seller.address), satoshis: 1 };
  assert.equal(await spendsValid(evil2, sources), false, "redirected NFT must not verify");
});

test("buyer cannot drop the NFT output (sats would not balance)", async () => {
  const { seller, buyer, feeAddr, sellerSrc, buyerSrc } = await setup();
  const utxo = { txid: sellerSrc.id("hex"), vout: 0, scriptHex: sellerSrc.outputs[0].lockingScript.toHex() };
  const offer = await createSwapOffer({ wif: seller.wif, utxo, sellerAddress: seller.address, priceSats: 100_000 });
  const done = await completeSwap({
    offer, buyerWif: buyer.wif, buyerAddress: buyer.address,
    buyerUtxos: [{ txid: buyerSrc.id("hex"), vout: 0, value: 5_000_000 }],
    feeAddress: feeAddr, feeSats: 2000, memo: ["x"],
  });
  // every completed swap carries the 1-sat NFT output to the buyer
  const ones = Transaction.fromHex(done.hex).outputs.filter((o) => o.satoshis === 1);
  assert.equal(ones.length, 1);
});

test("wrong template version is rejected", async () => {
  const { seller, sellerSrc } = await setup();
  const utxo = { txid: sellerSrc.id("hex"), vout: 0, scriptHex: sellerSrc.outputs[0].lockingScript.toHex() };
  const offer = await createSwapOffer({ wif: seller.wif, utxo, sellerAddress: seller.address, priceSats: 100 });
  const buyer = keys();
  await assert.rejects(
    completeSwap({
      offer: { ...offer, version: 1 },
      buyerWif: buyer.wif, buyerAddress: buyer.address,
      buyerUtxos: [], feeAddress: buyer.address, feeSats: 1, memo: [],
    }),
    /template mismatch/
  );
});

test("resale shape: seller input at vout 1 verifies end to end", async () => {
  const { PrivateKey } = await import("@bsv/sdk");
  const { p2pkhScript } = await import("../src/embedded.ts");
  // seller previously bought the NFT: it sits in a plain P2PKH output at vout 1
  const seller = keys();
  const prev = new Transaction();
  prev.addOutput({ lockingScript: p2pkhScript("1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4"), satoshis: 500 });
  const { address: sellerAddr } = seller;
  void sellerAddr;
  const sellerKey = PrivateKey.fromRandom();
  const sellerA = sellerKey.toPublicKey().toAddress();
  prev.addOutput({ lockingScript: p2pkhScript(sellerA), satoshis: 1 });
  const prevId = prev.id("hex");
  const sellerWif = sellerKey.toWif();
  const offer = await createSwapOffer({
    wif: sellerWif,
    utxo: { txid: prevId, vout: 1, scriptHex: p2pkhScript(sellerA).toHex() },
    sellerAddress: sellerA,
    priceSats: 777,
  });
  assert.equal(offer.input.vout, 1);
  const buyer = keys();
  const buyerSrc = new Transaction();
  buyerSrc.addOutput({ lockingScript: p2pkhScript(buyer.address), satoshis: 1_000_000 });
  const done = await completeSwap({
    offer,
    buyerWif: buyer.wif,
    buyerAddress: buyer.address,
    buyerUtxos: [{ txid: buyerSrc.id("hex"), vout: 0, value: 1_000_000 }],
    feeAddress: buyer.address,
    feeSats: 100,
    memo: ["POCKETPETS-BUY", "resale.test"],
  });
  const tx = Transaction.fromHex(done.hex);
  assert.equal(tx.outputs[0]?.satoshis, 777);
  assert.equal(tx.outputs[1]?.satoshis, 1);
  const sources = [
    { txid: prevId, vout: 1, satoshis: 1, script: p2pkhScript(sellerA) },
    { txid: buyerSrc.id("hex"), vout: 0, satoshis: 1_000_000, script: p2pkhScript(buyer.address) },
  ];
  assert.ok(await spendsValid(tx, sources), "resale-shaped swap verifies");
});
