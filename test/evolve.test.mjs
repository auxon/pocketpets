import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVOLVE_WINS, MUTATION_CHANCE, NEXT_RARITY, evolve, hatch, maxHp,
  rollMutation, rollSpecies, speciesOf,
} from "../src/pets.ts";

test("rarity ladder + win thresholds", () => {
  assert.deepEqual(NEXT_RARITY, { common: "rare", rare: "epic", epic: "legendary", legendary: null });
  assert.deepEqual(EVOLVE_WINS, { common: 100, rare: 250, epic: 500 });
});

test("evolve moves one tier up, keeps identity, heals", () => {
  const mochi = hatch(rollSpecies("common", () => 0.01));
  const start = { ...mochi, nickname: "Momo", level: 5, xp: 30, wins: 100, hp: 1 };
  const ev = evolve(start, () => 0.01);
  assert.ok(ev);
  assert.equal(speciesOf(ev.pet).rarity, "rare");
  assert.equal(ev.pet.nickname, "Momo");
  assert.equal(ev.pet.level, 5);
  assert.equal(ev.pet.wins, 100);
  assert.deepEqual(ev.pet.evolvedFrom, [ev.from.name]);
  assert.equal(ev.pet.hp, maxHp(ev.pet));
});

test("evolve returns null at legendary", () => {
  const cosmo = hatch(rollSpecies("legendary", () => 0.01));
  assert.equal(evolve({ ...cosmo, wins: 9999 }), null);
});

test("lineage accumulates across tiers", () => {
  let p = { ...hatch(rollSpecies("common", () => 0.01)), wins: 100 };
  const first = evolve(p, () => 0.01);
  assert.ok(first);
  p = { ...first.pet, wins: 250 };
  const second = evolve(p, () => 0.5);
  assert.ok(second);
  assert.equal(speciesOf(second.pet).rarity, "epic");
  assert.deepEqual(second.pet.evolvedFrom, [first.from.name, second.from.name]);
});

test("rollMutation honors exact chance with rigged rand", () => {
  assert.equal(rollMutation("feed", () => 0.009), true);
  assert.equal(rollMutation("feed", () => 0.011), false);
  assert.equal(rollMutation("play", () => MUTATION_CHANCE.play - 1e-9), true);
  assert.equal(rollMutation("rest", () => 0.999), false);
});

test("win-loop: 99-win common evolves on its 100th win", () => {
  const p = { ...hatch(rollSpecies("common", () => 0.01)), wins: 99 };
  assert.equal(EVOLVE_WINS[speciesOf(p).rarity], 100);
  const after = { ...p, wins: p.wins + 1 };
  const ev = evolve(after, () => 0.3);
  assert.ok(ev);
  assert.equal(speciesOf(ev.pet).rarity, "rare");
});
