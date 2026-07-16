// Rate helpers for building the consolidated "board" view + series shaping.
import db, { competitors as competitorsRepo, rates as ratesRepo } from '../db.js';
import { rankSnapshot, marketTrend } from './insights.js';
import { rateDecimals } from '../config.js';

// Consolidated board for one store. `side` = 'sell' (default) or 'buy'.
// For each currency with data: each competitor's latest rate (sell + buy),
// ranked by the chosen side, plus market best / worst / average / spread.
export function buildBoard(store_id, side = 'sell') {
  const currencies = ratesRepo.currenciesTracked(store_id);
  const comps = competitorsRepo.all({ includeInactive: false, store_id });
  const compById = new Map(comps.map((c) => [c.id, c]));
  const self = comps.find((c) => c.is_self) || null;

  const board = [];
  for (const currency of currencies) {
    const latest = ratesRepo.latestByCurrency(currency, store_id).filter((r) => compById.has(r.competitor_id));
    if (!latest.length) continue;
    const ranked = rankSnapshot(currency, latest, side).map((r) => ({
      competitor_id: r.competitor_id,
      competitor: compById.get(r.competitor_id)?.name,
      is_self: !!compById.get(r.competitor_id)?.is_self,
      sell_rate: r.sell_rate,
      buy_rate: r.buy_rate,
      value: r._v,
      display: r._v?.toFixed(rateDecimals(currency)),
      sellDisplay: r.sell_rate?.toFixed(rateDecimals(currency)),
      buyDisplay: r.buy_rate?.toFixed(rateDecimals(currency)),
      source: r.source,
      captured_at: r.captured_at,
      rank: r.rank,
      best: r.best,
      worst: r.worst,
      stale: isStale(r.captured_at),
    }));
    const vals = ranked.map((r) => r.value);
    const selfRow = ranked.find((r) => r.is_self);
    const spark = marketTrend(currency, allRatesForCurrency(currency, 14, store_id), side).map((d) => ({
      t: `${d.day}T12:00:00Z`,
      v: d.avg,
    }));
    board.push({
      currency,
      decimals: rateDecimals(currency),
      side,
      rows: ranked,
      best: ranked[0] || null,
      worst: ranked[ranked.length - 1] || null,
      avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      spread: vals.length ? Math.max(...vals) - Math.min(...vals) : null,
      selfRank: selfRow?.rank ?? null,
      count: ranked.length,
      spark,
    });
  }
  return { currencies, competitors: comps, self, side, board };
}

// A rate older than 36h is considered stale (worth re-checking).
export function isStale(capturedAt) {
  if (!capturedAt) return true;
  const t = new Date(capturedAt.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - t > 36 * 3600 * 1000;
}

// Shape a series into chart-ready points (keeps both sell and buy).
export function seriesPoints(rows) {
  return rows
    .map((r) => ({
      t: new Date((r.captured_at || '').replace(' ', 'T') + 'Z').toISOString(),
      sell: r.sell_rate,
      buy: r.buy_rate,
      source: r.source,
      note: r.note,
    }))
    .filter((p) => p.sell != null || p.buy != null);
}

// Every rate row for a currency across a store's competitors (for market trends).
export function allRatesForCurrency(currency, sinceDays = 30, store_id = null) {
  const clause = store_id ? 'AND c.store_id = ?' : '';
  const params = [currency.toUpperCase(), `-${sinceDays} days`];
  if (store_id) params.push(store_id);
  return db
    .prepare(
      `SELECT r.*, c.name AS competitor_name, c.is_self FROM rates r
       JOIN competitors c ON c.id = r.competitor_id
       WHERE r.currency = ? AND c.active = 1
         AND r.captured_at >= datetime('now', ?) ${clause}
       ORDER BY r.captured_at ASC`
    )
    .all(...params);
}
