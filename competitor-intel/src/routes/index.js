// REST API for the competitor intel tool.
import express from 'express';
import {
  competitors as competitorsRepo,
  rates as ratesRepo,
  intel as intelRepo,
  scrapeRuns,
} from '../db.js';
import {
  CURRENCIES,
  CURRENCY_CODES,
  CURRENCY_MAP,
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

// ---- meta -----------------------------------------------------------------
router.get('/meta', (_req, res) =>
  ok(res, {
    currencies: CURRENCIES,
    sources: RATE_SOURCES,
    scrapeCron: DEFAULTS.scrapeCron,
    autoScrape: DEFAULTS.autoScrape,
    baseCurrency: 'AUD',
  })
);

// ---- competitors ----------------------------------------------------------
router.get('/competitors', (_req, res) => ok(res, competitorsRepo.all()));

router.post('/competitors', (req, res) => {
  const { name, website, location, scrape_config, notes, is_self } = req.body || {};
  if (!name || !String(name).trim()) return fail(res, 400, 'Competitor name is required');
  if (!location || !String(location).trim()) return fail(res, 400, 'Location is required');
  if (competitorsRepo.getByName(String(name).trim())) return fail(res, 409, 'A competitor with that name already exists');
  const created = competitorsRepo.create({
    name: String(name).trim(),
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
router.get('/board', (_req, res) => ok(res, buildBoard()));

// ---- rates ----------------------------------------------------------------
router.get('/rates/recent', (req, res) => ok(res, ratesRepo.recent(Number(req.query.limit) || 60)));

router.post('/rates', (req, res) => {
  const b = req.body || {};
  const competitor = competitorsRepo.get(Number(b.competitor_id));
  if (!competitor) return fail(res, 400, 'Unknown competitor');
  const currency = String(b.currency || '').toUpperCase();
  if (!CURRENCY_CODES.includes(currency)) return fail(res, 400, `Unknown currency "${b.currency}"`);
  if (b.sell_rate == null && b.buy_rate == null) return fail(res, 400, 'Provide at least a sell rate');
  const source = RATE_SOURCES.includes(b.source) ? b.source : 'counter';
  const sell = b.sell_rate == null ? null : normaliseRate(currency, b.sell_rate).value;
  const buy = b.buy_rate == null ? null : normaliseRate(currency, b.buy_rate).value;
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

  const series = ratesRepo.series(competitorId, currency, { sinceDays: days });
  const snapshot = ratesRepo.latestByCurrency(currency).map((r) => {
    const c = competitorsRepo.get(r.competitor_id);
    return { ...r, competitor_name: c?.name, is_self: c?.is_self };
  });
  const self = competitorsRepo.all().find((c) => c.is_self);
  const selfLatest = self ? ratesRepo.latest(self.id, currency) : null;
  const selfRate = selfLatest ? selfLatest.sell_rate ?? selfLatest.buy_rate ?? null : null;
  const relatedIntel = intelRepo.feed({ competitor_id: competitorId, limit: 20 });

  const insight = buildInsights({ competitor, currency, series, snapshot, intel: relatedIntel, selfRate });
  const market = marketTrend(currency, allRatesForCurrency(currency, days));

  ok(res, {
    competitor,
    currency,
    decimals: rateDecimals(currency),
    days,
    series: seriesPoints(series),
    self: self && selfRate != null ? { name: self.name, value: selfRate } : null,
    market,
    intel: relatedIntel,
    ...insight,
  });
});

router.get('/trends/market', (req, res) => {
  const currency = String(req.query.currency || '').toUpperCase();
  const days = Number(req.query.days) || 30;
  if (!CURRENCY_CODES.includes(currency)) return fail(res, 400, 'Unknown currency');
  ok(res, { currency, days, market: marketTrend(currency, allRatesForCurrency(currency, days)) });
});

// ---- intel ----------------------------------------------------------------
router.get('/intel', (req, res) => {
  const competitor_id = req.query.competitor_id ? Number(req.query.competitor_id) : null;
  const feed = intelRepo.feed({ competitor_id, limit: Number(req.query.limit) || 100 });
  ok(res, feed.map((n) => ({ ...n, flagLabels: (n.flags || []).map(flagLabel) })));
});

// Live preview — parse text without saving (used as staff type).
router.post('/intel/preview', (req, res) => {
  const comps = competitorsRepo.all().map((c) => ({ id: c.id, name: c.name }));
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
  const comps = competitorsRepo.all();
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

  // Optionally promote parsed rates into the rates table (source='intel').
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

router.get('/scrape/runs', (req, res) => ok(res, scrapeRuns.recent(Number(req.query.limit) || 40)));

export default router;
