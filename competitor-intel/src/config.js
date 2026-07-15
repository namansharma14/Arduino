// Central configuration + reference data for the Crown Currency competitor intel tool.
//
// Rate convention used everywhere in this app:
//   A "rate" is FOREIGN CURRENCY UNITS PER 1 AUD  (i.e. how much travel money a
//   customer receives for one Australian dollar).  Higher = better value for the
//   customer.  This is the headline number frontline staff compare on the board.

export const BASE_CURRENCY = 'AUD';

// Reference table of the currencies Crown deals in most.
// `typical` is an approximate units-per-AUD magnitude. It is ONLY used to:
//   1. sanity-check / normalise loosely-typed numbers ("usd at 64" -> 0.6400)
//   2. give charts a sensible starting scale
// It is never treated as a real rate.
export const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', symbol: 'US$', typical: 0.65 },
  { code: 'EUR', name: 'Euro', symbol: '€', typical: 0.60 },
  { code: 'GBP', name: 'British Pound', symbol: '£', typical: 0.52 },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', typical: 1.08 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', typical: 98 },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', typical: 0.88 },
  { code: 'THB', name: 'Thai Baht', symbol: '฿', typical: 23 },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', typical: 10500 },
  { code: 'VND', name: 'Vietnamese Dong', symbol: '₫', typical: 16500 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', typical: 55 },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', typical: 4.7 },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', typical: 5.1 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', typical: 0.90 },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr', typical: 0.58 },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', typical: 2.4 },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', typical: 880 },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱', typical: 37 },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', typical: 2.9 },
  { code: 'FJD', name: 'Fijian Dollar', symbol: 'FJ$', typical: 1.48 },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', typical: 12.0 },
];

export const CURRENCY_MAP = Object.fromEntries(CURRENCIES.map((c) => [c.code, c]));
export const CURRENCY_CODES = CURRENCIES.map((c) => c.code);

// Alternate spellings the intel parser should recognise in free text.
export const CURRENCY_ALIASES = {
  USD: ['usd', 'us dollar', 'us dollars', 'dollar us', 'greenback', 'american'],
  EUR: ['eur', 'euro', 'euros'],
  GBP: ['gbp', 'pound', 'pounds', 'sterling', 'quid'],
  NZD: ['nzd', 'kiwi', 'new zealand'],
  JPY: ['jpy', 'yen', 'japan'],
  SGD: ['sgd', 'sing dollar', 'singapore'],
  THB: ['thb', 'baht', 'thai'],
  IDR: ['idr', 'rupiah', 'bali', 'indonesia'],
  VND: ['vnd', 'dong', 'vietnam'],
  INR: ['inr', 'rupee', 'rupees', 'india'],
  CNY: ['cny', 'rmb', 'yuan', 'renminbi', 'china'],
  HKD: ['hkd', 'hong kong'],
  CAD: ['cad', 'canadian', 'canada', 'loonie'],
  CHF: ['chf', 'franc', 'swiss', 'switzerland'],
  AED: ['aed', 'dirham', 'dubai', 'emirates'],
  KRW: ['krw', 'won', 'korea', 'korean'],
  PHP: ['php', 'peso', 'pesos', 'philippines', 'filipino'],
  MYR: ['myr', 'ringgit', 'malaysia'],
  FJD: ['fjd', 'fiji', 'fijian'],
  ZAR: ['zar', 'rand', 'south africa'],
};

export const RATE_SOURCES = ['online', 'counter', 'intel'];

export const DEFAULTS = {
  // Cron schedule for automated scraping (node-cron). Default: every hour on the hour.
  scrapeCron: process.env.SCRAPE_CRON || '0 * * * *',
  // Whether the scheduler runs automatically when the server boots.
  autoScrape: process.env.AUTO_SCRAPE !== 'false',
  port: Number(process.env.PORT || 4000),
  // Request timeout for scrapers (ms)
  scrapeTimeoutMs: Number(process.env.SCRAPE_TIMEOUT_MS || 15000),
  userAgent:
    process.env.SCRAPE_UA ||
    'Mozilla/5.0 (compatible; CrownIntelBot/1.0; +internal competitor rate monitor)',
};

// Normalise a loosely-entered number for a currency using its typical magnitude.
// "usd at 64" -> 0.64 ; "0.6412" -> 0.6412 ; "yen 9800" -> 98.
// Returns { value, adjusted } where `adjusted` flags that we rescaled the input.
export function normaliseRate(currency, raw) {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || n <= 0) return { value: null, adjusted: false };
  const ref = CURRENCY_MAP[currency];
  if (!ref) return { value: n, adjusted: false };
  const typical = ref.typical;
  // Try scaling by powers of ten and pick the scale whose result sits closest
  // (in log space) to the typical magnitude for this currency.
  let best = { scale: 1, dist: Infinity };
  for (let k = -4; k <= 4; k++) {
    const scaled = n * Math.pow(10, k);
    const dist = Math.abs(Math.log10(scaled) - Math.log10(typical));
    if (dist < best.dist) best = { scale: Math.pow(10, k), dist };
  }
  const value = Number((n * best.scale).toPrecision(6));
  return { value, adjusted: best.scale !== 1 };
}

// How many decimal places to display a rate for a given currency.
export function rateDecimals(currency) {
  const t = CURRENCY_MAP[currency]?.typical ?? 1;
  if (t >= 1000) return 0;
  if (t >= 10) return 2;
  return 4;
}
