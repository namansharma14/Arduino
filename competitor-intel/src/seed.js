// Seed the database with competitors + realistic trend history + sample intel.
//   node src/seed.js           # only seeds if DB has no competitors
//   node src/seed.js --reset   # wipes rates/intel/competitors first
import db, { competitors as competitorsRepo, rates as ratesRepo, intel as intelRepo } from './db.js';
import { CURRENCY_MAP } from './config.js';
import { parseIntel } from './lib/intel-parser.js';

const reset = process.argv.includes('--reset');

if (reset) {
  db.exec('DELETE FROM rates; DELETE FROM intel_notes; DELETE FROM scrape_runs; DELETE FROM competitors;');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('rates','intel_notes','scrape_runs','competitors');");
  console.log('Cleared existing data.');
}

if (competitorsRepo.all().length > 0) {
  console.log('Database already has competitors — skipping seed. Use --reset to wipe and reseed.');
  process.exit(0);
}

// Deterministic PRNG so re-seeding produces the same demo data.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260715);

const COMPETITORS = [
  {
    name: 'Crown Currency',
    website: 'https://crowncurrency.com.au',
    location: 'Brisbane CBD, QLD',
    is_self: 1,
    bias: 0.0,
    notes: 'Our own board (baseline for comparison).',
  },
  {
    name: 'Travel Money Oz',
    website: 'https://www.travelmoneyoz.com',
    location: 'Queen St Mall, Brisbane QLD',
    bias: 0.004,
    scrape_config: { strategy: 'auto', url: 'https://www.travelmoneyoz.com/foreign-exchange-rates', currencies: ['USD', 'EUR', 'GBP', 'NZD', 'JPY', 'THB'] },
    notes: 'Aggressive on headline currencies, mall foot-traffic.',
  },
  {
    name: 'Travelex',
    website: 'https://www.travelex.com.au',
    location: 'Brisbane Airport, QLD',
    bias: -0.006,
    scrape_config: { strategy: 'auto', url: 'https://www.travelex.com.au/currency', only: ['USD', 'EUR', 'GBP', 'NZD', 'JPY', 'THB'] },
    notes: 'Airport locations, typically weaker rates + fees.',
  },
  {
    name: 'S Money',
    website: 'https://www.smoney.com.au',
    location: 'Sydney CBD, NSW (online)',
    bias: 0.0025,
    notes: 'Online-led, sharp on USD/EUR.',
  },
  {
    name: 'The Currency Shop',
    website: 'https://www.thecurrencyshop.com.au',
    location: 'Online / comparison',
    bias: -0.003,
    notes: 'Comparison site rates, mid-market.',
  },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'NZD', 'JPY', 'THB'];
const DAYS = 30;
const NOW = Date.now();
const DAY_MS = 86400000;

function sqlTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Create competitors.
const created = {};
for (const c of COMPETITORS) {
  const row = competitorsRepo.create({
    name: c.name,
    website: c.website,
    location: c.location,
    is_self: c.is_self ? 1 : 0,
    scrape_config: c.scrape_config || null,
    notes: c.notes,
  });
  created[c.name] = { ...row, bias: c.bias };
}
console.log(`Created ${COMPETITORS.length} competitors.`);

// Generate trend history. Each currency has a gentle market drift; each competitor
// applies a persistent bias + noise. Travel Money Oz deliberately drifts its USD
// down over the last week (to line up with the sample "clearing stock" intel).
let rateCount = 0;
for (const currency of CURRENCIES) {
  const base = CURRENCY_MAP[currency].typical;
  // market drift path (one per day), a smooth-ish random walk
  const drift = [];
  let d = 0;
  for (let day = 0; day <= DAYS; day++) {
    d += (rnd() - 0.5) * 0.004; // ±0.2%/day
    d = Math.max(-0.02, Math.min(0.02, d));
    drift.push(d);
  }

  for (const c of COMPETITORS) {
    const comp = created[c.name];
    for (let day = DAYS; day >= 0; day--) {
      const ts = NOW - day * DAY_MS - Math.floor(rnd() * 6) * 3600 * 1000;
      let biasPct = comp.bias;

      // TMO USD special: dive over the final 6 days.
      if (c.name === 'Travel Money Oz' && currency === 'USD' && day <= 6) {
        biasPct -= (6 - day) * 0.0016; // progressively worse -> ~0.6400
      }
      const noise = (rnd() - 0.5) * 0.003;
      const value = base * (1 + drift[DAYS - day] + biasPct + noise);
      const decimals = CURRENCY_MAP[currency].typical >= 10 ? 2 : 4;
      const sell = Number(value.toFixed(decimals + 1));
      const buy = Number((value * 0.985).toFixed(decimals + 1)); // buy-back a touch lower

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
console.log(`Inserted ${rateCount} historical rates.`);

// Sample intel notes (parsed through the real parser).
const SAMPLE_INTEL = [
  { text: "travel money oz is doing usd at 64 but don't have stock till coming Thur", by: 'Priya (counter)' },
  { text: 'Travelex airport quoting EUR around 0.58, customer said fees on top', by: 'Jordan' },
  { text: 'S Money online showing USD 0.6615, no commission this week', by: 'Priya (counter)' },
  { text: 'Customer walked from Travel Money Oz — they were out of USD notes, sent them to us', by: 'Marcus' },
  { text: 'Currency Shop GBP looked weak today, about 0.515', by: 'Jordan' },
  { text: 'Travelex low on JPY, said new stock next week', by: 'Marcus' },
];
const compList = competitorsRepo.all().map((c) => ({ id: c.id, name: c.name }));
let intelCount = 0;
for (const s of SAMPLE_INTEL) {
  const parsed = parseIntel(s.text, { competitors: compList });
  const cid = parsed.competitorGuess?.id || null;
  const note = intelRepo.insert({
    competitor_id: cid,
    raw_text: s.text,
    parsed,
    currency: parsed.primaryCurrency,
    flags: parsed.flags,
    created_by: s.by,
  });
  // promote parsed rates
  if (cid) {
    for (const r of parsed.rates) {
      if (r.value == null) continue;
      ratesRepo.insert({
        competitor_id: cid,
        currency: r.currency,
        sell_rate: r.value,
        source: 'intel',
        captured_by: s.by,
        note: `from intel: "${s.text.slice(0, 60)}"`,
        intel_id: note.id,
      });
    }
  }
  intelCount++;
}
console.log(`Inserted ${intelCount} intel notes.`);
console.log('\nSeed complete. Start the app with:  npm start');
process.exit(0);
