#!/usr/bin/env bash
# Pocket Pets -> entangleit.com/pocketpets.
#
# Rebuilds the portfolio before deploying. An earlier version wiped
# portfolio/public and shipped only the pocketpets mount, which left the site
# with no JS bundle and blank pages. Mounts already in public/ are preserved
# by the standalone build (scripts/build-site.mjs).
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTFOLIO="$HOME/entangleit/portfolio"
PUB="$PORTFOLIO/public"

cd "$APP"
npm run build

cd "$PORTFOLIO"
SIBLINGS=(
  "$HOME/vibecoded"
  "$HOME/x402market"
  "$HOME/agentpay"
  "$HOME/bitcoinzip"
  "$HOME/ASLTutor"
  "$HOME/WoT"
  "$HOME/GatchaGo"
)
missing=0
for dir in "${SIBLINGS[@]}"; do
  [ -d "$dir" ] || missing=1
done
if [ "$missing" -eq 0 ]; then
  npm run build:pages
else
  echo "deploy-entangleit: sibling repos not found; using standalone build (mounts preserved)"
  npm run build
fi

rm -rf "$PUB/pocketpets"
mkdir -p "$PUB/pocketpets"
cp -a "$APP/dist/." "$PUB/pocketpets/"
cp "$PUB/pocketpets/index.html" "$PUB/pocketpets/shell.html"
cp "$PUB/pocketpets/index.html" "$PUB/pocketpets/app.html"
grep -q '/pocketpets/assets/' "$PUB/pocketpets/index.html" || { echo "BASE PATH WRONG — aborting"; exit 1; }

node scripts/predeploy-check.mjs
npx wrangler pages deploy public --project-name=richard-hein-portfolio --commit-dirty=true
