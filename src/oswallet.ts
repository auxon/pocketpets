// OS custody backend: route game wallet ops through the BSV OS runner's
// window.bsv intents instead of browser-held keys. Active only inside the
// runner (`bsv app open`); everywhere else isOsWallet() is false and the
// game keeps its embedded/Yours backends untouched. The daemon builds,
// funds, signs, broadcasts, tracks, and labels every write under the app
// origin policy — the page only describes intents, never sees keys.

export interface OsUtxo {
  txid: string;
  vout: number;
  value: number;
  height: number;
}

export interface OsSwapOffer {
  input: { txid: string; vout: number; scriptHex: string; sequence: number };
  unlockHex: string;
  payScriptHex: string;
  priceSats: number;
  version: number;
  lockTime: number;
  unconfirmedParent?: boolean;
}

export interface OsBsv {
  isBSVOS: boolean;
  getStatus: () => Promise<{ authenticated: boolean; locked: boolean; hasWallet: boolean }>;
  getIdentity: () => Promise<{ identityKey: string | null; locked: boolean }>;
  getBalance: () => Promise<{ address: string; confirmed: number; unconfirmed: number }>;
  getUtxos: () => Promise<{ address: string; confirmed: number; unconfirmed: number; utxos: OsUtxo[] }>;
  spend: (
    payments: Array<{ to: string; sats: number }>, memo?: string[], label?: string
  ) => Promise<{ txid: string; fee: number; hex: string }>;
  inscribe: (
    dataHex: string, contentType: string, to?: string,
    fee?: { to: string; sats: number }, memo?: string[], label?: string
  ) => Promise<{ txid: string; fee: number; hex: string }>;
  transferNft: (txid: string, vout: number, to: string, memo?: string[]) => Promise<{ txid: string; fee: number }>;
  signSwapOffer: (txid: string, vout: number, priceSats: number) => Promise<OsSwapOffer>;
  completeSwap: (
    offer: unknown, fee?: { to: string; sats: number }, memo?: string[]
  ) => Promise<{ txid: string; fee: number }>;
}

function rawBsv(): { isBSVOS?: unknown } | null {
  try {
    const w = window as unknown as { bsv?: unknown };
    return w.bsv && typeof w.bsv === "object" ? (w.bsv as { isBSVOS?: unknown }) : null;
  } catch {
    return null;
  }
}

/** True only inside the BSV OS runner (bridge fragment present). */
export function isOsWallet(): boolean {
  return rawBsv()?.isBSVOS === true;
}

/** Typed accessor — throws a plain-English error outside the runner. */
export function osBsv(): OsBsv {
  const b = rawBsv();
  if (!b || b.isBSVOS !== true) {
    throw new Error("OS wallet needs the BSV OS runner — open this app with `bsv app open`");
  }
  return b as OsBsv;
}

let cachedAddress: string | null = null;

/** Sync read for wallet builders; null until ensureOsAddress() resolves once. */
export function osSession(): { address: string } | null {
  if (!isOsWallet() || !cachedAddress) return null;
  return { address: cachedAddress };
}

/** Fetch + pin the OS wallet address (stable: the daemon's single wallet). */
export async function ensureOsAddress(): Promise<string> {
  const bal = await osBsv().getBalance();
  if (!bal || typeof bal.address !== "string" || !bal.address) {
    throw new Error("OS wallet returned no address");
  }
  cachedAddress = bal.address;
  return bal.address;
}

/** Test hook: drop the cached address. */
export function __resetOsSession(): void {
  cachedAddress = null;
}
