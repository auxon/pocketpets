/**
 * PocketPets: static assets for pocketpets.entangleit.com, plus a legacy
 * redirect for the portfolio path entangleit.com/pocketpets.
 *
 * The portfolio's Pages deploy no longer carries the /pocketpets mount, so
 * these routes (see wrangler.jsonc) send old links to the standalone app
 * without rebuilding or redeploying the portfolio.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
