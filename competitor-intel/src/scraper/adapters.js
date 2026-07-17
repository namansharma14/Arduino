// Extraction strategies. Each takes the fetched payload + the competitor's
// scrape_config and returns an array of { currency, sell_rate, buy_rate, raw }.
//
// Strategies are intentionally config-driven so a new competitor can be onboarded
// by pasting a small JSON blob rather than writing code. Because every currency
// site is laid out differently, "auto" gives a best-effort fallback that scans the
// page text for currency codes and nearby numbers.

import * as cheerio from 'cheerio';
import { CURRENCY_CODES, CURRENCY_ALIASES, normaliseRate } from '../config.js';

function num(text) {
  if (text == null) return null;
  const m = String(text).replace(/[, ]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// --- selector strategy: cheerio over an HTML table / list of rows -----------
function selectorStrategy(html, config) {
  const $ = cheerio.load(html);
  const out = [];
  const rows = config.rowSelector ? $(config.rowSelector) : $('tr');
  const f = config.fields || {};
  rows.each((_, el) => {
    const row = $(el);
    const pick = (spec) => {
      if (!spec) return null;
      const node = spec.selector ? row.find(spec.selector) : row;
      let v = spec.attr ? node.attr(spec.attr) : node.text();
      if (spec.regex && v) {
        const m = new RegExp(spec.regex).exec(v);
        v = m ? m[1] ?? m[0] : v;
      }
      return v == null ? null : v.trim();
    };
    let code = (pick(f.code) || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    if (!CURRENCY_CODES.includes(code)) {
      // try mapping a currency name found in the row to a code
      code = matchCurrencyName(row.text()) || code;
    }
    if (!CURRENCY_CODES.includes(code)) return;
    const sell = normaliseRate(code, num(pick(f.sell))).value;
    const buy = f.buy ? normaliseRate(code, num(pick(f.buy))).value : null;
    if (sell != null || buy != null) out.push({ currency: code, sell_rate: sell, buy_rate: buy });
  });
  return dedupe(out);
}

// --- json strategy: fetch a JSON API and map fields -------------------------
// config.items = JSON pointer-ish path to an array; config.map = { code, sell, buy }
function jsonStrategy(payload, config) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const items = config.items ? getPath(data, config.items) : data;
  if (!Array.isArray(items)) return [];
  const map = config.map || {};
  const out = [];
  for (const it of items) {
    const code = String(getPath(it, map.code || 'code') || '').toUpperCase().slice(0, 3);
    if (!CURRENCY_CODES.includes(code)) continue;
    const sell = normaliseRate(code, num(getPath(it, map.sell || 'sell'))).value;
    const buy = map.buy ? normaliseRate(code, num(getPath(it, map.buy))).value : null;
    if (sell != null || buy != null) out.push({ currency: code, sell_rate: sell, buy_rate: buy });
  }
  return dedupe(out);
}

// --- auto strategy: scan visible text for "CODE ... number" -----------------
function autoStrategy(html, config) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ');
  const wanted = (config.currencies && config.currencies.length ? config.currencies : CURRENCY_CODES).map((c) => c.toUpperCase());
  const out = [];
  for (const code of wanted) {
    const aliases = [code, ...(CURRENCY_ALIASES[code] || [])];
    let found = null;
    for (const a of aliases) {
      const re = new RegExp(`(?<![a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])\\D{0,15}(\\d+(?:\\.\\d+)?)`, 'i');
      const m = re.exec(text);
      if (m) {
        found = parseFloat(m[1]);
        break;
      }
    }
    if (found != null) {
      const { value } = normaliseRate(code, found);
      if (value != null) out.push({ currency: code, sell_rate: value, buy_rate: null });
    }
  }
  return dedupe(out);
}

function matchCurrencyName(text) {
  const t = text.toLowerCase();
  for (const [code, aliases] of Object.entries(CURRENCY_ALIASES)) {
    for (const a of aliases) {
      if (new RegExp(`(?<![a-z])${a}(?![a-z])`).test(t)) return code;
    }
  }
  return null;
}

function getPath(obj, path) {
  if (!path) return obj;
  return String(path)
    .split('.')
    .reduce((o, k) => (o == null ? o : o[k]), obj);
}

function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) if (!seen.has(r.currency)) seen.set(r.currency, r);
  return [...seen.values()];
}

export function runStrategy(payload, config) {
  switch ((config.strategy || 'auto').toLowerCase()) {
    case 'selector':
      return selectorStrategy(payload, config);
    case 'json':
      return jsonStrategy(payload, config);
    case 'browser': // rendered in headless Chromium by the engine, then scanned like 'auto'
    case 'auto':
    default:
      return autoStrategy(payload, config);
  }
}
