// Sign in with Twetch (OIDC code + PKCE against id.entangleit.com).
// Claims come from the userinfo endpoint (server-validated) — no JWT crypto here.
import { useCallback, useState } from "react";
import { routePath } from "./routes.ts";

const ISSUER = "https://id.entangleit.com";
const CLIENT_ID = "pocketpets";
const SESSION_KEY = "pocketpets.twetch.v1";

export interface TwetchSession {
  sub: string;
  handle: string;
  name: string;
  avatar: string | null;
  profileUrl: string | null;
  accessToken: string;
  obtainedAt: number;
}

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};

export function redirectUri(): string {
  return `${window.location.origin}${routePath()}`;
}

export function startLogin(): void {
  const verifier = b64url(randomBytes(64));
  const state = b64url(randomBytes(16));
  sessionStorage.setItem("pocketpets.pkce.v", verifier);
  sessionStorage.setItem("pocketpets.pkce.s", state);
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then((d) => {
    const challenge = b64url(new Uint8Array(d));
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: "openid profile",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    window.location.href = `${ISSUER}/authorize?${q.toString()}`;
  });
}

/** Exchange ?code= after redirect. Returns session or null (not a callback). */
export async function finishLogin(): Promise<TwetchSession | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return null;
  // clean the URL either way
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("iss");
  window.history.replaceState(null, "", url.toString());
  const err = url.searchParams.get("error");
  if (err) throw new Error(`Twetch login failed: ${err}`);
  const want = sessionStorage.getItem("pocketpets.pkce.s");
  if (!want || want !== state) throw new Error("Login state mismatch — try again");
  const verifier = sessionStorage.getItem("pocketpets.pkce.v");
  if (!verifier) throw new Error("Login session expired — try again");
  sessionStorage.removeItem("pocketpets.pkce.v");
  sessionStorage.removeItem("pocketpets.pkce.s");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  const tok = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!tok.ok) throw new Error("Token exchange failed");
  const tj = (await tok.json()) as { access_token?: string; error?: string };
  if (!tj.access_token) throw new Error(String(tj.error ?? "No access token"));
  const ui = await fetch(`${ISSUER}/userinfo`, {
    headers: { Authorization: `Bearer ${tj.access_token}` },
  });
  if (!ui.ok) throw new Error("Could not load Twetch profile");
  const p = (await ui.json()) as {
    sub?: string; name?: string; preferred_username?: string;
    picture?: string; profile?: string;
  };
  if (!p.sub) throw new Error("Profile missing user id");
  const session: TwetchSession = {
    sub: String(p.sub),
    handle: String(p.preferred_username ?? p.name ?? `user${p.sub}`),
    name: String(p.name ?? p.preferred_username ?? ""),
    avatar: typeof p.picture === "string" ? p.picture : null,
    profileUrl: typeof p.profile === "string" ? p.profile : null,
    accessToken: tj.access_token,
    obtainedAt: Date.now(),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
  return session;
}

function loadStored(): TwetchSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as TwetchSession;
    return s.sub ? s : null;
  } catch {
    return null;
  }
}

export function useTwetch() {
  const [session, setSession] = useState<TwetchSession | null>(loadStored);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const settleCallback = useCallback(async (): Promise<boolean> => {
    if (!new URL(window.location.href).searchParams.get("code")) return false;
    setAuthBusy(true);
    try {
      const s = await finishLogin();
      if (s) setSession(s);
      return !!s;
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Login failed");
      return false;
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    setSession(null);
  }, []);

  return { session, authError, authBusy, settleCallback, logout };
}
