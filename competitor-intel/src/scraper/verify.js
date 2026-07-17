// Scrape verifier — test a competitor rates URL end-to-end WITHOUT touching the DB.
//
//   npm run scrape:verify -- <url> [options]
//   npm run scrape:verify -- --competitor "Travel Money Oz"   (test its saved config)
//
// Options:
//   --currencies USD,EUR,GBP   limit extraction to these codes
//   --strategy auto|selector|json|browser
//   --config '{"rowSelector":"table tr","fields":{...}}'   extra strategy config (JSON)
//   --no-render                skip the headless-browser pass
//   --no-static                skip the plain-HTTP pass
//
// Output: reachability, what the static pass extracts, what the rendered pass
// extracts, any JSON rate APIs sniffed from network traffic, and a suggested
// scrape_config ready to paste into the competitor's settings.

import { runStrategy } from './adapters.js';
import { DEFAULTS, CURRENCY_MAP, rateDecimals } from '../config.js';

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--no-render') flags.noRender = true;
  else if (a === '--no-static') flags.noStatic = true;
  else if (a === '--currencies') flags.currencies = (args[++i] || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  else if (a === '--strategy') flags.strategy = args[++i];
  else if (a === '--config') flags.config = JSON.parse(args[++i] || '{}');
  else if (a === '--competitor') flags.competitor = args[++i];
  else positional.push(a);
}

let url = positional[0] || null;
let baseConfig = { strategy: flags.strategy || 'auto', ...(flags.config || {}) };
if (flags.currencies?.length) baseConfig.currencies = flags.currencies;

if (flags.competitor) {
  const { competitors } = await import('../db.js');
  const all = competitors.all().filter((c) => c.name.toLowerCase() === flags.competitor.toLowerCase() && c.scrape_config?.url);
  if (!all.length) {
    console.error(`No competitor named "${flags.competitor}" with a scrape config.`);
    process.exit(3);
  }
  const c = all[0];
  baseConfig = { ...c.scrape_config, ...(flags.strategy ? { strategy: flags.strategy } : {}) };
  url = baseConfig.url;
  console.log(`Testing saved config for "${c.name}" (store ${c.store_id}): ${JSON.stringify(baseConfig)}\n`);
}

if (!url) {
  console.error('Usage: npm run scrape:verify -- <url> [--currencies USD,EUR] [--strategy auto|selector|json] [--no-render]');
  process.exit(3);
}

const fmt = (rates) =>
  rates.length
    ? rates.map((r) => `    ${r.currency}  sell ${r.sell_rate ?? '—'}${r.buy_rate != null ? `  buy ${r.buy_rate}` : ''}${sanity(r)}`).join('\n')
    : '    (none)';

// Magnitude sanity vs the currency's typical units-per-AUD.
function sanity(r) {
  const t = CURRENCY_MAP[r.currency]?.typical;
  if (!t || r.sell_rate == null) return '';
  const off = Math.abs(Math.log10(r.sell_rate / t));
  return off > 0.5 ? '   ⚠ magnitude looks off — check!' : '   ✓';
}

console.log(`URL: ${url}`);
console.log(`Strategy: ${baseConfig.strategy || 'auto'}${baseConfig.currencies ? ` · currencies: ${baseConfig.currencies.join(',')}` : ''}\n`);

let staticRates = [];
let staticOk = false;
if (!flags.noStatic) {
  process.stdout.write('1) STATIC fetch (plain HTTP, no JS) … ');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULTS.scrapeTimeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': DEFAULTS.userAgent, Accept: 'text/html,application/json,*/*', 'Accept-Language': 'en-AU,en;q=0.9' },
    });
    clearTimeout(timer);
    const body = await res.text();
    staticOk = res.ok;
    console.log(`HTTP ${res.status}, ${body.length} bytes`);
    if (res.ok) {
      staticRates = runStrategy(body, baseConfig);
      console.log(`   extracted ${staticRates.length} rate(s):`);
      console.log(fmt(staticRates));
    }
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }
  console.log('');
}

let renderedRates = [];
let renderedOk = false;
let jsonHits = [];
if (!flags.noRender) {
  process.stdout.write('2) RENDERED fetch (headless Chromium, JS runs) … ');
  try {
    const { renderPage, browserAvailable } = await import('./browser.js');
    if (!(await browserAvailable())) throw new Error('no Chromium — run: npx --yes playwright install chromium');
    const out = await renderPage(url, { sniff: true, waitSelector: baseConfig.waitSelector || null, userAgent: DEFAULTS.userAgent });
    renderedOk = true;
    console.log(`OK, ${out.html.length} bytes after render`);
    renderedRates = runStrategy(out.html, baseConfig);
    jsonHits = out.jsonHits;
    console.log(`   extracted ${renderedRates.length} rate(s):`);
    console.log(fmt(renderedRates));
    if (jsonHits.length) {
      console.log(`\n   🎯 Sniffed ${jsonHits.length} JSON response(s) that look rate-related (best route to a stable scrape):`);
      for (const h of jsonHits.slice(0, 5)) {
        console.log(`    - ${h.url}  (${h.size} bytes)`);
        console.log(`      sample: ${h.sample.replace(/\s+/g, ' ').slice(0, 140)}…`);
      }
      console.log('      → If one contains the rates, switch this competitor to strategy "json" with that URL.');
    }
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }
  console.log('');
}

// Verdict + suggested config
console.log('--- VERDICT -----------------------------------------------------');
const best = renderedRates.length >= staticRates.length ? { rates: renderedRates, render: true } : { rates: staticRates, render: false };
if (!staticOk && !renderedOk) {
  console.log('✗ Site unreachable from this machine (network block or bad URL). Try from a machine with open internet.');
  process.exit(3);
} else if (best.rates.length === 0) {
  console.log('✗ Page fetched but no rates extracted. Next steps:');
  console.log('   - If a 🎯 JSON API was sniffed above, use strategy "json" with items/map.');
  console.log('   - Otherwise inspect the page and write a "selector" config (rowSelector + fields).');
  console.log('   - The site may also gate rates behind interaction (dropdowns) or bot protection.');
  process.exit(2);
} else {
  const suggested = {
    strategy: baseConfig.strategy === 'selector' || baseConfig.strategy === 'json' ? baseConfig.strategy : 'auto',
    ...(best.render ? { render: true } : {}),
    url,
    ...(baseConfig.currencies ? { only: baseConfig.currencies } : {}),
    ...(baseConfig.rowSelector ? { rowSelector: baseConfig.rowSelector, fields: baseConfig.fields } : {}),
    ...(baseConfig.items ? { items: baseConfig.items, map: baseConfig.map } : {}),
  };
  console.log(`✓ ${best.rates.length} rate(s) extracted via ${best.render ? 'RENDERED' : 'STATIC'} fetch. Suggested scrape_config:`);
  console.log(JSON.stringify(suggested, null, 2));
  console.log('\nPaste into Competitors → Edit → Advanced, or PUT /api/competitors/:id {"scrape_config": …}.');
  console.log('Watch decimals: values flagged ⚠ above were likely mis-scaled — add "only" to restrict currencies.');
  process.exit(0);
}
