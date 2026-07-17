// Seed the database with real Crown stores + their local competitors (from the
// planner sheets) + trend history (buy & sell) + sample intel.
//   node src/seed.js           # only seeds if empty
//   node src/seed.js --reset   # wipe + reseed
import db, {
  stores as storesRepo,
  competitors as competitorsRepo,
  rates as ratesRepo,
  intel as intelRepo,
  ensureDefaultStore,
} from './db.js';
import { CURRENCY_MAP } from './config.js';
import { parseIntel } from './lib/intel-parser.js';

const reset = process.argv.includes('--reset');
if (reset) {
  db.exec('DELETE FROM rates; DELETE FROM intel_notes; DELETE FROM scrape_runs; DELETE FROM competitors; DELETE FROM stores;');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('rates','intel_notes','scrape_runs','competitors','stores');");
  console.log('Cleared existing data.');
}

if (storesRepo.all().length > 0 && competitorsRepo.all().length > 0) {
  console.log('Database already seeded — use --reset to wipe and reseed.');
  process.exit(0);
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260716);

// Real stores + their local competitors, taken from the daily planner sheets.
// Carindale carries live scrape configs (the demo store).
const CARINDALE_ONLY = ['USD', 'EUR', 'GBP', 'NZD', 'JPY', 'THB'];
const STORES = [
  {
    name: 'Carindale',
    location: 'Westfield Carindale, Brisbane QLD',
    competitors: [
      { name: 'Travel Money Oz', location: 'Westfield Carindale (upstairs)', website: 'https://www.travelmoneyoz.com', bias: 0.004,
        scrape_config: { strategy: 'auto', render: true, url: 'https://www.travelmoneyoz.com/rates', only: CARINDALE_ONLY } },
      { name: 'Travelex', location: 'Westfield Carindale, QLD', website: 'https://www.travelex.com.au', bias: -0.006,
        scrape_config: { strategy: 'auto', render: true, url: 'https://www.travelex.com.au/rates', only: CARINDALE_ONLY } },
      { name: 'Prosegur', location: 'Carindale, QLD', website: 'https://au.prosegurchange.com', bias: 0.001,
        scrape_config: { strategy: 'auto', render: true, url: 'https://au.prosegurchange.com/exchange-rates', only: CARINDALE_ONLY } },
      { name: 'Commbank Carindale', location: 'Westfield Carindale, QLD', bias: -0.009 },
    ],
    intel: [
      { text: 'TMOZ upstairs offering to match their online rate instore, plus an additional $25 off', by: 'Front counter' },
      { text: 'Travel Money Oz deliveries on Wednesday & Friday, needs head office approval for anything over $10K', by: 'Front counter' },
      { text: 'Prosegur quoting EUR around 0.59, customer said their margin was 4.28%', by: 'Store lead' },
      { text: 'Travelex ran out of NZD 09/07/26', by: 'Front counter' },
    ],
    usdDip: 'Travel Money Oz',
  },
  {
    name: 'Queen Street',
    location: 'Queen St Mall, Brisbane CBD QLD',
    competitors: [
      { name: 'Johnsons', location: 'Queen St, Brisbane', bias: 0.002 },
      { name: 'Travel Money Oz', location: 'Queen St Mall, Brisbane', website: 'https://www.travelmoneyoz.com', bias: 0.004 },
      { name: 'Travelex', location: 'Queen St Mall, Brisbane', website: 'https://www.travelex.com.au', bias: -0.005 },
      { name: 'Value Currency', location: 'Queen St, Brisbane', bias: 0.0015 },
    ],
    intel: [
      { text: 'Johnsons buying back JPY at 124.39', by: 'Front counter' },
      { text: 'Travel Money Oz buying USD at 0.7368', by: 'Front counter' },
      { text: 'Value Currency selling JPY 110.6 at 3.04% margin', by: 'Front counter' },
      { text: 'Travelex only has CAD1400 in stock until 20/07', by: 'Front counter' },
    ],
    usdDip: 'Travelex',
  },
  {
    name: 'Aspley',
    location: 'Aspley, Brisbane QLD',
    competitors: [
      { name: 'Travel Money Oz', location: 'Westfield Chermside (nearby)', website: 'https://www.travelmoneyoz.com', bias: 0.0035 },
      { name: 'Travelex', location: 'Westfield Chermside (nearby)', website: 'https://www.travelex.com.au', bias: -0.006 },
      { name: 'Australia Post', location: 'Aspley Hypermarket', bias: -0.008 },
    ],
    intel: [
      { text: 'Travel Money Oz at Chermside out of USD small notes, restock Thursday', by: 'Store lead' },
      { text: 'Australia Post only sells load-and-go travel card, no cash EUR', by: 'Store lead' },
    ],
    usdDip: 'Travelex',
  },
  {
    name: 'Sunnybank',
    location: 'Sunnybank Plaza, Brisbane QLD',
    competitors: [
      { name: 'Webtrade', location: 'Sunnybank Plaza', bias: 0.003 },
      { name: 'Supay', location: 'Sunnybank Plaza', bias: 0.005 },
      { name: 'Remox', location: 'Sunnybank Hills', bias: -0.002 },
      { name: 'RedRate', location: 'Mt Gravatt', bias: -0.004 },
    ],
    intel: [
      { text: 'Supay board rates and website rate are not the same — need to check the board instore', by: 'Front counter' },
      { text: 'Supay $5 fee for any exchange, wiped if you leave a 5-Star Google Review', by: 'Front counter' },
      { text: 'Webtrade EUR only have 50s, GBP smallest note is 20s, JPY no stock on Friday, new delivery Wed. Max $3000 AUD per person per day', by: 'Front counter' },
      { text: 'Remox opening two new branches, one in Wynnum and one in Capalaba. Only $3700 CAD in stock, delivery Wed or Thu', by: 'Front counter' },
    ],
    usdDip: 'Supay',
  },
  {
    name: 'Indooroopilly',
    location: 'Indooroopilly Shopping Centre, Brisbane QLD',
    competitors: [
      { name: 'Travelex', location: 'Indooroopilly Shopping Centre', website: 'https://www.travelex.com.au', bias: -0.005 },
      { name: 'Travel Money Oz', location: 'Indooroopilly Shopping Centre', website: 'https://www.travelmoneyoz.com', bias: 0.004 },
      { name: 'The Currency Exchange', location: 'Indooroopilly', bias: 0.001 },
    ],
    intel: [
      { text: 'Travelex Indooroopilly running low on GBP, only 50s left', by: 'Front counter' },
      { text: 'Travel Money Oz price-matching our USD board this week', by: 'Front counter' },
    ],
    usdDip: 'Travel Money Oz',
  },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'NZD', 'THB'];
