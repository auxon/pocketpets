// Built-in wallet session: WIF lives only in memory while unlocked.
import { useCallback, useState } from "react";
import {
  addressFromWif, createKey, fetchUtxos, forgetKey, hasStoredKey,
  loadKeyEncrypted, storeKeyEncrypted,
} from "./embedded";

let sessionWif: string | null = null;

export interface EmbState {
  mode: "none" | "locked" | "unlocked";
  address: string | null;
  balance: number;
  utxoCount: number;
  loadingBal: boolean;
  error: string | null;
  pin: string;
  setPin(s: string): void;
  importWif: string;
  setImportWif(s: string): void;
  showImport: boolean;
  setShowImport(b: boolean): void;
  create(pin: string): Promise<void>;
  doImport(wif: string, pin: string): Promise<void>;
  unlock(pin: string): Promise<boolean>;
  lock(): void;
  forget(): void;
  refresh(): Promise<void>;
  wif(): string | null;
}

export function useEmbeddedWallet(): EmbState {
  const [mode, setMode] = useState<"none" | "locked" | "unlocked">(() =>
    sessionWif ? "unlocked" : hasStoredKey() ? "locked" : "none"
  );
  const [address, setAddress] = useState<string | null>(() =>
    sessionWif ? addressFromWif(sessionWif) : null
  );
  const [balance, setBalance] = useState(0);
  const [utxoCount, setUtxoCount] = useState(0);
  const [loadingBal, setLoadingBal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [importWif, setImportWif] = useState("");
  const [showImport, setShowImport] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionWif) return;
    const addr = addressFromWif(sessionWif);
    setLoadingBal(true);
    try {
      const u = await fetchUtxos(addr);
      setBalance(u.confirmed + u.unconfirmed);
      setUtxoCount(u.utxos.length);
      setAddress(addr);
    } catch {
      setError("Balance lookup failed — try again");
    } finally {
      setLoadingBal(false);
    }
  }, []);

  const create = useCallback(async (p: string) => {
    if (p.length < 4) throw new Error("PIN must be 4+ characters");
    const { wif, address: addr } = createKey();
    await storeKeyEncrypted(wif, p);
    sessionWif = wif;
    setAddress(addr);
    setMode("unlocked");
    setPin("");
    await refresh();
  }, [refresh]);

  const doImport = useCallback(async (w: string, p: string) => {
    if (p.length < 4) throw new Error("PIN must be 4+ characters");
    const addr = addressFromWif(w); // throws if bad
    await storeKeyEncrypted(w.trim(), p);
    sessionWif = w.trim();
    setAddress(addr);
    setMode("unlocked");
    setPin("");
    setImportWif("");
    setShowImport(false);
    await refresh();
  }, [refresh]);

  const unlock = useCallback(async (p: string) => {
    const w = await loadKeyEncrypted(p);
    if (!w) return false;
    sessionWif = w;
    setAddress(addressFromWif(w));
    setMode("unlocked");
    setPin("");
    await refresh();
    return true;
  }, [refresh]);

  const lock = useCallback(() => {
    sessionWif = null;
    setMode(hasStoredKey() ? "locked" : "none");
    setBalance(0);
  }, []);

  const forget = useCallback(() => {
    sessionWif = null;
    forgetKey();
    setMode("none");
    setAddress(null);
    setBalance(0);
  }, []);

  return {
    mode, address, balance, utxoCount, loadingBal, error, pin, setPin,
    importWif, setImportWif, showImport, setShowImport,
    create, doImport, unlock, lock, forget, refresh,
    wif: () => sessionWif,
  };
}

/** Snapshot for non-React callers (mint/entry flows read the live session). */
export function embeddedSession(): { wif: string; address: string } | null {
  if (!sessionWif) return null;
  try {
    return { wif: sessionWif, address: addressFromWif(sessionWif) };
  } catch {
    return null;
  }
}
