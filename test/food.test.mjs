import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FOOD, ensureFoodDay, freshFood, msUntilMidnight, takeFood, todayKey,
} from "../src/pets.ts";
import {
  ACTION_FEE_SATS, CUP_ENTRY_SATS, ENTRY_SATS, FOOD_REFILL_SATS,
  MARKET_FEE_BPS, MINT_FEE_SATS, POT_FEE_BPS, PULL_SATS, usdToSats,
} from "../src/chain.ts";

test("fresh bowl is full", () => {
  assert.equal(MAX_FOOD, 20);
  const f = freshFood(new Date(2026, 8, 13, 12));
  assert.deepEqual(f, { date: "2026-09-13", left: 20 });
});

test("same-day state is untouched", () => {
  const f = { date: "2026-09-13", left: 7 };
  assert.equal(ensureFoodDay(f, new Date(2026, 8, 13, 23, 59)), f);
});

test("new day refills to full", () => {
  const f = ensureFoodDay({ date: "2026-09-12", left: 0 }, new Date(2026, 8, 13, 0, 1));
  assert.deepEqual(f, { date: "2026-09-13", left: MAX_FOOD });
});

test("feeding drains one at a time and stops at zero", () => {
  let f = freshFood();
  for (let i = 0; i < MAX_FOOD; i++) {
    const next = takeFood(f);
    assert.ok(next);
    assert.equal(next.left, MAX_FOOD - 1 - i);
    f = next;
  }
  assert.equal(takeFood(f), null);
  assert.equal(f.left, 0);
});

test("midnight countdown is sane", () => {
  const ms = msUntilMidnight(new Date(2026, 8, 13, 12, 0));
  assert.ok(ms > 11 * 3600000 && ms <= 12 * 3600000);
  assert.equal(typeof todayKey(), "string");
});

test("refill price is a fixed 1 sat", () => {
  assert.equal(FOOD_REFILL_SATS, 1);
});

test("demo fees are fixed sats and preserve historical and percentage pricing", () => {
  assert.deepEqual([MINT_FEE_SATS, ACTION_FEE_SATS, CUP_ENTRY_SATS, PULL_SATS, FOOD_REFILL_SATS], [1, 1, 1, 1, 1]);
  assert.equal(CUP_ENTRY_SATS + ACTION_FEE_SATS, 2);
  assert.equal(ENTRY_SATS, 100);
  assert.equal(MARKET_FEE_BPS, 200);
  assert.equal(POT_FEE_BPS, 200);
  assert.deepEqual([0.05, 0.1, 0.25].map((usd) => usdToSats(usd, 25)), [200000, 400000, 1000000]);
});
