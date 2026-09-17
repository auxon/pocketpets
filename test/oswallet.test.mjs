import { test } from "node:test";
import assert from "node:assert/strict";
import { __resetOsSession, ensureOsAddress, isOsWallet, osBsv, osSession } from "../src/oswallet.ts";

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
