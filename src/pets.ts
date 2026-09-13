// Pocket Pets core: species, gacha, care, battle. Pure logic, no React.

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface Species {
  id: string;
  name: string;
  emoji: string;
  rarity: Rarity;
  base: { hp: number; atk: number; def: number; spd: number };
  color: string;
  blurb: string;
}

export const SPECIES: Species[] = [
  { id: "mochi", name: "Mochi", emoji: "🍡", rarity: "common", base: { hp: 40, atk: 8, def: 6, spd: 7 }, color: "#f9a8d4", blurb: "squishy and sweet" },
  { id: "pebble", name: "Pebble", emoji: "🪨", rarity: "common", base: { hp: 55, atk: 6, def: 10, spd: 3 }, color: "#a8a29e", blurb: "unbothered rock" },
  { id: "sprout", name: "Sprout", emoji: "🌱", rarity: "common", base: { hp: 45, atk: 7, def: 7, spd: 6 }, color: "#86efac", blurb: "grows on you" },
  { id: "puff", name: "Puff", emoji: "☁️", rarity: "common", base: { hp: 38, atk: 9, def: 5, spd: 9 }, color: "#bae6fd", blurb: "floats through battles" },
  { id: "tidal", name: "Tidal", emoji: "🐚", rarity: "common", base: { hp: 52, atk: 7, def: 9, spd: 4 }, color: "#5eead4", blurb: "shelled wall" },
  { id: "zippy", name: "Zippy", emoji: "🐝", rarity: "common", base: { hp: 36, atk: 8, def: 5, spd: 11 }, color: "#fcd34d", blurb: "sting first, ask later" },
  { id: "mossy", name: "Mossy", emoji: "🍄", rarity: "common", base: { hp: 47, atk: 8, def: 8, spd: 5 }, color: "#fca5a5", blurb: "forest weirdo" },
  { id: "niblet", name: "Niblet", emoji: "🧀", rarity: "common", base: { hp: 42, atk: 10, def: 6, spd: 7 }, color: "#fde68a", blurb: "dangerously cheesy" },
  { id: "ember", name: "Ember", emoji: "🔥", rarity: "rare", base: { hp: 52, atk: 13, def: 8, spd: 10 }, color: "#fdba74", blurb: "burns bright" },
  { id: "bubbles", name: "Bubbles", emoji: "🫧", rarity: "rare", base: { hp: 48, atk: 11, def: 11, spd: 9 }, color: "#7dd3fc", blurb: "pops off" },
  { id: "nocti", name: "Nocti", emoji: "🦉", rarity: "rare", base: { hp: 50, atk: 12, def: 9, spd: 12 }, color: "#c4b5fd", blurb: "night watcher" },
  { id: "glimmer", name: "Glimmer", emoji: "✨", rarity: "rare", base: { hp: 46, atk: 13, def: 8, spd: 13 }, color: "#e9d5ff", blurb: "too shiny to hit" },
  { id: "torto", name: "Torto", emoji: "🐢", rarity: "rare", base: { hp: 62, atk: 9, def: 14, spd: 4 }, color: "#4ade80", blurb: "slow inevitable win" },
  { id: "zephyr", name: "Zephyr", emoji: "🍃", rarity: "rare", base: { hp: 44, atk: 12, def: 8, spd: 14 }, color: "#99f6e0", blurb: "gone with the wind" },
  { id: "gumbo", name: "Gumbo", emoji: "🍲", rarity: "rare", base: { hp: 58, atk: 11, def: 12, spd: 7 }, color: "#fb923c", blurb: "hearty stew of stats" },
  { id: "volti", name: "Volti", emoji: "⚡", rarity: "epic", base: { hp: 60, atk: 17, def: 11, spd: 16 }, color: "#fde047", blurb: "living lightning" },
  { id: "corali", name: "Corali", emoji: "🪸", rarity: "epic", base: { hp: 68, atk: 15, def: 15, spd: 10 }, color: "#f0abfc", blurb: "reef royalty" },
  { id: "prism", name: "Prism", emoji: "🔮", rarity: "epic", base: { hp: 58, atk: 18, def: 12, spd: 15 }, color: "#a78bfa", blurb: "sees your next move" },
  { id: "thorn", name: "Thorn", emoji: "🌵", rarity: "epic", base: { hp: 70, atk: 16, def: 16, spd: 9 }, color: "#34d399", blurb: "hug at your own risk" },
  { id: "cosmo", name: "Cosmo", emoji: "🌌", rarity: "legendary", base: { hp: 80, atk: 22, def: 16, spd: 18 }, color: "#a5b4fc", blurb: "born from starstuff" },
  { id: "aurum", name: "Aurum", emoji: "🐉", rarity: "legendary", base: { hp: 90, atk: 24, def: 18, spd: 14 }, color: "#fbbf24", blurb: "hoards victories" },
  { id: "celeste", name: "Celeste", emoji: "🦄", rarity: "legendary", base: { hp: 78, atk: 23, def: 17, spd: 19 }, color: "#e879f9", blurb: "fastest myth alive" },
  { id: "umbra", name: "Umbra", emoji: "🌑", rarity: "legendary", base: { hp: 92, atk: 25, def: 19, spd: 13 }, color: "#94a3b8", blurb: "eclipse incarnate" },
];

