# Crown Currency — Competitor Intelligence Tool

A live, consolidated view of what competitors are doing on foreign-exchange rates —
replacing the manually-updated Google Sheet with a real dashboard that builds trends
over time and turns floor chatter into structured, actionable intel.

Built for frontline staff: capture what you hear at the counter, scrape competitor
websites for online rates, and get an auto-generated read on what a competitor is
likely doing in-store.

---

## What it does

| # | Goal | How it's delivered |
|---|------|--------------------|
| 1 | **Scrape competitor websites** into a live consolidated dashboard | Config-driven scraping engine (`auto` / `selector` / `json` strategies) + hourly scheduler. The **Dashboard** shows the latest rate from every competitor per currency, ranked, with best/worst/spread. |
| 2 | **Enter counter-heard rates** and see them consolidated | **Capture → Log a counter rate**. Rates land on the same board as scraped ones, tagged by source (online / counter / customer intel). |
| 3 | **Smart intel section** that ingests free-text comments | **Capture → Log free-text intel**. A parser extracts currency + rate, stock-outs, restock ETAs ("till coming Thur"), promos and undercutting — live as you type. |
| 4 | **Trends over time** + reporting | Every rate is time-stamped. **Trends** renders history per competitor/currency, plus market-average and Crown overlays. Insights compute 7/30-day change, volatility, and activity. |
| 5 | **Pick competitor + currency** → trends + smart insights panel | The **Trends & Insights** view: two dropdowns + a timeframe toggle, a chart, and a narrative **Smart Insights** panel. |
| 6 | **Onboard competitors** (name*, website, location*) | **Competitors** tab: add/edit/remove, with optional scrape config. Name and location are required. |

---

## Quick start

```bash
cd competitor-intel
npm install         # installs express, better-sqlite3, cheerio, node-cron
npm run seed        # loads demo competitors + 30 days of trend history + sample intel
npm start           # → http://localhost:4000
```

Open **http://localhost:4000**. To start empty instead of with demo data, skip
`npm run seed` (or run `npm run seed -- --reset` to wipe and reseed).

Requirements: Node.js 18+ (developed on Node 22).

---

## Run in GitHub Codespaces (one-click)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/namansharma14/Arduino?ref=claude/competitor-intel-tool-yqwfok)

Best way to test, iterate, and showcase internally without installing anything. Click the
badge above (or **Code ▾ → Codespaces → Create codespace**). The included
[`.devcontainer`](../.devcontainer/devcontainer.json) automatically runs `npm install`,
seeds the demo data, starts the app, and forwards port **4000** — the dashboard opens on
its own.

**To share the live app with colleagues:** open the **PORTS** tab → right-click port
**4000** → **Port Visibility → Public** (or **Organization**), then send them the
`https://…-4000.app.github.dev` URL. Stop the Codespace when you're done to conserve hours.

---

## How rates are modelled

Everything uses one convention so numbers are always comparable:

> **A rate = foreign-currency units per 1 AUD** (how much travel money the customer
> gets for one Australian dollar). **Higher = better for the customer.**

- `sell_rate` — customer buys travel money (the headline board number).
- `buy_rate` — optional buy-back rate.
- Loose input is normalised per-currency: typing **`64`** for USD becomes **`0.6400`**;
  `9800` for JPY becomes `98`. A `?` marker flags anything we rescaled so staff can confirm.

---

## Capturing intel

The parser (`src/lib/intel-parser.js`) is rule-based — no external LLM/API key needed —
and runs live in the Capture screen. Example:

```
"travel money oz is doing usd at 64 but don't have stock till coming Thur"
```

is parsed into:

- **Competitor:** Travel Money Oz (matched by name)
- **Rate:** USD 0.6400 *(rescaled from “64”)*
- **Flags:** out of stock · restock expected
- **ETA:** Thursday

If a competitor is identified, the detected rate is also promoted onto the board
(source = *intel*), so a rate overheard at the counter shows up in trends immediately.

> Want AI enrichment later? The parser returns a clean structured object — drop an LLM
> call in `parseIntel()` and merge its output. See `src/lib/claude-api` note in the code
> comments for where a call would slot in.

---

## Onboarding a competitor

**Competitors → Add competitor.** Required: **Name** and **Location**. Optional:
website, notes, and an auto-scrape config.

### Scrape configuration

Competitors are manual-only until you give them a scrape config. Three strategies:

