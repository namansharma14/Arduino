#!/usr/bin/env bash
# Live scrape verification — run this INSIDE the Codespace (or any machine with
# open internet):   bash competitor-intel/scripts/verify-live.sh
# It never fabricates anything: it probes the three real competitor sites,
# shows exactly what each extraction pass finds, then runs the real engine.
# All output is captured to competitor-intel/verify-live-output.txt — paste that
# file back to Claude and the configs get tuned from real evidence.

set -uo pipefail
cd "$(dirname "$0")/.."
OUT="verify-live-output.txt"
exec > >(tee "$OUT") 2>&1

echo "=== verify-live $(date -u +%FT%TZ) ==="
echo "commit: $(git rev-parse --short HEAD 2>/dev/null)  node: $(node -v)"
echo ""

echo "--- deps ---"
npm install --no-audit --no-fund 2>&1 | tail -1
npx --yes playwright install chromium 2>&1 | tail -1 || echo "WARN: Chromium install failed — rendered passes will fall back to static"
echo ""

CCY="USD,EUR,GBP,JPY,NZD,THB"
for url in \
  "https://www.travelmoneyoz.com/rates" \
  "https://www.travelex.com.au/rates" \
  "https://au.prosegurchange.com/exchange-rates"; do
  echo "================================================================"
  echo "### $url"
  npm run --silent scrape:verify -- "$url" --currencies "$CCY" || true
  echo ""
done

echo "================================================================"
echo "### Travelex salt API — one GET settles the rates.rates shape"
curl -sS --max-time 20 "https://api.travelex.net/salt/config/multi?key=Travelex&site=%2Fau&options=abhikzl" \
  | head -c 4000 || echo "(salt API fetch failed)"
echo ""
echo ""

echo "================================================================"
echo "### live engine run (persists to local data/intel.db)"
npm run --silent scrape || true

echo ""
echo "=== DONE — paste the contents of competitor-intel/$OUT back to Claude ==="
