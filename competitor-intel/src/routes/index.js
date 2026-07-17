// REST API for the competitor intel tool.
import express from 'express';
import {
  stores as storesRepo,
  competitors as competitorsRepo,
  rates as ratesRepo,
  intel as intelRepo,
  scrapeRuns,
} from '../db.js';
import {
  CURRENCIES,
  CURRENCY_CODES,
  RATE_SOURCES,
  DEFAULTS,
  normaliseRate,
  rateDecimals,
} from '../config.js';
import { buildBoard, seriesPoints, allRatesForCurrency } from '../lib/rates.js';
import { buildInsights, marketTrend } from '../lib/insights.js';
import { parseIntel, flagLabel } from '../lib/intel-parser.js';
import { scrapeAll, scrapeCompetitor } from '../scraper/engine.js';

const router = express.Router();
const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => fail(res, 500, String(e.message || e)));

// Resolve a store id from the query (falls back to the default store).
function resolveStoreId(req) {
  if (req.query.store_id) return Number(req.query.store_id);
  const all = storesRepo.all();
  return all.length ? all[0].id : null;
}
const sideOf = (req) => (String(req.query.side || 'sell').toLowerCase() === 'buy' ? 'buy' : 'sell');

// ---- meta -----------------------------------------------------------------
router.get('/meta', (_req, res) => {
  const list = storesRepo.all();
  ok(res, {
    currencies: CURRENCIES,
    sources: RATE_SOURCES,
    stores: list,
    defaultStoreId: list[0]?.id ?? null,
    scrapeCron: DEFAULTS.scrapeCron,
    autoScrape: DEFAULTS.autoScrape,
    baseCurrency: 'AUD',
  });
});

// ---- stores ---------------------------------------------------------------
router.get('/stores', (_req, res) => ok(res, storesRepo.all()));
router.post('/stores', (req, res) => {
  const { name, location } = req.body || {};
  if (!name || !String(name).trim()) return fail(res, 400, 'Store name is required');
  if (storesRepo.getByName(String(name).trim())) return fail(res, 409, 'A store with that name already exists');
  ok(res, storesRepo.create({ name: String(name).trim(), location: location ? String(location).trim() : null }));
});

// ---- competitors ----------------------------------------------------------
router.get('/competitors', (req, res) => {
  const store_id = req.query.store_id ? Number(req.query.store_id) : null;
  ok(res, competitorsRepo.all({ store_id }));
});

router.post('/competitors', (req, res) => {
  const { name, website, location, scrape_config, notes, is_self, store_id } = req.body || {};
  if (!name || !String(name).trim()) return fail(res, 400, 'Competitor name is required');
  if (!location || !String(location).trim()) return fail(res, 400, 'Location is required');
  const sid = Number(store_id);
  if (!sid || !storesRepo.get(sid)) return fail(res, 400, 'A valid store is required');
  const created = competitorsRepo.create({
    name: String(name).trim(),
    store_id: sid,
    website: website ? String(website).trim() : null,
    location: String(location).trim(),
    is_self: is_self ? 1 : 0,
    scrape_config: scrape_config || null,
    notes: notes || null,
  });
  ok(res, created);
});

router.put('/competitors/:id', (req, res) => {
  const updated = competitorsRepo.update(Number(req.params.id), req.body || {});
  if (!updated) return fail(res, 404, 'Competitor not found');
  ok(res, updated);
});

router.delete('/competitors/:id', (req, res) => {
  const removed = competitorsRepo.remove(Number(req.params.id));
  if (!removed) return fail(res, 404, 'Competitor not found');
  ok(res, { removed: true });
});

// ---- consolidated board ---------------------------------------------------
router.get('/board', (req, res) => {
  const store_id = resolveStoreId(req);
  if (!store_id) return ok(res, { currencies: [], competitors: [], board: [], side: sideOf(req) });
  ok(res, buildBoard(store_id, sideOf(req)));
});

// ---- rates ----------------------------------------------------------------
router.get('/rates/recent', (req, res) =>
  ok(res, ratesRepo.recent(Number(req.query.limit) || 60, req.query.store_id ? Number(req.query.store_id) : null))
);

router.post('/rates', (req, res) => {
  const b = req.body || {};
  const competitor = competitorsRepo.get(Number(b.competitor_id));
  if (!competitor) return fail(res, 400, 'Unknown competitor');
  const currency = String(b.currency || '').toUpperCase();
  if (!CURRENCY_CODES.includes(currency)) return fail(res, 400, `Unknown currency "${b.currency}"`);
  if (b.sell_rate == null && b.buy_rate == null) return fail(res, 400, 'Provide at least a sell or buy rate');
  const source = RATE_SOURCES.includes(b.source) ? b.source : 'counter';
  const sell = b.sell_rate == null || b.sell_rate === '' ? null : normaliseRate(currency, b.sell_rate).value;
  const buy = b.buy_rate == null || b.buy_rate === '' ? null : normaliseRate(currency, b.buy_rate).value;
  const row = ratesRepo.insert({
    competitor_id: competitor.id,
    currency,
    sell_rate: sell,
    buy_rate: buy,
    source,
    captured_by: b.captured_by || null,
    captured_at: b.captured_at || null,
    note: b.note || null,
  });
  ok(res, row);
});

