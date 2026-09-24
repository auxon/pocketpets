import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseAction } from "../src/syncPolicy.ts";
import { PetSync } from "../worker.mjs";

test("conflict policy: newest save wins, near-equal times are in sync", () => {
  const remote = (updatedAt, save = { pets: [] }) => ({ rev: 3, updatedAt, save, keyBlob: "" });
  assert.equal(chooseAction(1000, null), "push-local");
  assert.equal(chooseAction(1000, { rev: 0, updatedAt: 0, save: null, keyBlob: "", empty: true }), "push-local");
  assert.equal(chooseAction(1000, remote(5000)), "adopt-remote");
  assert.equal(chooseAction(5000, remote(1000)), "push-local");
  assert.equal(chooseAction(5000, remote(5000)), "in-sync");
  assert.equal(chooseAction(5000, remote(4200)), "in-sync"); // within skew
  assert.equal(chooseAction(0, remote(0)), "in-sync"); // brand new but empty remote is push-local
  assert.equal(chooseAction(0, { rev: 0, updatedAt: 0, save: null, keyBlob: "", empty: true }), "push-local");
});

/** In-memory Durable Object storage. */
class MemStorage {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.map.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key) {
    return this.map.delete(key);
  }
  async list({ prefix = "" } = {}) {
    const out = new Map();
    for (const [k, v] of this.map) if (k.startsWith(prefix)) out.set(k, v);
    return out;
  }
}

function makeDo() {
  return new PetSync({ storage: new MemStorage() }, {});
}

const push = (doObj, body) =>
  doObj.fetch(new Request("https://sync.internal/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const pull = (doObj) => doObj.fetch(new Request("https://sync.internal/pull"));

test("sync DO: revisions, conflicts, and key blob preservation", async () => {
  const sync = makeDo();

  const empty = await (await pull(sync)).json();
  assert.equal(empty.empty, true);
  assert.equal(empty.rev, 0);

  const first = await (await push(sync, { baseRev: 0, updatedAt: 1000, save: { pets: ["a"] }, keyBlob: "enc-key" })).json();
  assert.equal(first.rev, 1);

  // Same base revision is stale now: conflict returns the current copy.
  const stale = await push(sync, { baseRev: 0, updatedAt: 500, save: { pets: ["stale"] }, keyBlob: "" });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.error, "conflict");
  assert.deepEqual(conflict.save, { pets: ["a"] });
  assert.equal(conflict.keyBlob, "enc-key");

  // Pushing on top of the current revision bumps it; omitting the blob keeps it.
  const second = await (await push(sync, { baseRev: 1, updatedAt: 2000, save: { pets: ["a", "b"] } })).json();
  assert.equal(second.rev, 2);
  const pulled = await (await pull(sync)).json();
  assert.deepEqual(pulled.save, { pets: ["a", "b"] });
  assert.equal(pulled.keyBlob, "enc-key");
  assert.equal(pulled.updatedAt, 2000);

  // Input validation.
  assert.equal((await push(sync, { baseRev: 2, updatedAt: 0, save: { pets: [] } })).status, 400);
  assert.equal((await push(sync, { baseRev: 2, updatedAt: 1, save: null })).status, 400);
  const big = "x".repeat(2_000_001);
  assert.equal((await push(sync, { baseRev: 2, updatedAt: 1, save: { blob: big } })).status, 413);
  assert.equal((await push(sync, { baseRev: 2, updatedAt: 1, save: { ok: 1 }, keyBlob: "k".repeat(20_001) })).status, 413);

  // One generation of history survives for conflict recovery.
  const stored = await sync.storage.get("blob");
  assert.equal(stored.prev.rev, 1);
  assert.deepEqual(stored.prev.save, { pets: ["a"] });
});
