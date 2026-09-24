/**
 * PocketPets: static assets for pocketpets.entangleit.com, a legacy redirect
 * for entangleit.com/pocketpets, and a one-way migration bridge for saves
 * that live in the old portfolio origin's localStorage.
 *
 * The app's state (pets, coins, the PIN-encrypted built-in wallet key) is
 * per-origin localStorage. Moving the app from entangleit.com/pocketpets to
 * its own subdomain changed the origin, so old data is invisible until the
 * browser on the old origin hands it over. `/pocketpets/migrate` runs on
 * entangleit.com and reads it; `/_migrate` runs on the subdomain and writes
 * it back (then redirects into the app).
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
  if (save.length > 2_000_000 || key.length > 20_000) return new Response("too large", { status: 413 });
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