// ---- trends + insights ----------------------------------------------------
router.get('/trends', (req, res) => {
  const competitorId = Number(req.query.competitor_id);
  const currency = String(req.query.currency || '').toUpperCase();
  const days = Number(req.query.days) || 30;
  const competitor = competitorsRepo.get(competitorId);
  if (!competitor) return fail(res, 400, 'Unknown competitor');
  if (!CURRENCY_CODES.includes(currency)) return fail(res, 400, 'Unknown currency');
  const store_id = competitor.store_id;

  const series = ratesRepo.series(competitorId, currency, { sinceDays: days });
  const snapshot = ratesRepo.latestByCurrency(currency, store_id).map((r) => {
    const c = competitorsRepo.get(r.competitor_id);
    return { ...r, competitor_name: c?.name, is_self: c?.is_self };
  });
  const self = competitorsRepo.selfFor(store_id);
  const selfLatest = self ? ratesRepo.latest(self.id, currency) : null;
  const selfRate = selfLatest ? selfLatest.sell_rate ?? selfLatest.buy_rate ?? null : null;
  const relatedIntel = intelRepo.feed({ competitor_id: competitorId, limit: 20 });
  const latest = ratesRepo.latest(competitorId, currency);

  const insight = buildInsights({ competitor, currency, series, snapshot, intel: relatedIntel, selfRate });
  const marketRows = allRatesForCurrency(currency, days, store_id);
  const market = marketTrend(currency, marketRows);
  const marketBuy = marketTrend(currency, marketRows, 'buy');

  ok(res, {
    competitor,
    currency,
    decimals: rateDecimals(currency),
    days,
    series: seriesPoints(series),
    latest: latest ? { sell: latest.sell_rate, buy: latest.buy_rate } : null,
    self: self && selfRate != null ? { name: self.name, value: selfRate } : null,
    market,
    marketBuy,
    intel: relatedIntel,
    ...insight,
  });
});

router.get('/trends/market', (req, res) => {
  const currency = String(req.query.currency || '').toUpperCase();
  const days = Number(req.query.days) || 30;
  const store_id = resolveStoreId(req);
  if (!CURRENCY_CODES.includes(currency)) return fail(res, 400, 'Unknown currency');
  ok(res, { currency, days, market: marketTrend(currency, allRatesForCurrency(currency, days, store_id)) });
});

// ---- intel ----------------------------------------------------------------
router.get('/intel', (req, res) => {
  const competitor_id = req.query.competitor_id ? Number(req.query.competitor_id) : null;
  const store_id = req.query.store_id ? Number(req.query.store_id) : null;
  const feed = intelRepo.feed({ competitor_id, store_id, limit: Number(req.query.limit) || 100 });
  ok(res, feed.map((n) => ({ ...n, flagLabels: (n.flags || []).map(flagLabel) })));
});

router.post('/intel/preview', (req, res) => {
  const store_id = req.body?.store_id ? Number(req.body.store_id) : null;
  const comps = competitorsRepo.all({ store_id }).map((c) => ({ id: c.id, name: c.name }));
  const parsed = parseIntel(req.body?.raw_text || '', {
    competitors: comps,
    defaultCurrency: req.body?.currency || null,
  });
  ok(res, { ...parsed, flagLabels: parsed.flags.map(flagLabel) });
});

router.post('/intel', (req, res) => {
  const b = req.body || {};
  const raw = String(b.raw_text || '').trim();
  if (!raw) return fail(res, 400, 'Intel text is required');
  const store_id = b.store_id ? Number(b.store_id) : null;
  const comps = competitorsRepo.all({ store_id });
  const parsed = parseIntel(raw, {
    competitors: comps.map((c) => ({ id: c.id, name: c.name })),
    defaultCurrency: b.currency || null,
  });
  const competitorId = b.competitor_id ? Number(b.competitor_id) : parsed.competitorGuess?.id || null;
  const currency = (b.currency || parsed.primaryCurrency || null)?.toUpperCase() || null;

  const note = intelRepo.insert({
    competitor_id: competitorId,
    raw_text: raw,
    parsed,
    currency,
    flags: parsed.flags,
    created_by: b.created_by || null,
  });

  const promoted = [];
  if (b.captureRates !== false && competitorId) {
    for (const r of parsed.rates) {
      if (r.value == null) continue;
      const row = ratesRepo.insert({
        competitor_id: competitorId,
        currency: r.currency,
        sell_rate: r.value,
        source: 'intel',
        captured_by: b.created_by || 'intel',
        note: `from intel: "${raw.slice(0, 80)}"`,
        intel_id: note.id,
      });
      promoted.push(row);
    }
  }
  ok(res, { note: { ...note, flagLabels: parsed.flags.map(flagLabel) }, parsed, promotedRates: promoted });
});

// ---- scraping -------------------------------------------------------------
router.post('/scrape', asyncH(async (req, res) => {
  const id = req.body?.competitor_id;
  if (id) {
    const c = competitorsRepo.get(Number(id));
    if (!c) return fail(res, 404, 'Competitor not found');
    const result = await scrapeCompetitor(c);
    return ok(res, [{ competitor: c.name, competitor_id: c.id, ...result }]);
  }
  const results = await scrapeAll();
  ok(res, results);
}));

router.get('/scrape/runs', (req, res) =>
  ok(res, scrapeRuns.recent(Number(req.query.limit) || 40, req.query.store_id ? Number(req.query.store_id) : null))
);

export default router;
