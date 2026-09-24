/**
 * Route base follows the Vite `base`, so the app's own paths and share links
 * resolve correctly both when mounted on the portfolio (/pocketpets/) and
 * when deployed standalone on its own subdomain (/). See wrangler.jsonc and
 * scripts/deploy-entangleh.sh for the two builds.
 */
export const ROUTE_BASE = import.meta.env.BASE_URL;

export function routePath(path = ""): string {
  const base = ROUTE_BASE.endsWith("/") ? ROUTE_BASE : `${ROUTE_BASE}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}
