// Smart intel parser: turns a free-text observation typed by frontline staff into
// structured signals. Rule-based (no external LLM needed) but designed so an LLM
// enrichment step could be dropped in later.
//
// Example input:
//   "travel money oz is doing usd at 64 but don't have stock till coming Thur"
// Example output (abridged):
//   { currencies:['USD'], rates:[{currency:'USD', value:0.64, raw:'64', adjusted:true}],
//     competitorGuess:{name:'Travel Money Oz'}, flags:['stock_out','restock_eta'],
//     eta:'Thursday', summary:'USD ~0.6400 · out of stock · restock Thursday' }

import { CURRENCY_ALIASES, CURRENCY_CODES, CURRENCY_MAP, normaliseRate, rateDecimals } from '../config.js';

const DAYS = {
  mon: 'Monday', monday: 'Monday',
  tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday',
  wed: 'Wednesday', weds: 'Wednesday', wednesday: 'Wednesday',
  thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', thursday: 'Thursday',
  fri: 'Friday', friday: 'Friday',
  sat: 'Saturday', saturday: 'Saturday',
  sun: 'Sunday', sunday: 'Sunday',
};

// Build one big alias -> code lookup, longest aliases first so "us dollar" wins over "us".
const ALIAS_ENTRIES = [];
for (const [code, aliases] of Object.entries(CURRENCY_ALIASES)) {
  ALIAS_ENTRIES.push([code.toLowerCase(), code]);
  for (const a of aliases) ALIAS_ENTRIES.push([a, code]);
}
ALIAS_ENTRIES.sort((a, b) => b[0].length - a[0].length);

function detectCurrencies(text) {
  const lower = ` ${text.toLowerCase()} `;
  const found = new Map(); // code -> first index
  for (const [alias, code] of ALIAS_ENTRIES) {
    if (found.has(code)) continue;
    // word-ish boundary so "usd" doesn't match inside "usual"
    const re = new RegExp(`(?<![a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`, 'i');
    const m = re.exec(lower);
    if (m) found.set(code, m.index);
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([code, idx]) => ({ code, idx }));
}

// All numeric tokens with their positions. Skips margins ("3.04%") and date
// fragments ("20/07") so they aren't mistaken for rates.
function extractNumbers(text) {
  const nums = [];
  const re = /(?<![\w.])(\d{1,6}(?:[.,]\d{1,6})?)(?![\w])/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    const start = m.index;
    const before = text[start - 1] || '';
    const after = text[start + raw.length] || '';
    if (after === '%') continue; // a margin, not a rate
    if (before === '/' || after === '/') continue; // part of a date
    const value = parseFloat(raw.replace(',', '.'));
    if (!isFinite(value)) continue;
    nums.push({ raw, value, idx: start });
  }
  return nums;
}

// Associate the most plausible number with each detected currency.
function associateRates(text, currencies, numbers) {
  const rates = [];
  const used = new Set();
  for (const cur of currencies) {
    const typical = CURRENCY_MAP[cur.code]?.typical ?? 1;
    let best = null;
    for (let i = 0; i < numbers.length; i++) {
      if (used.has(i)) continue;
      const num = numbers[i];
      const dist = Math.abs(num.idx - cur.idx);
      if (dist > 60) continue;
      // Prefer numbers that appear AFTER the currency (typical "usd at 64").
      const after = num.idx > cur.idx;
      const window = between(text, cur.idx, num.idx);
      const connector = /\b(at|@|=|for|doing|is|of|around|about|~|paying|buy|buying|sell|selling|rate)\b|[@=~]/i.test(window);
      // How well the normalised value fits this currency's magnitude (log distance).
      const norm = normaliseRate(cur.code, num.value);
      const fit = norm.value ? Math.abs(Math.log10(norm.value) - Math.log10(typical)) : 5;
      // Lower score = better: closer + connector + after help; poor magnitude fit hurts.
      const score = dist - (after ? 25 : 0) - (connector ? 40 : 0) + fit * 35;
      if (!best || score < best.score) best = { i, num, score };
    }
    if (best) {
      used.add(best.i);
      const { value, adjusted } = normaliseRate(cur.code, best.num.value);
      rates.push({
        currency: cur.code,
        raw: best.num.raw,
        value,
        adjusted,
        display: value == null ? null : value.toFixed(rateDecimals(cur.code)),
      });
    }
  }
  return rates;
}

function between(text, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return text.slice(lo, hi);
}

