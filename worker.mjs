/**
 * PocketPets worker: static assets for pocketpets.entangleit.com, the legacy
 * /pocketpets redirect + migration bridge, and per-account save sync.
 *
 * Sync stores the game save and the PIN-encrypted built-in wallet blob in a
 * Durable Object keyed by Twetch `sub`. The blob can only be decrypted by
 * the player's PIN on a device, so the server never holds a usable key.
 * Requests authenticate with the OIDC access token, verified against the
 * issuer's /userinfo; the DO is forward-only and trusts the worker's sub.
 */
const ISSUER = "https://id.entangleit.com";
const MAX_SAVE_BYTES = 2_000_000;
const MAX_KEY_BYTES = 20_000;

const tokenCache = new Map(); // sha256(token) -> { sub, exp }

export class PetSync {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (url.pathname === "/pull") return this.pull();
    if (url.pathname === "/push") return this.push(body);
    return json({ error: "not found" }, 404);
  }

  async pull() {
    const blob = await this.storage.get("blob");
    if (!blob) return json({ empty: true, rev: 0, updatedAt: 0, save: null, keyBlob: "" });
    return json({ rev: blob.rev, updatedAt: blob.updatedAt, save: blob.save, keyBlob: blob.keyBlob ?? "" });
  }

  async push(body) {
    const updatedAt = Math.floor(Number(body.updatedAt) || 0);
    if (body.save === undefined || body.save === null || !updatedAt) {
      return json({ error: "save and updatedAt required" }, 400);
    }
    const raw = JSON.stringify(body.save);
    if (raw.length > MAX_SAVE_BYTES) return json({ error: "save too large" }, 413);
    const keyBlob = typeof body.keyBlob === "string" ? body.keyBlob : "";
    if (keyBlob.length > MAX_KEY_BYTES) return json({ error: "key blob too large" }, 413);

    const current = await this.storage.get("blob");
    const baseRev = Math.floor(Number(body.baseRev) || 0);
    if (current && current.rev !== baseRev) {
      // The client resolves by updatedAt: adopt ours or re-push on top of it.
      return json(
        { error: "conflict", rev: current.rev, updatedAt: current.updatedAt, save: current.save, keyBlob: current.keyBlob ?? "" },
        409,
      );
    }
    const next = {
      rev: (current?.rev ?? 0) + 1,
      updatedAt,
      save: body.save,
      keyBlob: keyBlob || current?.keyBlob || "",
      // one generation of history so a resolved conflict is never destructive
      prev: current ? { rev: current.rev, updatedAt: current.updatedAt, save: current.save } : null,
    };
    await this.storage.put("blob", next);
    return json({ rev: next.rev, updatedAt: next.updatedAt });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/sync/pull" || url.pathname === "/api/sync/push") {
      const sub = await verifyBearer(request);
      if (!sub) return json({ error: "invalid or expired token — sign in again" }, 401);
      const path = url.pathname === "/api/sync/pull" ? "/pull" : "/push";
      const body = request.method === "POST" ? await request.text() : "{}";
      return env.SYNC.get(env.SYNC.idFromName(`u:${sub}`)).fetch(`https://sync.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    }

    // Old-origin export page.
    if (url.hostname === "entangleit.com" && url.pathname === "/pocketpets/migrate") {
      return html(MIGRATE_PAGE);
    }

    // New-origin import endpoint (form POST).
    if (url.hostname === "pocketpets.entangleit.com" && url.pathname === "/_migrate") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      return importPage(request);
    }

    if (
      url.hostname === "entangleit.com" &&
      (url.pathname === "/pocketpets" || url.pathname.startsWith("/pocketpets/"))
    ) {
      const dest = new URL(request.url);
      dest.hostname = "pocketpets.entangleit.com";
      dest.pathname = url.pathname.slice("/pocketpets".length) || "/";
      // Fragments never reach the server, so browsers carry them across.
      return Response.redirect(dest.toString(), 301);
    }

    const res = await env.ASSETS.fetch(request);
    // Client-side routes (e.g. /listing/<origin>) fall back to the SPA.
    if (res.status === 404 && (request.headers.get("accept") ?? "").includes("text/html")) {
      const index = new URL(request.url);
      index.pathname = "/";
      return env.ASSETS.fetch(new Request(index.toString(), request));
    }
    return res;
  },
};

async function verifyBearer(request) {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const token = m ? m[1].trim() : "";
  if (!token) return null;
  const key = await sha256Hex(token);
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.sub;
  const res = await fetch(`${ISSUER}/userinfo`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const ui = await res.json().catch(() => null);
  const sub = ui && ui.sub !== undefined ? String(ui.sub) : "";
  if (!sub) return null;
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(key, { sub, exp: Date.now() + 5 * 60_000 });
  return sub;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

function html(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const MIGRATE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Move your Pocket Pets</title>
<style>
body{font-family:system-ui,sans-serif;background:#171321;color:#eee;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
code{background:#241f33;padding:.1rem .3rem;border-radius:6px}
button{background:#7ee787;color:#171321;border:0;padding:10px 16px;border-radius:10px;font-weight:700;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.muted{color:#9b93ad}
</style></head>
<body>
<h1>Move your Pocket Pets</h1>
<p>This moves the pets, coins, and built-in wallet from this browser's
<code>entangleit.com/pocketpets</code> data to <code>pocketpets.entangleit.com</code>.
Nothing leaves this machine; the page reads localStorage and posts it to the new origin.</p>
<div id="out" class="muted">Reading old data…</div>
<form id="f" method="POST" action="https://pocketpets.entangleit.com/_migrate" style="display:none">
  <input type="hidden" name="save" id="save">
  <input type="hidden" name="key" id="key">
</form>
<p><button id="go" disabled>Move my pets →</button></p>
<p class="muted">Your built-in wallet PIN is unchanged. Yours-wallet pets are not in
localStorage — connect Yours on the new site to see those.</p>
<script>
const save = localStorage.getItem("pocketpets.v1") || "";
const key = localStorage.getItem("pocketpets.key.v1") || "";
const out = document.getElementById("out");
let pets = 0, coins = 0;
try { const s = JSON.parse(save); pets = (s.pets || []).length; coins = s.coins || 0; } catch {}
if (!save && !key) {
  out.textContent = "No old Pocket Pets data found in this browser.";
} else {
  out.textContent = "Found " + pets + " pet(s), " + coins + " coins" + (key ? ", and a built-in wallet key" : "") + ".";
  document.getElementById("save").value = save;
  document.getElementById("key").value = key;
  document.getElementById("go").disabled = false;
  document.getElementById("go").onclick = () => document.getElementById("f").submit();
}
</script>
</body></html>`;

async function importPage(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return new Response("bad form", { status: 400 });
  }
  const save = String(form.get("save") ?? "");
  const key = String(form.get("key") ?? "");
  if (save.length > MAX_SAVE_BYTES || key.length > MAX_KEY_BYTES) return new Response("too large", { status: 413 });
  if (save) {
    try {
      JSON.parse(save);
    } catch {
      return new Response("save is not JSON", { status: 400 });
    }
  }
  const embed = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const lines = [];
  if (save) lines.push(`localStorage.setItem("pocketpets.v1", ${embed(save)});`);
  if (key) lines.push(`localStorage.setItem("pocketpets.key.v1", ${embed(key)});`);
  lines.push(`localStorage.setItem("pocketpets.migratedAt", String(Date.now()));`);
  lines.push(`location.replace("/");`);
  return html(`<!doctype html><meta charset="utf-8"><title>Importing…</title>
<body style="font-family:system-ui;background:#171321;color:#eee;padding:24px">
<p>Importing your Pocket Pets data…</p>
<script>${lines.join("\n")}</script></body>`);
}
