import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveNftUtxo } from "../src/embedded.ts";

const ORIGIN = "a".repeat(64);
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(utxos, txInfo) {
  globalThis.fetch = (async (url) => {
    const u = String(url);
    if (u.includes("/v1/utxos/")) {
      return { ok: true, json: async () => ({ utxos }) };
    }
    if (u.includes("/v1/tx/")) {
      if (!txInfo) return { ok: false };
      return { ok: true, json: async () => txInfo };
    }
    throw new Error("unexpected " + u);
  });
}

test("indexed NFT resolves directly", async () => {
  mockFetch([{ txid: ORIGIN, vout: 0, value: 1, height: 900 }], null);
  const r = await resolveNftUtxo("1ABC", ORIGIN, 0);
  assert.equal(r.utxo.txid, ORIGIN);
  assert.equal(r.unconfirmed, false);
});

test("fresh unconfirmed mint falls back to parent tx", async () => {
  mockFetch([], { confirmations: 0 });
  const r = await resolveNftUtxo("1ABC", ORIGIN, 0);
  assert.equal(r.utxo.txid, ORIGIN);
  assert.equal(r.unconfirmed, true);
});

test("confirmed envelope output resolves too (index can never hold it)", async () => {
  // inscription outputs map to no address, so absence from the address UTXO
  // set means nothing — the parent mint is the source of truth
  mockFetch([], { confirmations: 3 });
  const r = await resolveNftUtxo("1ABC", ORIGIN, 0);
  assert.equal(r.utxo.txid, ORIGIN);
  assert.equal(r.unconfirmed, false);
});

test("missing parent tx asks to wait", async () => {
  mockFetch([], null);
  await assert.rejects(resolveNftUtxo("1ABC", ORIGIN, 0), /not found on-chain yet/);
});
