// Regression test for the self-tuning scrape engine.   Run: npm run test:scraper
//
// A fixture site paints its rates into a <canvas> — nothing an HTML extractor can
// read — while fetching them from /api/v2/quotes. The engine must sniff that
// traffic, extract the rates from it, adopt the endpoint as the competitor's
// scrape_config, run statically from then on, self-heal when the endpoint dies,
// and drop rates whose magnitude cannot be right for the currency.
//
// Touches the real data/intel.db, so every row it creates is deleted again at the
// end (and the DB file is removed if the test created it).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const dbPath = process.env.DB_PATH || fileURLToPath(new URL('../data/intel.db', import.meta.url));
const dbExisted = fs.existsSync(dbPath);

const { default: db, stores, competitors, rates } = await import('../src/db.js');
const { scrapeCompetitor } = await import('../src/scraper/engine.js');
const { autoJsonStrategy, KEYED_CODE } = await import('../src/scraper/adapters.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}

// --- fixture site -----------------------------------------------------------
const QUOTES = {
  data: {
    quotes: [
      { ccy: 'USD', weSell: 0.6489, weBuy: 0.6904 },
      { ccy: 'EUR', weSell: 0.5991, weBuy: 0.6378 },
      { ccy: 'GBP', weSell: 0.5203, weBuy: 0.5515 },
      { ccy: 'JPY', weSell: 0.0098 }, // bogus — yen trades near 98 per AUD
    ],
  },
};

// Rates exist only as canvas pixels: no currency code sits next to a number in
// the DOM, so every HTML-text strategy comes back empty.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture FX</title></head>
<body>
  <h1>Fixture FX</h1>
  <canvas id="board" width="520" height="220"></canvas>
  <script>
    fetch('/api/v2/quotes')
      .then((r) => r.json())
      .then((d) => {
        const ctx = document.getElementById('board').getContext('2d');
        ctx.font = '16px sans-serif';
        d.data.quotes.forEach((q, i) => ctx.fillText(q.ccy + '   ' + q.weSell, 20, 30 + i * 28));
      });
  </script>
</body></html>`;

// Travel Money Oz shape: POST-only, demands a fresh request id, and repeats a
// currency across per-country rows.
const TMOZ = {
  Data: {
    ConvertedDate: '13 Aug, 2026',
    Rates: [
      { TargetCurrency: 'USD', ExchangeRate: 0.6489 },
      { TargetCurrency: 'EUR', ExchangeRate: 0.5991 },
      { TargetCurrency: 'EUR', ExchangeRate: 0.599 },
      { TargetCurrency: 'GBP', ExchangeRate: 0.5203 },
    ],
  },
};

// Travelex shape: an object keyed by currency code.
const KEYED = {
  rates: {
    rates: {
      USD: { sellRate: 0.6489, buyRate: 0.6904 },
      EUR: { sellRate: 0.5991, buyRate: 0.6378 },
      XXX: { sellRate: 1 },
    },
  },
};

// Same canvas trick, but the rates arrive over a POST the engine has to replay.
const PAGE_POST = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture POST</title></head>
<body>
  <h1>Fixture POST</h1>
  <canvas id="board" width="520" height="220"></canvas>
  <script>
    const uid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
    fetch('/api/tmoz-style', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ RequestId: uid(), CorrelationId: uid(), SourceCurrency: 'AUD' }),
    })
      .then((r) => r.json())
      .then((d) => {
        const ctx = document.getElementById('board').getContext('2d');
        ctx.font = '16px sans-serif';
        d.Data.Rates.forEach((q, i) => ctx.fillText(q.TargetCurrency + '   ' + q.ExchangeRate, 20, 30 + i * 28));
      });
  </script>
</body></html>`;

const counts = { page: 0, pagePost: 0, api: 0, tmoz: 0, keyed: 0 };
const seenRequestIds = [];

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/api/v2/quotes') {
    counts.api++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(QUOTES));
  }
  if (path === '/api/tmoz-style') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      return res.end('method not allowed');
    }
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      body = {};
    }
    const ids = [body.RequestId, body.CorrelationId];
    if (!ids.every((v) => typeof v === 'string' && v.length && v !== '<uuid>')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'RequestId and CorrelationId required' }));
    }
    counts.tmoz++;
    seenRequestIds.push(body.RequestId);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(TMOZ));
  }
  if (path === '/api/keyed-style') {
    counts.keyed++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(KEYED));
  }
  if (path === '/rates') {
    counts.page++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (path === '/rates-post') {
    counts.pagePost++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE_POST);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.removeListener('listening', onOk);
      reject(e);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve(port);
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}
async function startFixture() {
  for (let p = 4110; p <= 4140; p++) {
    try {
      return await listenOn(p);
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('no free port in 4110-4140 for the fixture server');
}

// --- run --------------------------------------------------------------------
const createdCompetitors = [];
let store = null;
try {
  const port = await startFixture();
  const pageUrl = `http://127.0.0.1:${port}/rates`;
  const quotesUrl = `http://127.0.0.1:${port}/api/v2/quotes`;
  console.log(`fixture site on ${pageUrl}\n`);

  store = stores.create({ name: `__selftune_test_${Date.now()}`, location: 'test fixture' });

  // 1. canvas-only page → discovery from sniffed traffic
  let comp = competitors.create({
    name: 'Canvas FX',
    store_id: store.id,
    location: 'test fixture',
    scrape_config: { strategy: 'auto', render: true, url: pageUrl, only: ['USD', 'EUR', 'GBP'] },
  });
  createdCompetitors.push(comp.id);

  const r1 = await scrapeCompetitor(comp, { persist: true });
  console.log(`run 1 → ${r1.status}: ${r1.message}`);
  check('run 1 extracts 3 rates from the page\'s own JSON traffic', () => {
    assert.equal(r1.status, 'ok');
    assert.equal(r1.rates_found, 3);
  });
  check('run 1 values match the fixture API', () => {
    const by = Object.fromEntries(r1.rates.map((r) => [r.currency, r]));
    assert.deepEqual(Object.keys(by).sort(), ['EUR', 'GBP', 'USD']);
    assert.equal(by.USD.sell_rate, 0.6489);
    assert.equal(by.USD.buy_rate, 0.6904);
    assert.equal(by.EUR.sell_rate, 0.5991);
    assert.equal(by.EUR.buy_rate, 0.6378);
    assert.equal(by.GBP.sell_rate, 0.5203);
    assert.equal(by.GBP.buy_rate, 0.5515);
  });
  check('run 1 message reports the render + discovery', () => {
    assert.match(r1.message, /\[json-api\]/);
    assert.match(r1.message, /auto-discovered API: 127\.0\.0\.1:\d+\/api\/v2\/quotes/);
  });
  check('run 1 persisted the rates', () => {
    assert.equal(rates.latest(comp.id, 'USD').sell_rate, 0.6489);
    assert.equal(rates.latest(comp.id, 'GBP').buy_rate, 0.5515);
  });

  comp = competitors.get(comp.id);
  check('working config auto-adopted onto the competitor', () => {
    const c = comp.scrape_config;
    assert.equal(c.strategy, 'json');
    assert.equal(c.url, quotesUrl);
    assert.equal(c.items, 'data.quotes');
    assert.deepEqual(c.map, { code: 'ccy', sell: 'weSell', buy: 'weBuy' });
    assert.deepEqual(c.only, ['USD', 'EUR', 'GBP']);
    assert.equal(c.page_url, pageUrl);
    assert.ok(c.adopted, 'expected an `adopted` marker on the config');
  });

  // 2. adopted config → straight to the API, no browser
  const pagesBefore = counts.page;
  const r2 = await scrapeCompetitor(comp, { persist: true });
  console.log(`run 2 → ${r2.status}: ${r2.message}`);
  check('run 2 re-scrapes 3 rates via the adopted JSON endpoint', () => {
    assert.equal(r2.status, 'ok');
    assert.equal(r2.rates_found, 3);
    assert.match(r2.message, /\[json-api\]/);
  });
  check('run 2 skips the browser entirely', () => {
    assert.equal(counts.page, pagesBefore, 'the page was rendered again');
    assert.doesNotMatch(r2.message, /auto-discovered/);
  });

  // 3. magnitude sanity filter — same feed, but this competitor also wants JPY
  let bogus = competitors.create({
    name: 'Canvas FX (JPY)',
    store_id: store.id,
    location: 'test fixture',
    scrape_config: { strategy: 'auto', render: true, url: pageUrl, only: ['USD', 'EUR', 'GBP', 'JPY'] },
  });
  createdCompetitors.push(bogus.id);

  const r3 = await scrapeCompetitor(bogus, { persist: true });
  console.log(`run 3 → ${r3.status}: ${r3.message}`);
  check('implausible JPY quote (0.0098 vs ~98) is dropped', () => {
    assert.equal(r3.rates_found, 3);
    assert.ok(!r3.rates.some((r) => r.currency === 'JPY'), 'JPY survived the sanity filter');
    assert.match(r3.message, /dropped 1 implausible rate\(s\)/);
  });
  check('the dropped JPY rate was not persisted', () => {
    assert.equal(rates.latest(bogus.id, 'JPY'), undefined);
  });

  // 4. self-healing — adopted endpoint dies, page_url is re-rendered
  bogus = competitors.update(bogus.id, {
    scrape_config: { ...competitors.get(bogus.id).scrape_config, url: `http://127.0.0.1:${port}/api/v1/gone` },
  });
  const pagesBeforeHeal = counts.page;
  const r4 = await scrapeCompetitor(bogus, { persist: true });
  console.log(`run 4 → ${r4.status}: ${r4.message}`);
  check('a dead adopted endpoint falls back to the page and re-discovers', () => {
    assert.equal(r4.status, 'ok');
    assert.equal(r4.rates_found, 3);
    assert.match(r4.message, /fell back to page render/);
    assert.match(r4.message, /auto-discovered API/);
    assert.equal(counts.page, pagesBeforeHeal + 1);
  });
  check('the healed endpoint is adopted again', () => {
    assert.equal(competitors.get(bogus.id).scrape_config.url, quotesUrl);
  });

  // 5. POST config with per-call <uuid> placeholders (Travel Money Oz shape)
  const tmoz = competitors.create({
    name: 'Fixture Money Oz',
    store_id: store.id,
    location: 'test fixture',
    scrape_config: {
      strategy: 'json',
      url: `http://127.0.0.1:${port}/api/tmoz-style`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { RequestId: '<uuid>', CorrelationId: '<uuid>', SourceCurrency: 'AUD' },
      items: 'Data.Rates',
      map: { code: 'TargetCurrency', sell: 'ExchangeRate' },
      only: ['USD', 'EUR', 'GBP'],
    },
  });
  createdCompetitors.push(tmoz.id);

  const r5 = await scrapeCompetitor(tmoz, { persist: true });
  console.log(`run 5 → ${r5.status}: ${r5.message}`);
  check('POST config with <uuid> placeholders is accepted by the API', () => {
    assert.equal(r5.status, 'ok');
    assert.equal(r5.rates_found, 3);
    assert.equal(counts.tmoz, 1);
  });
  check('duplicate currency rows dedupe first-wins, values exact', () => {
    const by = Object.fromEntries(r5.rates.map((r) => [r.currency, r.sell_rate]));
    assert.deepEqual(by, { USD: 0.6489, EUR: 0.5991, GBP: 0.5203 });
  });

  const r5b = await scrapeCompetitor(tmoz, { persist: false });
  check('each call sends a fresh RequestId', () => {
    assert.equal(r5b.rates_found, 3);
    assert.equal(seenRequestIds.length, 2);
    assert.notEqual(seenRequestIds[0], seenRequestIds[1]);
    for (const id of seenRequestIds) assert.match(id, /^[0-9a-f-]{36}$/i);
  });

  // 6. rates published as an object keyed by currency code (Travelex shape)
  const keyed = competitors.create({
    name: 'Fixture Keyed FX',
    store_id: store.id,
    location: 'test fixture',
    scrape_config: {
      strategy: 'json',
      url: `http://127.0.0.1:${port}/api/keyed-style`,
      items: 'rates.rates',
      map: { sell: 'sellRate', buy: 'buyRate' },
    },
  });
  createdCompetitors.push(keyed.id);

  const r6 = await scrapeCompetitor(keyed, { persist: true });
  console.log(`run 6 → ${r6.status}: ${r6.message}`);
  check('code-keyed object yields rates, unknown codes rejected', () => {
    assert.equal(r6.status, 'ok');
    assert.equal(r6.rates_found, 2);
    const by = Object.fromEntries(r6.rates.map((r) => [r.currency, r]));
    assert.deepEqual(Object.keys(by).sort(), ['EUR', 'USD']);
    assert.equal(by.USD.sell_rate, 0.6489);
    assert.equal(by.USD.buy_rate, 0.6904);
    assert.equal(by.EUR.buy_rate, 0.6378);
  });
  check('keyed shape is discoverable too (items path + keyed map)', () => {
    const doc = { rates: { rates: { USD: 0.6489, EUR: 0.5991, GBP: 0.5203, XXX: 1 } } };
    const found = autoJsonStrategy(JSON.stringify(doc), {});
    assert.equal(found.items, 'rates.rates');
    assert.equal(found.map.code, KEYED_CODE);
    assert.deepEqual(
      found.rates.map((r) => [r.currency, r.sell_rate]),
      [['USD', 0.6489], ['EUR', 0.5991], ['GBP', 0.5203]]
    );
  });

  // 7. discovery of a POST endpoint — the adopted config must replay the verb,
  //    the body, and a fresh request id each time
  const posted = competitors.create({
    name: 'Canvas FX (POST)',
    store_id: store.id,
    location: 'test fixture',
    scrape_config: {
      strategy: 'auto',
      render: true,
      url: `http://127.0.0.1:${port}/rates-post`,
      only: ['USD', 'EUR', 'GBP'],
    },
  });
  createdCompetitors.push(posted.id);

  const r7 = await scrapeCompetitor(posted, { persist: true });
  console.log(`run 7 → ${r7.status}: ${r7.message}`);
  check('a POST-only API is discovered from page traffic', () => {
    assert.equal(r7.status, 'ok');
    assert.equal(r7.rates_found, 3);
    assert.match(r7.message, /auto-discovered API/);
  });
  check('the adopted config replays the POST with a <uuid> placeholder', () => {
    const c = competitors.get(posted.id).scrape_config;
    assert.equal(c.strategy, 'json');
    assert.equal(c.method, 'POST');
    assert.equal(c.items, 'Data.Rates');
    assert.deepEqual(c.map, { code: 'TargetCurrency', sell: 'ExchangeRate' });
    assert.deepEqual(c.body, { RequestId: '<uuid>', CorrelationId: '<uuid>', SourceCurrency: 'AUD' });
  });

  const idsBefore = seenRequestIds.length;
  const pagePostsBefore = counts.pagePost;
  const r8 = await scrapeCompetitor(competitors.get(posted.id), { persist: false });
  console.log(`run 8 → ${r8.status}: ${r8.message}`);
  check('the adopted POST config runs statically with a fresh id', () => {
    assert.equal(r8.rates_found, 3);
    assert.equal(counts.pagePost, pagePostsBefore, 'the page was rendered again');
    assert.equal(seenRequestIds.length, idsBefore + 1);
    assert.equal(new Set(seenRequestIds).size, seenRequestIds.length, 'a request id was reused');
  });

  // 8. competitors.getByName — the lookup `npm run scrape -- "Name"` depends on
  check('getByName resolves a competitor case-insensitively', () => {
    const hit = competitors.getByName('fIxTuRe MoNeY oZ');
    assert.ok(hit, 'no competitor returned');
    assert.equal(hit.id, tmoz.id);
    assert.equal(hit.scrape_config.method, 'POST');
    assert.equal(competitors.getByName('no such competitor'), undefined);
  });
} catch (e) {
  failed++;
  console.error(`FAIL  test crashed\n      ${e.stack}`);
} finally {
  server.close();
  for (const id of createdCompetitors) {
    db.prepare('DELETE FROM rates WHERE competitor_id = ?').run(id);
    db.prepare('DELETE FROM scrape_runs WHERE competitor_id = ?').run(id);
    db.prepare('DELETE FROM competitors WHERE id = ?').run(id);
  }
  if (store) db.prepare('DELETE FROM stores WHERE id = ?').run(store.id);
  if (!dbExisted) {
    try {
      db.close();
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* leaving a fresh empty DB behind is harmless */
    }
  }
}

console.log(failed ? `\n${failed} check(s) FAILED, ${passed} passed` : `\nAll ${passed} checks passed.`);
process.exit(failed ? 1 : 0);
