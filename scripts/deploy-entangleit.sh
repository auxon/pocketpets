#!/usr/bin/env bash
# Pocket Pets -> entangleit.com/pocketpets. Absolute paths on purpose:
# a relative `dist` once staged the portfolio homepage into /pocketpets/.
set -euo pipefail
APP=/Users/rah/pocketpets
PUB=/Users/rah/entangleit/portfolio/public/pocketpets

cd "$APP"
npm run build
rm -rf "$PUB"
mkdir -p "$PUB"
cp -a "$APP/dist/." "$PUB/"
cp "$PUB/index.html" "$PUB/shell.html"
cp "$PUB/index.html" "$PUB/app.html"
grep -q '/pocketpets/assets/' "$PUB/index.html" || { echo "BASE PATH WRONG — aborting"; exit 1; }
cd /Users/rah/entangleit/portfolio
npx wrangler pages deploy public --project-name=richard-hein-portfolio --commit-dirty=true
