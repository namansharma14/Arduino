// Scrape orchestrator: fetch a competitor's rate page, run its extraction
// strategy, persist the resulting rates (source='online') and record a run.
//
// The engine is self-tuning. When a rendered page yields nothing (rates drawn in
// a canvas, shadow DOM, etc.) it looks at the JSON the page itself fetched,
// extracts the rates from there and — on a persisting run — adopts that endpoint
// as the competitor's scrape_config, so later runs are a plain static fetch.
// An adopted config that stops working renders its page_url again and re-discovers.

import { competitors as competitorsRepo, rates as ratesRepo, scrapeRuns } from '../db.js';
import { DEFAULTS, CURRENCY_MAP } from '../config.js';
import { runStrategy, autoJsonStrategy } from './adapters.js';

const MAX_SNIFF_CANDIDATES = 5;
// Reject a rate more than ~5x away from the currency's typical units-per-AUD.
const SANITY_LOG10 = 0.7;

async function fetchPayload(url, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULTS.scrapeTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': DEFAULTS.userAgent,
        Accept: config.strategy === 'json' ? 'application/json,*/*' : 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return config.strategy === 'json' ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function renderAndSniff(url, config) {
  const { renderPage } = await import('./browser.js');
  return renderPage(url, {
    timeoutMs: DEFAULTS.scrapeTimeoutMs + 15000,
    waitSelector: config.waitSelector || null,
    userAgent: DEFAULTS.userAgent,
    sniff: true,
  });
}

function limitToWanted(rows, config) {
  if (!config.only || !Array.isArray(config.only)) return rows;
  const set = new Set(config.only.map((c) => c.toUpperCase()));
  return rows.filter((r) => set.has(r.currency));
}

// Drop rates whose magnitude can't be right for the currency. `strict` also judges
// the number as published (row.raw), because normaliseRate would otherwise rescale
// a wrongly-guessed field into a plausible-looking rate — fine for a hand-written
// config that knows its units, not for one we guessed ourselves.
function filterSane(rows, { strict = false } = {}) {
  const kept = [];
  let dropped = 0;
  for (const r of rows) {
    const typical = CURRENCY_MAP[r.currency]?.typical;
    const checked = typical ? [r.sell_rate, r.buy_rate, ...(strict ? [r.raw] : [])] : [];
    const bad = checked.some((v) => v != null && isFinite(v) && v > 0 && Math.abs(Math.log10(v / typical)) > SANITY_LOG10);
    if (bad) dropped++;
    else kept.push(r);
  }
  return { kept, dropped };
}

function shortUrl(u) {
  try {
    const { host, pathname } = new URL(u);
    return `${host}${pathname.length > 48 ? `${pathname.slice(0, 48)}…` : pathname}`;
  } catch {
    return String(u).slice(0, 60);
  }
}

// Try the JSON responses the page fetched. First one yielding a sane rate wins.
// Returns { rates, dropped, hit, items, map } or null.
function discoverFromTraffic(jsonHits, config) {
  for (const hit of (jsonHits || []).slice(0, MAX_SNIFF_CANDIDATES)) {
    const text = hit.body || hit.sample || '';
    if (!text) continue;
    let found = null;
    try {
      const shaped = autoJsonStrategy(text, config);
      if (shaped.rates.length) found = { rates: shaped.rates, items: shaped.items, map: shaped.map };
    } catch {
      /* truncated or non-JSON body — the text scan below still gets a go */
    }
    if (!found) {
      const scanned = runStrategy(text, { ...config, strategy: 'auto' });
      if (scanned.length) found = { rates: scanned, items: null, map: null };
    }
    if (!found) continue;
    const { kept, dropped } = filterSane(limitToWanted(found.rates, config), { strict: true });
    if (kept.length) return { ...found, rates: kept, dropped, hit };
  }
  return null;
}

function adoptConfig(competitor, config, discovery) {
  const carry = config.only || config.currencies || null;
  const adopted = {
    strategy: 'json',
    url: discovery.hit.url,
    items: discovery.items,
    map: discovery.map,
    ...(carry ? { only: carry.map((c) => String(c).toUpperCase()) } : {}),
    page_url: config.page_url || config.url,
    adopted: 'auto-discovered from page traffic',
  };
  if (JSON.stringify(adopted) === JSON.stringify(config)) return false;
  competitorsRepo.update(competitor.id, { scrape_config: adopted });
  return true;
}

// Scrape one competitor. Returns { status, rates_found, message, rates }.
// If config.render is true (or strategy is 'browser'), the page is rendered in
// headless Chromium first so JS-injected rates are visible to the extractor.
export async function scrapeCompetitor(competitor, { persist = true } = {}) {
  const config = competitor.scrape_config;
  if (!config || !config.url) {
    return { status: 'skipped', rates_found: 0, message: 'No scrape config (manual-only competitor)', rates: [] };
  }
  const runId = persist ? scrapeRuns.start(competitor.id) : null;
  try {
    const strategy = (config.strategy || 'auto').toLowerCase();
    const wantsRender = !!config.render || strategy === 'browser';
    const notes = [];
    let mode = strategy === 'json' ? 'json-api' : 'static';
    let extracted = [];
    let jsonHits = [];
    let fetchError = null;

    if (wantsRender) {
      try {
        const rendered = await renderAndSniff(config.url, config);
        jsonHits = rendered.jsonHits || [];
        mode = 'rendered';
        extracted = runStrategy(rendered.html, config);
      } catch (e) {
        // Fall back to static HTML so a missing browser degrades, not breaks.
        extracted = runStrategy(await fetchPayload(config.url, config), config);
        mode = `static (render unavailable: ${String(e.message).slice(0, 90)})`;
      }
    } else {
      try {
        extracted = runStrategy(await fetchPayload(config.url, config), config);
      } catch (e) {
        // A dead adopted endpoint is recoverable — we know which page published it.
        if (!config.page_url) throw e;
        fetchError = e;
        notes.push(`fetch failed (${String(e.message).slice(0, 60)})`);
      }
    }

    let { kept, dropped } = filterSane(limitToWanted(extracted, config), { strict: !!config.adopted });
    extracted = kept;

    let discovery = null;
    if (!extracted.length) {
      if (!jsonHits.length && config.page_url) {
        try {
          const rendered = await renderAndSniff(config.page_url, config);
          jsonHits = rendered.jsonHits || [];
          notes.push('fell back to page render');
        } catch (e) {
          notes.push(`page render failed (${String(e.message).slice(0, 60)})`);
        }
      }
      discovery = discoverFromTraffic(jsonHits, config);
      if (discovery) {
        extracted = discovery.rates;
        dropped += discovery.dropped;
        mode = 'json-api';
        notes.push(`auto-discovered API: ${shortUrl(discovery.hit.url)}`);
        if (persist && discovery.map && adoptConfig(competitor, config, discovery)) notes.push('adopted config');
      }
    }
    if (fetchError && !extracted.length) throw fetchError;

    const sourceUrl = discovery ? discovery.hit.url : config.url;
    if (persist) {
      for (const r of extracted) {
        ratesRepo.insert({
          competitor_id: competitor.id,
          currency: r.currency,
          sell_rate: r.sell_rate,
          buy_rate: r.buy_rate,
          source: 'online',
          captured_by: 'scraper',
          note: `auto-scraped from ${sourceUrl}`,
        });
      }
    }
    const status = extracted.length ? 'ok' : 'partial';
    const detail = notes.length ? ` · ${notes.join(' · ')}` : '';
    const droppedNote = dropped ? ` · dropped ${dropped} implausible rate(s)` : '';
    const message = extracted.length
      ? `Found ${extracted.length} rate(s) [${mode}]: ${extracted.map((r) => r.currency).join(', ')}${detail}${droppedNote}`
      : `Fetched page [${mode}] but extracted no rates${detail}${droppedNote} — run: npm run scrape:verify -- "${config.url}"`;
    if (runId) scrapeRuns.finish(runId, { status, rates_found: extracted.length, message });
    return { status, rates_found: extracted.length, message, rates: extracted };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (runId) scrapeRuns.finish(runId, { status: 'error', rates_found: 0, message });
    return { status: 'error', rates_found: 0, message, rates: [] };
  }
}

// Scrape every active competitor that has a scrape config.
export async function scrapeAll({ persist = true } = {}) {
  const comps = competitorsRepo.all({ includeInactive: false }).filter((c) => c.scrape_config && c.scrape_config.url);
  const results = [];
  for (const c of comps) {
    const r = await scrapeCompetitor(c, { persist });
    results.push({ competitor: c.name, competitor_id: c.id, ...r });
  }
  return results;
}
