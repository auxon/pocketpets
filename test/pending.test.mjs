import { test } from "node:test";
import assert from "node:assert/strict";
import { dropPending, listPending, recordPending, spendable } from "../src/pending.ts";
import { createKey } from "../src/embedded.ts";

const A = "1DHBH964yuvJnneuUe7EKFpVyJK1Vkz8Y4";

test("spendable drops consumed coins and adds pending change", () => {
  const utxos = [
    { txid: "a".repeat(64), vout: 0, value: 1000, height: 100 },
    { txid: "b".repeat(64), vout: 1, value: 2000, height: 100 },
  ];
  recordPending({
    txid: "c".repeat(64),
    spent: [{ txid: "a".repeat(64), vout: 0 }],
    fresh: [{ txid: "c".repeat(64), vout: 1, value: 500, address: A }],
    ts: Date.now(),
  });
  const out = spendable(utxos, A);
  assert.ok(!out.some((u) => u.txid === "a".repeat(64)), "spent coin hidden");
  assert.ok(out.some((u) => u.txid === "c".repeat(64) && u.value === 500 && u.height === 0), "change usable");
  assert.ok(out.some((u) => u.txid === "b".repeat(64)), "untouched coin kept");
  dropPending("c".repeat(64));
  assert.equal(listPending().length, 0);
});

test("fresh outputs for other addresses are ignored", () => {
  recordPending({
    txid: "d".repeat(64),
    spent: [],
    fresh: [{ txid: "d".repeat(64), vout: 0, value: 999, address: "1Other" }],
    ts: Date.now(),
  });
  const out = spendable([], A);
  assert.equal(out.length, 0);
  dropPending("d".repeat(64));
});

test("re-spent fresh change is not double-counted", () => {
  const { address } = createKey();
  void address;
  recordPending({
    txid: "e".repeat(64),
    spent: [],
    fresh: [{ txid: "e".repeat(64), vout: 1, value: 700, address: A }],
    ts: Date.now(),
  });
  recordPending({
    txid: "f".repeat(64),
    spent: [{ txid: "e".repeat(64), vout: 1 }],
    fresh: [{ txid: "f".repeat(64), vout: 1, value: 600, address: A }],
    ts: Date.now(),
  });
  const out = spendable([], A);
  assert.ok(!out.some((u) => u.txid === "e".repeat(64)), "consumed change hidden");
  assert.ok(out.some((u) => u.txid === "f".repeat(64) && u.value === 600), "child change usable");
  dropPending("e".repeat(64));
  dropPending("f".repeat(64));
});
