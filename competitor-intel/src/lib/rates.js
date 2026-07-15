// Rate helpers for building the consolidated "board" view + series shaping.
import db, { competitors as competitorsRepo, rates as ratesRepo } from '../db.js';
import { rankSnapshot, marketTrend } from './insights.js';
import { rateDecimals } from '../config.js';

// Consolidated board: for every currency that has data, the latest rate from each
// competitor plus market best / worst / average and each competitor's rank.
export function buildBoard() {
  const currencies = ratesRepo.currenciesTracked();
  const comps = competitorsRepo.all({ includeInactive: false });
  const compById = new Map(comps.map((c) => [c.id, c]));
  const self = comps.find((c) => c.is_self) || null;

  const board = [];
  for (const currency of currencies) {
    const latest = ratesRepo.latestByCurrency(currency).filter((r) => compById.has(r.competitor_id));
    if (!latest.length) continue;
    const ranked = rankSnapshot(currency, latest).map((r) => ({
      competitor_id: r.competitor_id,
      competitor: compById.get(r.competitor_id)?.name,
      is_self: !!compById.get(r.competitor_id)?.is_self,
      sell_rate: r.sell_rate,
      buy_rate: r.buy_rate,
      value: r._v,
      display: r._v?.toFixed(rateDecimals(currency)),
      source: r.source,
      captured_at: r.captured_at,
      rank: r.rank,
      best: r.best,
      worst: r.worst,
      stale: isStale(r.captured_at),
    }));
    const vals = ranked.map((r) => r.value);
    const selfRow = ranked.find((r) => r.is_self);
    // 14-day market-average sparkline for the card.
    const spark = marketTrend(currency, allRatesForCurrency(currency, 14)).map((d) => ({
      t: `${d.day}T12:00:00Z`,
      v: d.avg,
    }));
    board.push({
      currency,
      decimals: rateDecimals(currency),
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
  return { currencies, competitors: comps, self, board };
}

// A rate older than 36h is considered stale (worth re-checking).
export function isStale(capturedAt) {
  if (!capturedAt) return true;
  const t = new Date(capturedAt.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - t > 36 * 3600 * 1000;
}

// Shape a series into chart-ready points.
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

// Every rate row for a currency across competitors (for market-trend charts).
export function allRatesForCurrency(currency, sinceDays = 30) {
  return db
    .prepare(
      `SELECT r.*, c.name AS competitor_name, c.is_self FROM rates r
       JOIN competitors c ON c.id = r.competitor_id
       WHERE r.currency = ? AND c.active = 1
         AND r.captured_at >= datetime('now', ?)
       ORDER BY r.captured_at ASC`
    )
    .all(currency.toUpperCase(), `-${sinceDays} days`);
}
