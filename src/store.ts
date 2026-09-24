import { useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";
import { rememberLocalChange } from "./syncPolicy";
import type { Pet } from "./pets";
import { DEFAULT_FEE_ADDRESS, DEFAULT_POT_ADDRESS, type LedgerEntry, type PotEntry, type PotPayout } from "./chain";
import { ensureFoodDay, freshFood, type FoodState } from "./pets";

export interface PendingAcquisition {
  origin: string;
  nickname: string;
  species: string;
  emoji: string;
  rarity: string;
  level: number;
  buyTxid: string;
  ts: number;
}

export interface Save {
  pets: Pet[];
  activeUid: string | null;
  coins: number;
  pity: number;
  lastFreePull: number;
  totalPulls: number;
  ledger: LedgerEntry[];
  anchors: { tipHash: string; txid: string; ts: number }[];
  entries: PotEntry[];
  payouts: PotPayout[];
  potAddress: string;
  feeAddress: string;
  payoutAddress: string;
  pendingAcquisition: PendingAcquisition[];
  food: FoodState;
}

const KEY = "pocketpets.v1";

const fresh: Save = {
  pets: [],
  activeUid: null,
  coins: 120,
  pity: 0,
  lastFreePull: 0,
  totalPulls: 0,
  ledger: [],
  anchors: [],
  entries: [],
  payouts: [],
  potAddress: DEFAULT_POT_ADDRESS,
  feeAddress: DEFAULT_FEE_ADDRESS,
  payoutAddress: "",
  pendingAcquisition: [],
  food: freshFood(),
};

function load(): Save {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh;
    const p = JSON.parse(raw) as Partial<Save>;
    if (!Array.isArray(p.pets)) return fresh;
    return {
      ...fresh,
      ...p,
      pets: p.pets ?? [],
      ledger: Array.isArray(p.ledger) ? p.ledger : [],
      anchors: Array.isArray(p.anchors) ? p.anchors : [],
      entries: Array.isArray(p.entries) ? p.entries : [],
      payouts: Array.isArray(p.payouts) ? p.payouts : [],
      pendingAcquisition: Array.isArray(p.pendingAcquisition) ? p.pendingAcquisition : [],
      food: p.food && typeof p.food.left === "number" ? ensureFoodDay(p.food) : freshFood(),
    };
  } catch {
    return fresh;
  }
}

// One shared save for the whole app (tabs used to keep private copies that
// could clobber each other — and sync). Mutations persist synchronously and
// notify every subscriber, so any component can write safely.
let current: Save = load();
let changedAtValue = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getSave(): Save {
  return current;
}

export function subscribeSave(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSaveValue(updater: SetStateAction<Save>): void {
  const next = typeof updater === "function" ? (updater as (s: Save) => Save)(current) : updater;
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  changedAtValue = Date.now();
  rememberLocalChange(changedAtValue);
  emit();
}

/** [save, setSave, changedAt] — changedAt advances on every local mutation. */
export function useSave(): readonly [Save, Dispatch<SetStateAction<Save>>, number] {
  const save = useSyncExternalStore(subscribeSave, getSave);
  const changedAt = useSyncExternalStore(subscribeSave, () => changedAtValue);
  return [save, setSaveValue, changedAt] as const;
}

export const buzz = (ms = 15) => {
  try {
    (navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(ms);
  } catch {
    /* ignore */
  }
};