export interface PetNft {
  origin: string; // txid.0 — the inscription, permanent ID
  txid: string; // current location tx (updates on transfer/sale)
  vout?: number; // current location vout (default 0; atomic buys land at vout 1)
  contentHash?: string;
  mintedAt: number;
  scriptHex?: string; // current locking script (enables transfer/relist)
  mintAddress?: string; // wallet that minted it (embedded mints; guards wrong-wallet listing)
}

export interface Pet {
  uid: string;
  speciesId: string;
  nickname: string;
  level: number;
  xp: number;
  hp: number; // current
  happy: number; // 0-100
  energy: number; // 0-100
  wins: number;
  pulls: number; // pity counter at pull time
  nft?: PetNft; // 1Sat Ordinal birth certificate, once minted
  evolvedFrom?: string[]; // species names this pet evolved through (lineage = value)
}

export const rarityWeight = (r: Rarity, pity: number): number => {
  const base = { common: 62, rare: 26, epic: 9, legendary: 3 }[r];
  if (r === "legendary") return base + Math.min(pity, 30); // pity boosts legend
  return base;
};

export function rollRarity(pity: number, rand = Math.random): Rarity {
  const bag: Rarity[] = ["common", "rare", "epic", "legendary"];
  const weights = bag.map((r) => rarityWeight(r, pity));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < bag.length; i++) {
    x -= weights[i];
    if (x <= 0) return bag[i];
  }
  return "common";
}

