/**
 * Sync policy and local bookkeeping, kept free of React so it is unit
 * testable. The server is a revision counter; who wins a conflict is
 * decided here by the save's local change time.
 */
import type { Save } from "./store";

export const KEY_STORE = "pocketpets.key.v1";
export const SYNC_LOCAL_AT = "pocketpets.sync.localAt";
export const SYNC_BASE_REV = "pocketpets.sync.baseRev";

/** Clock-skew allowance so two devices don't ping-pong on near-equal times. */
export const SKEW_MS = 1500;

export interface RemoteBlob {
  rev: number;
  updatedAt: number;
  save: Save | null;
  keyBlob: string;
  empty?: boolean;
}

export type SyncChoice = "adopt-remote" | "push-local" | "in-sync";

export function chooseAction(localAt: number, remote: RemoteBlob | null): SyncChoice {
  if (!remote || remote.empty || !remote.save) return "push-local";
  const remoteAt = Number(remote.updatedAt) || 0;
  const local = Number(localAt) || 0;
  if (remoteAt > local + SKEW_MS) return "adopt-remote";
  if (local > remoteAt + SKEW_MS) return "push-local";
  return "in-sync";
}

export function localChangedAt(): number {
  try {
    return Number(localStorage.getItem(SYNC_LOCAL_AT)) || 0;
  } catch {
    return 0;
  }
}

export function rememberLocalChange(at: number): void {
  try {
    localStorage.setItem(SYNC_LOCAL_AT, String(at));
  } catch {
    /* ignore */
  }
}

export function baseRev(): number {
  try {
    return Number(localStorage.getItem(SYNC_BASE_REV)) || 0;
  } catch {
    return 0;
  }
}

export function rememberBaseRev(rev: number): void {
  try {
    localStorage.setItem(SYNC_BASE_REV, String(rev));
  } catch {
    /* ignore */
  }
}

/** The PIN-encrypted built-in wallet blob; opaque to the server. */
export function keyBlob(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
}

/**
 * Adopt a remote wallet blob only when this device has none: an existing
 * local key always wins (switching wallets under the player would be worse).
 */
export function adoptKeyBlob(blob: string): boolean {
  if (!blob) return false;
  if (keyBlob()) return false;
  try {
    localStorage.setItem(KEY_STORE, blob);
    return true;
  } catch {
    return false;
  }
}