const DAYS = 30;
const NOW = Date.now();
const DAY_MS = 86400000;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

let storeCount = 0;
let compCount = 0;
let rateCount = 0;
let intelCount = 0;

for (const S of STORES) {
  const store = storesRepo.create({ name: S.name, location: S.location, is_default: storeCount === 0 ? 1 : 0 });
  storeCount++;

  // Crown's own board for this store (the baseline) + the local competitors.
  const roster = [
    { name: `Crown Currency – ${S.name}`, location: S.location, is_self: 1, bias: 0.0 },
    ...S.competitors,
  ];
  const created = {};
  for (const c of roster) {
    const row = competitorsRepo.create({
      name: c.name,
      store_id: store.id,
      website: c.website || null,
      location: c.location,
      is_self: c.is_self ? 1 : 0,
      scrape_config: c.scrape_config || null,
    });
    created[c.name] = { ...row, bias: c.bias };
    compCount++;
  }

  // Trend history: sell + buy (buy is HIGHER than sell in units-per-AUD — the
  // customer gets fewer foreign units per AUD when selling back).
  for (const currency of CURRENCIES) {
    const base = CURRENCY_MAP[currency].typical;
    const spread = base >= 10 ? 0.1 : 0.06; // wider buy/sell spread for JPY/THB
    const drift = [];
    let d = 0;
    for (let day = 0; day <= DAYS; day++) {
      d += (rnd() - 0.5) * 0.004;
      d = Math.max(-0.02, Math.min(0.02, d));
      drift.push(d);
    }
    for (const c of roster) {
      const comp = created[c.name];
      for (let day = DAYS; day >= 0; day--) {
        const ts = NOW - day * DAY_MS - Math.floor(rnd() * 6) * 3600 * 1000;
        let biasPct = comp.bias;
        if (c.name === S.usdDip && currency === 'USD' && day <= 6) biasPct -= (6 - day) * 0.0016;
        const noise = (rnd() - 0.5) * 0.003;
        const value = base * (1 + drift[DAYS - day] + biasPct + noise);
        const dec = base >= 10 ? 2 : 4;
        const sell = Number(value.toFixed(dec + 1));
        const buy = Number((value * (1 + spread)).toFixed(dec + 1)); // buy-back worse for customer
        ratesRepo.insert({
          competitor_id: comp.id,
          currency,
          sell_rate: sell,
          buy_rate: buy,
          source: comp.is_self ? 'counter' : 'online',
          captured_at: sqlTime(ts),
          captured_by: comp.is_self ? 'front desk' : 'scraper',
        });
        rateCount++;
      }
    }
  }

  // Intel notes (parsed, not auto-promoted to keep trend data clean).
  const compList = competitorsRepo.all({ store_id: store.id }).map((c) => ({ id: c.id, name: c.name }));
  for (const s of S.intel) {
    const parsed = parseIntel(s.text, { competitors: compList });
    intelRepo.insert({
      competitor_id: parsed.competitorGuess?.id || null,
      raw_text: s.text,
      parsed,
      currency: parsed.primaryCurrency,
      flags: parsed.flags,
      created_by: s.by,
    });
    intelCount++;
  }
}

ensureDefaultStore();
console.log(`Seeded ${storeCount} stores, ${compCount} competitors, ${rateCount} rates, ${intelCount} intel notes.`);
console.log('\nSeed complete. Start with:  npm start');
process.exit(0);