export function rollSpecies(rarity: Rarity, rand = Math.random): Species {
  const pool = SPECIES.filter((s) => s.rarity === rarity);
  return pool[Math.floor(rand() * pool.length)];
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

export function hatch(species: Species, pity = 0): Pet {
  const hp = species.base.hp;
  return {
    uid: uid(),
    speciesId: species.id,
    nickname: species.name,
    level: 1,
    xp: 0,
    hp,
    happy: 70,
    energy: 100,
    wins: 0,
    pulls: pity,
  };
}

export const speciesOf = (p: Pet): Species => SPECIES.find((s) => s.id === p.speciesId)!;

/** Listing metadata carries the species name — resolve back, defaulting to Mochi. */
export const speciesByName = (name: string): Species =>
  SPECIES.find((s) => s.name.toLowerCase() === String(name ?? "").toLowerCase()) ?? SPECIES[0]!;

export const maxHp = (p: Pet): number => speciesOf(p).base.hp + p.level * 6;

export function stats(p: Pet) {
  const s = speciesOf(p);
  const g = p.level - 1;
  return {
    hp: maxHp(p),
    atk: s.base.atk + Math.floor(g * 1.6),
    def: s.base.def + Math.floor(g * 1.2),
    spd: s.base.spd + Math.floor(g * 0.8),
  };
}

export const xpForLevel = (level: number): number => 20 + level * 15;

export function grantXp(p: Pet, amount: number): { pet: Pet; leveled: boolean } {
  let xp = p.xp + amount;
  let level = p.level;
  let leveled = false;
  while (xp >= xpForLevel(level) && level < 30) {
    xp -= xpForLevel(level);
    level += 1;
    leveled = true;
  }
  const healed = leveled ? maxHp({ ...p, level }) : p.hp;
  return { pet: { ...p, xp, level, hp: Math.min(healed, maxHp({ ...p, level })) }, leveled };
}

// --- care actions (cooldowns handled in UI) ---
export function feed(p: Pet): Pet {
  return grantXp({ ...p, hp: Math.min(maxHp(p), p.hp + 12), happy: Math.min(100, p.happy + 8), energy: Math.min(100, p.energy + 4) }, 6).pet;
}
export function play(p: Pet): Pet {
  if (p.energy < 10) return p;
  return grantXp({ ...p, happy: Math.min(100, p.happy + 14), energy: p.energy - 10, hp: Math.min(maxHp(p), p.hp + 4) }, 9).pet;
}
export function rest(p: Pet): Pet {
  return { ...p, energy: Math.min(100, p.energy + 30), hp: Math.min(maxHp(p), p.hp + 8) };
}

// --- battle: speed-ordered auto turns, small variance, happy bonus ---
export interface BattleTurn { actor: string; text: string; dmg: number; aHp: number; bHp: number; }
export interface BattleResult { log: BattleTurn[]; winnerUid: string; rounds: number; }

export function battle(a: Pet, b: Pet, rand = Math.random): BattleResult {
  const sa = stats(a), sb = stats(b);
  let aHp = Math.min(a.hp, sa.hp), bHp = Math.min(b.hp, sb.hp);
  const log: BattleTurn[] = [];
  const firstA = sa.spd === sb.spd ? rand() < 0.5 : sa.spd > sb.spd;
  let rounds = 0;
  const strike = (atk: number, def: number, happy: number) => {
    const mood = 1 + happy / 250;
    const roll = 0.85 + rand() * 0.3;
    return Math.max(1, Math.round(((atk * mood) / (1 + def / 12)) * roll));
  };
  while (aHp > 0 && bHp > 0 && rounds < 30) {
    rounds++;
    const order: Array<"a" | "b"> = firstA ? ["a", "b"] : ["b", "a"];
    for (const side of order) {
      if (aHp <= 0 || bHp <= 0) break;
      if (side === "a") {
        const dmg = strike(sa.atk, sb.def, a.happy);
        bHp = Math.max(0, bHp - dmg);
        log.push({ actor: a.nickname, text: `${a.nickname} hits for ${dmg}`, dmg, aHp, bHp });
      } else {
        const dmg = strike(sb.atk, sa.def, b.happy);
        aHp = Math.max(0, aHp - dmg);
        log.push({ actor: b.nickname, text: `${b.nickname} hits for ${dmg}`, dmg, aHp, bHp });
      }
    }
  }
  const winnerUid = aHp === bHp ? (rand() < 0.5 ? a.uid : b.uid) : aHp > bHp ? a.uid : b.uid;
  return { log, winnerUid, rounds };
}

export function wildOpponent(playerLevel: number, rand = Math.random): Pet {
  const pity = Math.floor(rand() * 12);
  const r = rollRarity(pity, rand);
  const sp = rollSpecies(r === "legendary" && rand() < 0.7 ? "rare" : r, rand);
  const p = hatch(sp);
  const lvl = Math.max(1, Math.min(30, playerLevel + Math.floor(rand() * 5) - 2));
  let cur = { ...p, level: 1, xp: 0 };
  for (let i = 1; i < lvl; i++) cur = grantXp(cur, xpForLevel(cur.level)).pet;
  return { ...cur, hp: maxHp(cur), nickname: `Wild ${sp.name}` };
}

export const RARITY_COLOR: Record<Rarity, string> = {
  common: "#9ca3af",
  rare: "#60a5fa",
  epic: "#c084fc",
  legendary: "#fbbf24",
};

// --- evolution: rarity ladder, win milestones, care mutations ---
export const NEXT_RARITY: Record<Rarity, Rarity | null> = {
  common: "rare",
  rare: "epic",
  epic: "legendary",
  legendary: null,
};

/** Season-style career gates: wins needed to evolve OUT of each rarity. */
export const EVOLVE_WINS: Partial<Record<Rarity, number>> = {
  common: 100,
  rare: 250,
  epic: 500,
};

/** Per-action mutation chance (feed / play / rest). Play costs energy, pays better odds. */
export const MUTATION_CHANCE = { feed: 0.01, play: 0.015, rest: 0.005 } as const;

/** Daily food supply: each Feed eats 1. Throttles feed-farming XP/mutations. */
export const MAX_FOOD = 20;

export interface FoodState {
  /** Local calendar day this supply belongs to (YYYY-MM-DD). */
  date: string;
  left: number;
}

export function todayKey(d = new Date()): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function freshFood(d = new Date()): FoodState {
  return { date: todayKey(d), left: MAX_FOOD };
}

/** Roll the supply over when the calendar day changed. Pure. */
export function ensureFoodDay(food: FoodState, d = new Date()): FoodState {
  return food.date === todayKey(d) ? food : freshFood(d);
}

/** Consume 1 food. Returns null when the bowl is empty. */
export function takeFood(food: FoodState): FoodState | null {
  if (food.left <= 0) return null;
  return { ...food, left: food.left - 1 };
}

/** ms until local midnight (for the "refills in …" label). */
export function msUntilMidnight(d = new Date()): number {
  const mid = new Date(d);
  mid.setHours(24, 0, 0, 0);
  return Math.max(0, mid.getTime() - d.getTime());
}

export function rollMutation(kind: keyof typeof MUTATION_CHANCE, rand: () => number = Math.random): boolean {
  return rand() < MUTATION_CHANCE[kind];
}

export interface Evolution {
  pet: Pet;
  from: Species;
  to: Species;
}

/**
 * Evolve a pet into a random species of the next rarity tier.
 * Keeps identity (nickname/level/xp/wins/lineage), adopts the new body,
 * heals to the new max HP. Returns null at max rarity.
 */
export function evolve(pet: Pet, rand: () => number = Math.random): Evolution | null {
  const from = speciesOf(pet);
  const next = NEXT_RARITY[from.rarity];
  if (!next) return null;
  const to = rollSpecies(next, rand);
  const evolved: Pet = {
    ...pet,
    speciesId: to.id,
    evolvedFrom: [...(pet.evolvedFrom ?? []), from.name],
  };
  return { pet: { ...evolved, hp: maxHp(evolved) }, from, to };
}
