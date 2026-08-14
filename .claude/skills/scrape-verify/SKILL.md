---
name: scrape-verify
description: Verify and tune competitor rate-page scraping for the Crown Currency intel tool (competitor-intel/). Use when asked to turn on / test / fix scraping for a competitor site, when a scrape run shows "partial" or "error", or when onboarding a competitor with a rates URL. Probes the URL, compares static vs headless-rendered extraction, sniffs hidden JSON rate APIs, produces a working scrape_config, and verifies rates land correctly without polluting real data.
---

# Scrape & Verify — competitor rate pages

Goal: end with a `scrape_config` that reliably extracts correct rates for a competitor,
verified against the live site — or a clear, evidence-backed statement of why it can't be
scraped (bot-blocked, interactive-only, unreachable) and what the fallback is.

## Ground rules

- **Never claim scraping "works" without running step 3 against the live site.** A config
  that *should* work is not a verified config. If the site is unreachable from the current
  environment, say exactly that and hand the user the one command to run where it is
  reachable.
- Rates in this app are **foreign units per 1 AUD** (USD ≈ 0.65, JPY ≈ 98). If extracted
  values are wildly off that magnitude, extraction grabbed the wrong numbers — fix before saving.
- Do not persist junk: test with the verify CLI (never writes) before any real scrape run.
- Be a polite scraper: hourly cadence (default cron), identified User-Agent (already
  configured), no hammering. If a site clearly blocks bots, respect it and use the manual
  counter-entry path instead.

## Prerequisites

```bash
cd competitor-intel && npm install
# rendered scraping needs a Chromium once per machine:
npx --yes playwright install chromium     # (or --with-deps chromium on fresh Linux)
```
If Chromium can't be installed, set `SCRAPE_CHROME_PATH` to any existing Chrome/Chromium binary.

## Procedure

### 1. Reachability
```bash
curl -sS -L --max-time 20 -o /dev/null -w "http=%{http_code} bytes=%{size_download}\n" "<URL>"
```
`http=000` → network-blocked from here; stop and report (give the user step 2's command to
run in their Codespace/laptop). `403/429` → likely bot protection; note it and still try step 2
(a real browser render sometimes passes).

### 2. Extraction test (never writes to the DB)
```bash
npm run scrape:verify -- "<URL>" --currencies USD,EUR,GBP,JPY,NZD,THB
```
Read the three sections of output:
- **STATIC** found rates → best case; config needs no `render` (fast, no browser needed).
- **RENDERED** found rates but static didn't → JS-injected page; config needs `"render": true`.
- **🎯 Sniffed JSON** hits → the gold path. Open the sniffed URL, find the array + field names,
  and prefer `strategy "json"` — it survives site redesigns far better than HTML scraping:
  `{"strategy":"json","url":"<api url>","items":"<path.to.array>","map":{"code":"<field>","sell":"<field>","buy":"<field>"}}`
  Re-run the verify CLI with `--strategy json --config '{"items":…,"map":…}'` to prove it.
- Values flagged `⚠ magnitude looks off` mean wrong numbers were captured (fees, dates,
  inverse rates). Restrict with `--currencies`, or move to selector/json strategy.
  If the site quotes AUD-per-unit instead of units-per-AUD, values will look like 1/x —
  that needs an inversion step; flag it to the developer rather than saving wrong data.

### 3. Wire it to the competitor and test the real engine path
Update the competitor (UI: Competitors → Edit → Advanced; or API):
```bash
curl -s -X PUT localhost:4000/api/competitors/<id> -H 'content-type: application/json' \
  -d '{"scrape_config": <suggested config from step 2>}'
```
One-shot scrape via the saved config (this DOES write on success):
```bash
npm run scrape:verify -- --competitor "<Name>"        # dry-run of the saved config
curl -s -X POST localhost:4000/api/scrape -H 'content-type: application/json' -d '{"competitor_id": <id>}'
```

### 4. Verify the result on the board
```bash
curl -s "localhost:4000/api/scrape/runs?limit=3"      # expect status ok + [rendered]/[static]
curl -s "localhost:4000/api/board?store_id=<store>"   # competitor's row updated, source "online"
```
Cross-check 2–3 currencies by eye against the site. Only then call it verified.

### 5. If bad rows landed
```bash
sqlite3 competitor-intel/data/intel.db \
  "DELETE FROM rates WHERE captured_by='scraper' AND competitor_id=<id> AND captured_at >= datetime('now','-1 hour');"
```
(or reseed demo data entirely: `npm run seed -- --reset` after `rm -f data/intel.db*`).

## Known site notes (update as you learn)

### Travel Money Oz — SOLVED, verified live 2026-08-14
Public unauthenticated rates API (AWS API Gateway; CORS-whitelisted to their site):
`POST https://eeermgmu4a.execute-api.ap-southeast-2.amazonaws.com/Prod/rates/cash/all/v1`
Body (required; UUIDs are echoed trace IDs — engine substitutes `"<uuid>"` placeholders):
`{"RequestId":"<uuid>","CorrelationId":"<uuid>","SourceCurrency":"AUD"}`
- Shape: `Data.Rates[]`, code=`TargetCurrency`, rate=`ExchangeRate`, foreign-units-per-AUD.
- **Sell side only** — the site's buy-back rates are NOT in this feed (suspected separate
  Elasticsearch index `fcl_currency_rates_country_prod`, unprobed). Do not map `buy`.
- **Rows are per-country, not per-currency** (83 rows / 55 codes; EUR appears 21×) — the
  engine's first-wins dedupe handles it; keep `only` filters tight anyway.
- Timestamp: `Data.ConvertedDate` (cash) / `Data.ConversionDate` (card).
  Card rates: same POST to `/Prod/rates/card/all/v1` (14 currencies).
- No bot protection on the API (plain curl works). Flight Centre shared infra — sister
  FCTG travel-money brands likely use the same gateway with different hosts.

### Travelex AU — endpoint known, response shape UNVERIFIED
Their SPA calls a global "salt" API (one backend for all country sites, param `site=/xx`):
`GET https://api.travelex.net/salt/config/multi?key=Travelex&site=%2Fau&options=abhikzl`
- Rates live at `rates.rates` = **object keyed by currency code** (not an array).
  Per-currency value shape (field names, buy/sell, direction) is unknown — ONE GET from an
  unblocked machine settles it; then write a `json` config (engine derives code from keys).
- API docs exist: https://api.travelex.net/docs/api/index.html ("Travelex Ecommerce API (salt)").
- A production scraper (alltheplaces) hits this API with vanilla HTTP — likely no bot wall.
- Until verified, ship the page config (`auto` + `render:true`) and let the engine's
  traffic-sniff auto-discovery find and adopt the real endpoint on first Codespace run.

### Prosegur Change AU — no public trace; rely on auto-discovery
No documented API anywhere public; not even in tracker-radar. Same platform runs all their
country subdomains (`nz.`/`es.`/`de.`… `prosegurchange.com`) so an approach proven on any
one transfers to AU. Config: `auto` + `render:true` + `waitSelector: 'table tbody tr'`;
the sniffer will surface their XHR if one exists.

### Claude cloud sandbox egress (this repo's sessions)
The three sites' HTML pages AND `api.travelex.net` are egress-blocked, but
`*.execute-api.ap-southeast-2.amazonaws.com` IS reachable — the TMOZ API verifies from
inside the sandbox. Everything else needs a Codespace/user machine: hand the user
`bash competitor-intel/scripts/verify-live.sh` and tune from the pasted output.
