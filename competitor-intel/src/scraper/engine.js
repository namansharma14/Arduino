// Scrape orchestrator: fetch a competitor's rate page, run its extraction
// strategy, persist the resulting rates (source='online') and record a run.

import { competitors as competitorsRepo, rates as ratesRepo, scrapeRuns } from '../db.js';
import { DEFAULTS } from '../config.js';
import { runStrategy } from './adapters.js';

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
    const wantsRender = !!config.render || (config.strategy || '').toLowerCase() === 'browser';
    let payload;
    let mode = 'static';
    if (wantsRender) {
      try {
        const { renderPage } = await import('./browser.js');
        const rendered = await renderPage(config.url, {
          timeoutMs: DEFAULTS.scrapeTimeoutMs + 15000,
          waitSelector: config.waitSelector || null,
          userAgent: DEFAULTS.userAgent,
        });
        payload = rendered.html;
        mode = 'rendered';
      } catch (e) {
        // Fall back to static HTML so a missing browser degrades, not breaks.
        payload = await fetchPayload(config.url, config);
        mode = `static (render unavailable: ${String(e.message).slice(0, 90)})`;
      }
    } else {
      payload = await fetchPayload(config.url, config);
    }
    let extracted = runStrategy(payload, config);
    // Optional whitelist of currencies to keep
    if (config.only && Array.isArray(config.only)) {
      const set = new Set(config.only.map((c) => c.toUpperCase()));
      extracted = extracted.filter((r) => set.has(r.currency));
    }
    if (persist) {
      for (const r of extracted) {
        ratesRepo.insert({
          competitor_id: competitor.id,
          currency: r.currency,
          sell_rate: r.sell_rate,
          buy_rate: r.buy_rate,
          source: 'online',
          captured_by: 'scraper',
          note: `auto-scraped from ${config.url}`,
        });
      }
    }
    const status = extracted.length ? 'ok' : 'partial';
    const message = extracted.length
      ? `Found ${extracted.length} rate(s) [${mode}]: ${extracted.map((r) => r.currency).join(', ')}`
      : `Fetched page [${mode}] but extracted no rates — run: npm run scrape:verify -- "${config.url}"`;
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
