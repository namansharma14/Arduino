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

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Strictly numeric values only — used to tell a rate field from free text.
function asNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?[\d,]+(?:\.\d+)?$/.test(v.trim())) {
    const n = parseFloat(v.replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }
  return null;
}

function currencyOf(v) {
  if (typeof v !== 'string') return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) && CURRENCY_CODES.includes(c) ? c : null;
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
// config.items may also resolve to an object keyed by currency code
// ({ USD: 0.65 } or { USD: { sellRate: … } }) — Travelex publishes that shape.
function jsonStrategy(payload, config) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const items = config.items ? getPath(data, config.items) : data;
  const map = config.map || {};
  if (isPlainObject(items)) return keyedRows(items, map);
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    const code = String(getPath(it, map.code || 'code') || '').toUpperCase().slice(0, 3);
    if (!CURRENCY_CODES.includes(code)) continue;
    const rawSell = num(getPath(it, map.sell || 'sell'));
    const sell = normaliseRate(code, rawSell).value;
    const buy = map.buy ? normaliseRate(code, num(getPath(it, map.buy))).value : null;
    if (sell != null || buy != null) out.push({ currency: code, sell_rate: sell, buy_rate: buy, raw: rawSell });
  }
  return dedupe(out);
}

// Rows from a { CODE: value } object. The code comes from the key, so map.code is
// ignored here (KEYED_CODE marks a discovered config as this shape); a bare value
// is the sell rate, an object is read through map.sell / map.buy.
export const KEYED_CODE = '<key>';

function keyedRows(obj, map = {}, wanted = null) {
  const out = [];
  for (const [key, val] of Object.entries(obj)) {
    const code = currencyOf(key);
    if (!code || (wanted && !wanted.has(code))) continue;
    let rawSell = null;
    let rawBuy = null;
    if (isPlainObject(val)) {
      rawSell = num(getPath(val, map.sell || 'sell'));
      rawBuy = map.buy ? num(getPath(val, map.buy)) : null;
    } else if (typeof val === 'number' || typeof val === 'string') {
      rawSell = num(val);
    }
    const sell = rawSell == null ? null : normaliseRate(code, rawSell).value;
    const buy = rawBuy == null ? null : normaliseRate(code, rawBuy).value;
    if (sell != null || buy != null) out.push({ currency: code, sell_rate: sell, buy_rate: buy, raw: rawSell });
  }
  return dedupe(out);
}

// --- auto-json strategy: find rate rows anywhere inside a JSON document -----
// Used when a rendered page hides its rates in an XHR response: walk the parsed
// JSON, find the array of objects that looks most like rate rows, and report both
// the rows AND where they were found ({ items dotted path, map field names }) so
// the engine can adopt a plain 'json' config from a single discovery run.
const CODE_KEY_RE = /^(code|currency|currency_?code|ccy|iso|iso_?3|cur)$/i;
const SELL_KEY_RE = /sell|sale|selling|we ?sell|rate/i;
const BUY_KEY_RE = /buy|purchase|we ?buy/i;
const WALK_MAX_DEPTH = 8;

// An object needs this many currency-code keys before it reads as a rate table.
const KEYED_MIN_CODES = 3;

function wantedSet(config) {
  const list = config.only || config.currencies;
  return Array.isArray(list) && list.length ? new Set(list.map((c) => String(c).toUpperCase())) : null;
}

// Which numeric fields of a set of like-shaped objects hold sell / buy.
function pickRateFields(sample, exclude = null) {
  const keys = [...new Set(sample.flatMap((r) => Object.keys(r)))].filter((k) => k !== exclude);
  const numeric = keys.filter((k) => sample.some((r) => asNumber(r[k]) != null));
  const buy = numeric.find((k) => BUY_KEY_RE.test(k)) || null;
  const sell =
    numeric.find((k) => k !== buy && /sell|sale|selling/i.test(k)) ||
    numeric.find((k) => k !== buy && SELL_KEY_RE.test(k)) ||
    null;
  return sell ? { sell, ...(buy ? { buy } : {}) } : null;
}

// Decide which fields of an array of objects hold the code / sell / buy values.
function pickFields(items) {
  const sample = items.filter(isPlainObject).slice(0, 50);
  if (!sample.length) return null;
  const keys = [...new Set(sample.flatMap((r) => Object.keys(r)))];
  let code = null;
  let codeScore = 0;
  for (const k of keys) {
    const hits = sample.filter((r) => currencyOf(r[k])).length;
    // A code-ish name only breaks ties — the values decide.
    const score = hits * 2 + (CODE_KEY_RE.test(k) ? 1 : 0);
    if (hits && score > codeScore) {
      code = k;
      codeScore = score;
    }
  }
  if (!code) return null;
  const fields = pickRateFields(sample, code);
  return fields ? { code, ...fields } : null;
}

// Is this object a { CODE: rate } table? Returns the value-side map, or null.
function pickKeyedFields(obj) {
  const values = Object.entries(obj)
    .filter(([k]) => currencyOf(k))
    .map(([, v]) => v);
  if (values.length < KEYED_MIN_CODES) return null;
  const objs = values.filter(isPlainObject);
  if (objs.length >= KEYED_MIN_CODES) return pickRateFields(objs.slice(0, 50));
  if (values.filter((v) => asNumber(v) != null).length >= KEYED_MIN_CODES) return {}; // bare numbers
  return null;
}

function rowsFromItems(items, map, wanted) {
  const out = [];
  for (const it of items) {
    if (!isPlainObject(it)) continue;
    const code = currencyOf(it[map.code]);
    if (!code || (wanted && !wanted.has(code))) continue;
    const rawSell = asNumber(it[map.sell]);
    const rawBuy = map.buy ? asNumber(it[map.buy]) : null;
    const sell = rawSell == null ? null : normaliseRate(code, rawSell).value;
    const buy = rawBuy == null ? null : normaliseRate(code, rawBuy).value;
    if (sell != null || buy != null) out.push({ currency: code, sell_rate: sell, buy_rate: buy, raw: rawSell });
  }
  return dedupe(out);
}

export function autoJsonStrategy(payload, config = {}) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const wanted = wantedSet(config);
  let best = null;
  const keep = (rates, items, map) => {
    if (rates.length && (!best || rates.length > best.rates.length)) best = { rates, items, map };
  };
  const visit = (node, path, depth) => {
    if (node == null || typeof node !== 'object' || depth > WALK_MAX_DEPTH) return;
    if (Array.isArray(node)) {
      const map = pickFields(node);
      if (map) keep(rowsFromItems(node, map, wanted), path, map);
      node.forEach((v, i) => visit(v, path ? `${path}.${i}` : String(i), depth + 1));
      return;
    }
    const keyed = pickKeyedFields(node);
    if (keyed) keep(keyedRows(node, keyed, wanted), path, { code: KEYED_CODE, ...keyed });
    for (const [k, v] of Object.entries(node)) visit(v, path ? `${path}.${k}` : k, depth + 1);
  };
  visit(data, '', 0);
  return best || { rates: [], items: null, map: null };
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
