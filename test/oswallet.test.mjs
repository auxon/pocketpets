import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { __resetOsSession, ensureOsAddress, isOsWallet, osBsv, osSession } from "../src/oswallet.ts";

async function loadGameWallet() {
  const bsvUrl = new URL("../src/bsv.ts", import.meta.url).href;
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url === bsvUrl) return {
        format: "module",
        shortCircuit: true,
        source: `
          const unexpected = () => { throw new Error("Unexpected non-OS wallet call"); };
          export const anchorTip = unexpected, collectFee = unexpected, enterCup = unexpected,
            mintPetNft = unexpected, payMany = unexpected, payoutWinner = unexpected;
          export const petArtworkJpeg = () => new Uint8Array([255, 216, 255, 217]);
        `,
      };
      return nextLoad(url, context);
    },
  });
  try {
    return await import("../src/gw.ts");
  } finally {
    hooks.deregister();
  }
}

function stubWindow(methods) {
  globalThis.window = { bsv: { isBSVOS: true, ...methods } };
}

function clearWindow() {
  delete globalThis.window;
  __resetOsSession();
}

test("os detection, accessor guard, and session cache", async () => {
  clearWindow();
  assert.equal(isOsWallet(), false);
  assert.equal(osSession(), null);
  assert.throws(() => osBsv(), /runner/);
  stubWindow({ getBalance: async () => ({ address: "1abc", confirmed: 5, unconfirmed: 0 }) });
  try {
    assert.equal(isOsWallet(), true);
    assert.equal(osSession(), null);
    assert.equal(await ensureOsAddress(), "1abc");
    assert.deepEqual(osSession(), { address: "1abc" });
    globalThis.window = { bsv: { isBSVOS: false } };
    assert.equal(isOsWallet(), false);
    assert.throws(() => osBsv(), /runner/);
  } finally {
    clearWindow();
  }
});

test("game wallet sends fixed-sat OS payments without fetching rates", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("Network disabled in payment tests");
  };
  const calls = [];
  const txid = "a".repeat(64);
  const gw = { kind: "os", address: "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4" };
  stubWindow({
    spend: async (...args) => { calls.push(args); return { txid, fee: 321 }; },
    inscribe: async (...args) => { calls.push(args); return { txid, fee: 321 }; },
    completeSwap: async (...args) => { calls.push(args); return { txid, fee: 321 }; },
  });
  try {
    const { gwPull, gwFoodRefill, gwEnter, gwAnchor, gwStake, gwMint, gwMarketBuy, gwAtomicBuy } = await loadGameWallet();
    assert.deepEqual(await gwPull(gw, "fee", "pet"), { txid, pullSats: 1 });
    assert.deepEqual(calls.pop(), [[{ to: "fee", sats: 1 }], ["POCKETPETS-PULL", "pet"]]);
    assert.deepEqual(await gwFoodRefill(gw, "fee"), { txid, refillSats: 1 });
    assert.deepEqual(calls.pop(), [[{ to: "fee", sats: 1 }], ["POCKETPETS-FOOD"]]);
    assert.deepEqual(await gwEnter(gw, "pot", "fee", "pet", "tip"), { txid, entrySats: 1, feeSats: 1 });
    assert.deepEqual(calls.pop(), [[{ to: "pot", sats: 1 }, { to: "fee", sats: 1 }], ["POCKETPETS-ENTRY", "pet", "tip"]]);
    assert.deepEqual(await gwAnchor(gw, "pot", "fee", "tip"), { txid, feeSats: 1 });
    assert.deepEqual(calls.pop(), [[{ to: "pot", sats: 1 }, { to: "fee", sats: 1 }], ["POCKETPETS-ANCHOR", "tip"]]);
    for (const stake of [200000, 400000, 1000000]) {
      assert.deepEqual(await gwStake(gw, "pot", "fee", stake, "match"), { txid, feeSats: 1 });
      assert.deepEqual(calls.pop(), [[{ to: "pot", sats: stake }, { to: "fee", sats: 1 }], ["POCKETPETS-STAKE", "match"]]);
    }
    const mint = await gwMint(gw, { uid: "pet", speciesId: "mochi" }, "fee");
    assert.equal(mint.origin, `${txid}.0`);
    assert.equal(mint.feeTxid, txid);
    assert.deepEqual(calls.pop(), ["ffd8ffd9", "image/jpeg", undefined, { to: "fee", sats: 1 }, ["POCKETPETS-MINT", "pet", "mochi", mint.contentHash.slice(0, 16)]]);
    for (const [price, fee] of [[1, 1], [50000, 1000]]) {
      assert.deepEqual(await gwMarketBuy(gw, "seller", price, "fee", "origin"), { txid, feeSats: fee });
      assert.deepEqual(calls.pop(), [[{ to: "seller", sats: price }, { to: "fee", sats: fee }], ["POCKETPETS-BUY", "origin"]]);
      const bought = await gwAtomicBuy(gw, { origin: `${txid}.0`, price_sats: price, seller_unlock: "unlock", pay_script: "pay" }, "fee");
      assert.equal(bought.feeSats, fee);
      const [offer, payment, memo] = calls.pop();
      assert.equal(offer.priceSats, price);
      assert.equal(offer.payScriptHex, "pay");
      assert.deepEqual(payment, { to: "fee", sats: fee });
      assert.deepEqual(memo, ["POCKETPETS-BUY", `${txid}.0`]);
    }
    assert.equal(fetches, 0);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    clearWindow();
  }
});

test("intent calls forward with exact daemon shapes", async () => {
  const calls = [];
  stubWindow({
    getBalance: async () => ({ address: "1abc", confirmed: 1, unconfirmed: 0 }),
    spend: async (...a) => {
      calls.push(["spend", a]);
      return { txid: "t", fee: 1, hex: "h" };
    },
    inscribe: async (...a) => {
      calls.push(["inscribe", a]);
      return { txid: "t", fee: 1, hex: "h" };
    },
    transferNft: async (...a) => {
      calls.push(["transferNft", a]);
      return { txid: "t", fee: 1 };
    },
    signSwapOffer: async (...a) => {
      calls.push(["signSwapOffer", a]);
      return { version: 2 };
    },
    completeSwap: async (...a) => {
      calls.push(["completeSwap", a]);
      return { txid: "t", fee: 1 };
    },
  });
  try {
    const b = osBsv();
    await b.spend([{ to: "1xyz", sats: 10 }], ["M"], "l");
    await b.inscribe("ab", "image/png", undefined, { to: "1xyz", sats: 5 }, ["M"]);
    await b.transferNft("a".repeat(64), 0, "1xyz", ["M"]);
    await b.signSwapOffer("a".repeat(64), 0, 100);
    await b.completeSwap({ input: {} }, { to: "1xyz", sats: 1 }, ["M"]);
    assert.deepEqual(
      calls.map(([m]) => m),
      ["spend", "inscribe", "transferNft", "signSwapOffer", "completeSwap"],
    );
    assert.deepEqual(calls[0][1], [[{ to: "1xyz", sats: 10 }], ["M"], "l"]);
    assert.deepEqual(calls[1][1][3], { to: "1xyz", sats: 5 });
    assert.deepEqual(calls[4][1][1], { to: "1xyz", sats: 1 });
  } finally {
    clearWindow();
  }
});
