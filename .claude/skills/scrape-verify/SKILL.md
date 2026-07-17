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

- Travel Money Oz `/rates`, Travelex `/rates`, Prosegur `/exchange-rates`: big JS-rendered
  sites; assume `render: true` minimum, expect a sniffable rates API; may bot-block plain curl.
- Unreachable from the Claude cloud sandbox (egress allowlist) — verification must run in a
  Codespace or on a user machine.
