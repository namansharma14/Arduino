// Trend analysis + narrative insight generation.
// Consumes rate rows from the DB and produces stats + plain-English signals that
// a frontline staff member can act on.

import { rateDecimals, CURRENCY_MAP } from '../config.js';

const DAY_MS = 86400000;

function fmt(currency, v) {
  if (v == null || !isFinite(v)) return '—';
  return v.toFixed(rateDecimals(currency));
}
function pct(v) {
  if (v == null || !isFinite(v)) return '—';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(2)}%`;
}
function ts(row) {
  // SQLite datetime('now') stores UTC "YYYY-MM-DD HH:MM:SS"
  return new Date((row.captured_at || '').replace(' ', 'T') + 'Z').getTime();
}

// Value for a given side. 'sell' = customer buys travel money (higher = better for
// them); 'buy' = customer sells foreign back (lower units-per-AUD = better for them).
function val(row, side = 'sell') {
  return side === 'buy' ? (row.buy_rate ?? row.sell_rate ?? null) : (row.sell_rate ?? row.buy_rate ?? null);
}

function valueAtOrBefore(series, targetMs) {
  let pick = null;
  for (const r of series) {
    if (ts(r) <= targetMs) pick = r;
    else break;
  }
  return pick ? val(pick) : null;
}

// Core statistics for a single competitor+currency series (oldest-first).
export function summarizeSeries(currency, series) {
  const pts = series.filter((r) => val(r) != null);
  if (pts.length === 0) return null;
  const last = pts[pts.length - 1];
  const current = val(last);
  const currentAt = last.captured_at;
  const now = ts(last);

  const vals = pts.map(val);
  const high = Math.max(...vals);
  const low = Math.min(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - avg) ** 2, 0) / vals.length;
  const volatility = Math.sqrt(variance);

  const prev = pts.length > 1 ? val(pts[pts.length - 2]) : null;
  const v7 = valueAtOrBefore(pts, now - 7 * DAY_MS);
  const v30 = valueAtOrBefore(pts, now - 30 * DAY_MS);

  const changeAbs = prev != null ? current - prev : null;
  const change7 = v7 != null ? current - v7 : null;
  const change30 = v30 != null ? current - v30 : null;

  // Count meaningful moves in last 7 days (change > 0.05% of value between points).
  let moves = 0;
  const weekAgo = now - 7 * DAY_MS;
  for (let i = 1; i < pts.length; i++) {
    if (ts(pts[i]) < weekAgo) continue;
    const d = Math.abs(val(pts[i]) - val(pts[i - 1]));
    if (d > Math.abs(val(pts[i - 1])) * 0.0005) moves++;
  }

  const direction = changeAbs == null || Math.abs(changeAbs) < current * 0.0005 ? 'flat' : changeAbs > 0 ? 'up' : 'down';

  return {
    currency,
    points: pts.length,
    current,
    currentAt,
    prev,
    high,
    low,
    avg,
    volatility,
    changeAbs,
    changePct: prev ? (changeAbs / prev) * 100 : null,
    change7,
    change7Pct: v7 ? (change7 / v7) * 100 : null,
    change30,
    change30Pct: v30 ? (change30 / v30) * 100 : null,
    moves,
    direction,
    firstAt: pts[0].captured_at,
  };
}

// Rank a board snapshot (rows for one currency, each a competitor's latest rate).
// Rank 1 = best value for the customer: highest sell, or lowest buy.
export function rankSnapshot(currency, rows, side = 'sell') {
  const withVal = rows.map((r) => ({ ...r, _v: val(r, side) })).filter((r) => r._v != null);
  withVal.sort((a, b) => (side === 'buy' ? a._v - b._v : b._v - a._v));
  return withVal.map((r, i) => ({ ...r, rank: i + 1, best: i === 0, worst: i === withVal.length - 1 }));
}

// Build the full insight bundle for a competitor + currency.
//   competitor: hydrated competitor row
//   series:     rate rows (oldest-first) for that competitor+currency
//   snapshot:   latest rate rows across ALL competitors for the currency (with .competitor_name)
//   intel:      recent intel notes mentioning this competitor (hydrated)
//   selfRate:   Crown Currency's own latest value for the currency (or null)
export function buildInsights({ competitor, currency, series, snapshot, intel = [], selfRate = null }) {
  const stats = summarizeSeries(currency, series);
  const ranked = rankSnapshot(currency, snapshot);
  const me = ranked.find((r) => r.competitor_id === competitor.id);
  const rank = me?.rank ?? null;
  const fieldSize = ranked.length;
  const best = ranked[0] ?? null;
  const marketAvg = ranked.length ? ranked.reduce((a, r) => a + r._v, 0) / ranked.length : null;

  const narrative = [];
  const signals = []; // { level: 'info'|'watch'|'alert', text }

  if (!stats) {
    narrative.push(`No rate history yet for ${competitor.name} · ${currency}. Log a counter rate or run a scrape to start the trend.`);
    return { stats, rank, fieldSize, marketAvg, ranked, signals, narrative };
  }

  const cur = fmt(currency, stats.current);
  narrative.push(`Latest ${currency} at ${competitor.name}: ${cur} per AUD (as of ${humanTime(stats.currentAt)}).`);

  // Direction / recent move
  if (stats.direction !== 'flat' && stats.changePct != null) {
    const word = stats.direction === 'up' ? 'improved' : 'worsened';
    const forCust = stats.direction === 'up' ? 'better for customers' : 'worse for customers';
    narrative.push(`Last move ${word} to ${cur} (${pct(stats.changePct)}) — ${forCust}.`);
    signals.push({
      level: stats.direction === 'down' ? 'watch' : 'info',
      text: `${currency} ${stats.direction === 'up' ? '↑' : '↓'} ${pct(stats.changePct)} on last update`,
    });
  }

  // 7-day view
  if (stats.change7Pct != null && Math.abs(stats.change7Pct) >= 0.1) {
    const dir = stats.change7 > 0 ? 'up' : 'down';
    narrative.push(`Over 7 days ${currency} is ${dir} ${pct(stats.change7Pct)} (from ${fmt(currency, stats.current - stats.change7)} to ${cur}).`);
  }

  // Activity / volatility
  if (stats.moves >= 3) {
    signals.push({ level: 'watch', text: `Very active: ${stats.moves} rate changes in the last 7 days` });
    narrative.push(`${competitor.name} has changed ${currency} ${stats.moves} times this week — actively repricing (watch for stock clearing or a rate war).`);
  } else if (stats.moves === 0) {
    narrative.push(`${currency} has been stable for ${competitor.name} recently (no changes in the last 7 days).`);
  }

  // Competitive position
  if (rank && fieldSize > 1) {
    const label = rank === 1 ? 'the best rate' : rank === fieldSize ? 'the worst rate' : `#${rank} of ${fieldSize}`;
    narrative.push(`Right now ${competitor.name} offers ${label} in the tracked field for ${currency}.`);
    if (rank === 1) signals.push({ level: 'alert', text: `Currently market-leading on ${currency} — likely winning walk-ins` });
    if (best && best.competitor_id !== competitor.id) {
      const gap = ((best._v - stats.current) / stats.current) * 100;
      narrative.push(`Market best is ${best.competitor_name} at ${fmt(currency, best._v)} (${pct(gap)} vs ${competitor.name}).`);
    }
  }

  // Versus Crown (self)
  if (selfRate != null && !competitor.is_self) {
    const gap = ((stats.current - selfRate) / selfRate) * 100;
    if (gap > 0.05) {
      signals.push({ level: 'alert', text: `Beating Crown on ${currency} by ${pct(gap)} — customers get more with them` });
      narrative.push(`⚠ ${competitor.name} is beating Crown on ${currency}: ${cur} vs our ${fmt(currency, selfRate)} (${pct(gap)}).`);
    } else if (gap < -0.05) {
      narrative.push(`Crown is ahead of ${competitor.name} on ${currency}: our ${fmt(currency, selfRate)} vs their ${cur} (${pct(-gap)} better for us).`);
    } else {
      narrative.push(`Crown and ${competitor.name} are line-ball on ${currency} (${fmt(currency, selfRate)} vs ${cur}).`);
    }
  }

  // Range context
  narrative.push(`30-day range: ${fmt(currency, stats.low)} – ${fmt(currency, stats.high)} (avg ${fmt(currency, stats.avg)}).`);

  // Intel-derived signals (stock, promos)
  const flagSet = new Set();
  for (const n of intel) for (const f of n.flags || []) flagSet.add(f);
  if (flagSet.has('stock_out')) signals.push({ level: 'alert', text: 'Recent intel: reported OUT OF STOCK — opportunity to capture demand' });
  if (flagSet.has('low_stock')) signals.push({ level: 'watch', text: 'Recent intel: running low on stock' });
  if (flagSet.has('promo')) signals.push({ level: 'watch', text: 'Recent intel: running a promotion / fee offer' });
  if (flagSet.has('beating_us')) signals.push({ level: 'alert', text: 'Recent intel: undercutting Crown' });

  // Headline signal if none yet
  if (signals.length === 0) signals.push({ level: 'info', text: `Stable — ${currency} holding around ${cur}` });

  return { stats, rank, fieldSize, marketAvg, ranked, signals, narrative };
}

// Market trend: average customer rate across all competitors per day bucket.
export function marketTrend(currency, allRows, side = 'sell') {
  // allRows: every rate row for the currency across competitors (any order)
  const byDay = new Map(); // day -> {sum,count}
  for (const r of allRows) {
    const v = val(r, side);
    if (v == null) continue;
    const day = (r.captured_at || '').slice(0, 10);
    const b = byDay.get(day) || { sum: 0, count: 0, min: Infinity, max: -Infinity };
    b.sum += v;
    b.count += 1;
    b.min = Math.min(b.min, v);
    b.max = Math.max(b.max, v);
    byDay.set(day, b);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, b]) => ({ day, avg: b.sum / b.count, min: b.min, max: b.max, count: b.count }));
}

function humanTime(sqlTime) {
  if (!sqlTime) return 'unknown';
  const d = new Date(sqlTime.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' });
}