function detectFlags(text) {
  const t = text.toLowerCase();
  const flags = [];
  const stockOut =
    /\b(no|out of|don'?t have|dont have|haven'?t got|havent got|zero|nil|ran out|sold out|none left|no more)\b[^.]*\b(stock|left|available)\b/.test(t) ||
    /\b(out of stock|no stock|sold out|stockout|no cash|no notes|ran out of|sold out of|none left of|no more of)\b/.test(t);
  if (stockOut) flags.push('stock_out');

  const lowStock = /\b(low|running low|limited|short on|nearly out|almost out|not much)\b[^.]*\b(stock|notes|cash|left)\b/.test(t);
  if (lowStock) flags.push('low_stock');

  const restock =
    /\b(till|until|til|by|next|coming|this|back(?:\s+in)?|restock|new stock|expecting|due)\b\s*(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|week|weekend)/.test(t);
  if (restock) flags.push('restock_eta');

  const promo =
    /\b(no commission|commission free|fee free|no fee|no fees|zero commission|free delivery|price ?match|match (?:our|their)|beat(?:ing)?|percent off|special|deal|promo|discount|bonus)\b/.test(t) ||
    /\$\d+\s*off|\d+%\s*off/.test(t);
  if (promo) flags.push('promo');

  const moved = /\b(dropped|drop|cut|cutting|slashed|raised|raise|hiked|increased|lowered|lower|down|up|changed|moved|adjust)\b/.test(t);
  if (moved) flags.push('price_move');

  const beatingUs = /\b(beat(?:ing)?\s+us|cheaper than us|better than us|undercut|under cut|below us|less than us)\b/.test(t);
  if (beatingUs) flags.push('beating_us');

  const negative = /\b(rude|slow|queue|closed|complaint|poor|bad|unhappy|angry|left|walked)\b/.test(t);
  if (negative) flags.push('sentiment_negative');

  return flags;
}

function detectEta(text) {
  const t = text.toLowerCase();
  if (/\btomorrow\b/.test(t)) return 'Tomorrow';
  if (/\bnext week\b/.test(t)) return 'Next week';
  if (/\bthis week\b/.test(t)) return 'This week';
  if (/\b(this |next |the )?weekend\b/.test(t)) return 'Weekend';
  const m = /\b(?:till|until|til|by|coming|next|this|back(?:\s+in)?|due|expecting)\s+(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(t);
  if (m) return DAYS[m[1]] || null;
  return null;
}

function guessCompetitor(text, competitors = []) {
  const t = text.toLowerCase();
  let best = null;
  for (const c of competitors) {
    const name = c.name.toLowerCase();
    // match full name, or a distinctive first token (>=4 chars, not generic)
    const tokens = name.split(/\s+/).filter((w) => w.length >= 4 && !['money', 'currency', 'exchange', 'travel', 'foreign'].includes(w));
    const hit = t.includes(name) ? name.length : tokens.some((tok) => t.includes(tok)) ? Math.max(...tokens.filter((tok) => t.includes(tok)).map((x) => x.length)) : 0;
    if (hit && (!best || hit > best.hit)) best = { id: c.id, name: c.name, hit };
  }
  return best ? { id: best.id, name: best.name } : null;
}

const FLAG_LABELS = {
  stock_out: 'out of stock',
  low_stock: 'low stock',
  restock_eta: 'restock expected',
  promo: 'promotion / offer',
  price_move: 'rate moved',
  beating_us: 'undercutting us',
  sentiment_negative: 'service issue',
};

export function flagLabel(flag) {
  return FLAG_LABELS[flag] || flag;
}

export function parseIntel(text, { competitors = [], defaultCurrency = null } = {}) {
  const clean = String(text || '').trim();
  const currencies = detectCurrencies(clean);
  const numbers = extractNumbers(clean);
  let rates = associateRates(clean, currencies, numbers);

  // If nothing detected but a currency was pre-selected and a lone number exists, use it.
  if (rates.length === 0 && defaultCurrency && numbers.length === 1) {
    const { value, adjusted } = normaliseRate(defaultCurrency, numbers[0].value);
    rates = [{ currency: defaultCurrency, raw: numbers[0].raw, value, adjusted, display: value?.toFixed(rateDecimals(defaultCurrency)) }];
  }

  const flags = detectFlags(clean);
  const eta = detectEta(clean);
  const competitorGuess = guessCompetitor(clean, competitors);
  const currencyList = currencies.map((c) => c.code);
  const primaryCurrency = currencyList[0] || defaultCurrency || null;

  // Build a compact human summary.
  const parts = [];
  for (const r of rates) if (r.value != null) parts.push(`${r.currency} ${r.display}${r.adjusted ? ' (?)' : ''}`);
  for (const f of flags) if (f !== 'price_move') parts.push(FLAG_LABELS[f] || f);
  if (eta) parts.push(`ETA ${eta}`);
  const summary = parts.join(' · ') || 'note logged';

  return {
    currencies: currencyList,
    primaryCurrency,
    rates,
    flags,
    eta,
    competitorGuess,
    summary,
  };
}