**1. `auto`** — scans the page text for currency codes and nearby numbers. Fastest to set up:

```json
{ "strategy": "auto", "url": "https://competitor.com/exchange-rates",
  "currencies": ["USD", "EUR", "GBP", "JPY"] }
```

**2. `selector`** — precise extraction from an HTML rate table (via CSS selectors):

```json
{ "strategy": "selector", "url": "https://competitor.com/rates",
  "rowSelector": "table.rates tbody tr",
  "fields": { "code": { "selector": "td.currency" },
              "sell": { "selector": "td.sell-rate" },
              "buy":  { "selector": "td.buy-rate" } } }
```

**3. `json`** — for sites backed by a JSON rates API:

```json
{ "strategy": "json", "url": "https://competitor.com/api/rates",
  "items": "data.rates", "map": { "code": "currencyCode", "sell": "sellRate" } }
```

Run scrapes from the UI (**Scrape all now** / per-competitor **Scrape**), the CLI
(`npm run scrape` or `npm run scrape -- "Travel Money Oz"`), or let the scheduler run
hourly. Every run is logged (ok / partial / error) in the Competitors view. Scraping is
best-effort — if a site changes or blocks bots, the manual/intel paths still work.

---

## Insights

For the selected competitor + currency, the engine (`src/lib/insights.js`) reports:

- Latest rate + time, last move (direction & %), 7-day and 30-day change
- Volatility and **number of rate changes this week** ("actively repricing" signal)
- Live rank vs the field, gap to market-best and to Crown's own rate
- Stock/promo signals pulled from recent intel

Signals are colour-coded (info / watch / alert) with a plain-English narrative a staff
member can act on — e.g. *"Travel Money Oz has changed USD 6 times this week — actively
repricing (watch for stock clearing or a rate war)."*

---

## API reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/meta` | Currencies, sources, config |
| GET/POST | `/api/competitors` | List / onboard (`name*`, `location*`, `website`, `scrape_config`) |
| PUT/DELETE | `/api/competitors/:id` | Edit / remove |
| GET | `/api/board` | Consolidated board (latest rate per competitor per currency, ranked) |
| POST | `/api/rates` | Log a rate |
| GET | `/api/rates/recent` | Recent rate entries |
| GET | `/api/trends?competitor_id=&currency=&days=` | Series + insights |
| GET | `/api/trends/market?currency=&days=` | Market-average trend |
| GET/POST | `/api/intel` | Feed / add intel (auto-parses & promotes rates) |
| POST | `/api/intel/preview` | Parse text without saving (live preview) |
| POST | `/api/scrape` | Scrape all, or one via `{ competitor_id }` |
| GET | `/api/scrape/runs` | Recent scrape runs |

---

## Project layout

```
competitor-intel/
├── src/
│   ├── server.js            Express app + hourly scrape scheduler
│   ├── db.js                SQLite schema + typed repositories
│   ├── config.js            Currencies, rate normalisation, defaults
│   ├── seed.js              Demo data
│   ├── scrape-cli.js        CLI scraper
│   ├── lib/
│   │   ├── intel-parser.js  Free-text → structured signals
│   │   ├── insights.js      Trend stats + narrative
│   │   └── rates.js         Board consolidation + series shaping
│   ├── scraper/
│   │   ├── engine.js        Fetch + persist + run logging
│   │   └── adapters.js      auto / selector / json strategies
│   ├── routes/index.js      REST API
│   └── public/              Dashboard SPA (no build step, no external deps)
└── data/                    SQLite DB (created at runtime, gitignored)
```

## Configuration (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `4000` | HTTP port |
| `AUTO_SCRAPE` | `true` | Set `false` to disable the scheduler |
| `SCRAPE_CRON` | `0 * * * *` | Scrape schedule (hourly) |
| `DATA_DIR` / `DB_PATH` | `./data` | Where the SQLite file lives |

---

## Notes & roadmap

- **Data lives in `data/intel.db`** (SQLite). Back it up to keep history; delete it to
  start fresh. For multi-site/multi-user use, point `DB_PATH` at shared storage or
  migrate to Postgres (the repositories in `db.js` are the only thing to swap).
- **Deployment:** any Node host (Render/Railway/Fly/an internal VM). It's a single
  process serving both API and UI.
- **Future:** LLM enrichment of intel, email/Slack alerts on undercut/stock-out signals,
  and per-branch boards.
