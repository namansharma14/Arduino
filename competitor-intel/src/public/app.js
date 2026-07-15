// Crown Currency — Competitor Intel front-end (vanilla ES modules, no build step).
import { lineChart, sparkline } from '/charts.js';

// ---------------------------------------------------------------------------
// API + small helpers
// ---------------------------------------------------------------------------
const api = {
  async req(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));
    if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data;
  },
  get: (p) => api.req('GET', p),
  post: (p, b) => api.req('POST', p, b),
  put: (p, b) => api.req('PUT', p, b),
  del: (p) => api.req('DELETE', p),
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isErr ? ' err' : ''}`;
  setTimeout(() => (t.className = 'toast'), 2800);
}

function timeAgo(sql) {
  if (!sql) return '—';
  const d = new Date(sql.replace(' ', 'T') + 'Z');
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function dateTime(sql) {
  if (!sql) return '—';
  return new Date(sql.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
}
const pct = (v, dp = 2) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`);

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
const state = { meta: null, competitors: [], view: 'dashboard', trends: { competitorId: null, currency: null, days: 30 } };

async function loadCore() {
  const [meta, competitors] = await Promise.all([api.get('/meta'), api.get('/competitors')]);
  state.meta = meta;
  state.competitors = competitors;
}

function currencyOptions(selected) {
  return state.meta.currencies.map((c) => `<option value="${c.code}"${c.code === selected ? ' selected' : ''}>${c.code} — ${esc(c.name)}</option>`).join('');
}
function competitorOptions(selected, { includeAuto = false, onlyReal = false } = {}) {
  let opts = includeAuto ? `<option value="">Auto-detect from text</option>` : '';
  for (const c of state.competitors) {
    if (onlyReal && c.is_self) continue;
    opts += `<option value="${c.id}"${String(c.id) === String(selected) ? ' selected' : ''}>${esc(c.name)}${c.is_self ? ' (us)' : ''}</option>`;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const views = {};
async function navigate(view) {
  state.view = view;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await views[view]();
  } catch (e) {
    app.innerHTML = `<div class="empty-state">⚠ ${esc(e.message)}</div>`;
  }
}

// ===========================================================================
// DASHBOARD
// ===========================================================================
views.dashboard = async function () {
  const [board, intelFeed] = await Promise.all([api.get('/board'), api.get('/intel?limit=60')]);
  const { board: cards, competitors, self } = board;

  const recentAlerts = intelFeed.filter((n) => (n.flags || []).some((f) => ['stock_out', 'beating_us', 'low_stock', 'promo'].includes(f))).slice(0, 6);
  const lastUpdate = cards.flatMap((c) => c.rows.map((r) => r.captured_at)).sort().pop();
  const staleCount = cards.reduce((a, c) => a + c.rows.filter((r) => r.stale).length, 0);

  const kpis = [
    { val: competitors.length, label: 'Competitors tracked', sub: `${competitors.filter((c) => !c.is_self).length} rivals + you` },
    { val: cards.length, label: 'Currencies on the board' },
    { val: recentAlerts.length, label: 'Live intel alerts', sub: recentAlerts.length ? 'stock / undercut / promo' : 'all quiet', cls: recentAlerts.length ? 'warn' : '' },
    { val: lastUpdate ? timeAgo(lastUpdate) : '—', label: 'Last rate captured', sub: staleCount ? `${staleCount} stale (>36h)` : 'all fresh' },
  ];

  app.innerHTML = `
    <div class="section-head">
      <div><h2>Live Rate Board</h2><div class="section-sub">Consolidated online + counter rates across competitors — foreign units per AUD (higher = better for the customer).</div></div>
      <button class="btn secondary small" id="scrapeAllBtn">⟳ Scrape all sites now</button>
    </div>
    <div class="kpis">
      ${kpis.map((k) => `<div class="card kpi"><div class="k-val">${k.val}</div><div class="k-label">${k.label}</div>${k.sub ? `<div class="k-sub ${k.cls === 'warn' ? 'delta-down' : 'muted'}">${k.sub}</div>` : ''}</div>`).join('')}
    </div>
    ${recentAlerts.length ? `<div class="card" style="padding:14px 16px;margin-bottom:20px">
        <h3 style="font-size:14px;margin-bottom:10px">⚡ Intel alerts</h3>
        <div class="row">${recentAlerts.map(alertChip).join('')}</div>
      </div>` : ''}
    <div class="board-grid" id="boardGrid">
      ${cards.map(boardCard).join('') || '<div class="empty-state">No rates yet. Add a competitor and log a rate, or run a scrape.</div>'}
    </div>
  `;

  // sparklines
  for (const c of cards) {
    const wrap = $(`#spark-${c.currency}`);
    if (wrap && c.spark?.length) sparkline(wrap, c.spark, cssVar('--brand'));
  }
  // card click -> trends
  document.querySelectorAll('.ccard').forEach((el) =>
    el.addEventListener('click', () => {
      state.trends.currency = el.dataset.currency;
      state.trends.competitorId = competitors.find((c) => !c.is_self)?.id || competitors[0]?.id;
      navigate('trends');
    })
  );
  $('#scrapeAllBtn').addEventListener('click', runScrapeAll);
};

function boardCard(c) {
  const selfRow = c.rows.find((r) => r.is_self);
  const top = c.rows.slice(0, 4);
  return `
    <div class="card ccard" data-currency="${c.currency}">
      <div class="ccard-top">
        <div><div class="ccode">${c.currency}</div><div class="cname">${esc(state.meta.currencies.find((x) => x.code === c.currency)?.name || '')}</div></div>
        ${selfRow ? `<span class="badge ${selfRow.rank === 1 ? 'good' : selfRow.rank === c.count ? 'bad' : 'neutral'}">Crown #${selfRow.rank}/${c.count}</span>` : ''}
      </div>
      <div class="spark-wrap" id="spark-${c.currency}"></div>
      <div class="crank">
        <span class="badge good">Best ${esc(c.best.competitor)} ${c.best.display}</span>
        <span class="badge neutral">Spread ${(c.spread ?? 0).toFixed(c.decimals)}</span>
      </div>
      <div class="rank-list">
        ${top
          .map(
            (r) => `<div class="rank-row">
              <span class="rr-num ${r.best ? 'best' : ''}">${r.rank}</span>
              <span class="rr-name">${esc(r.competitor)} ${r.is_self ? '<span class="self-tag">US</span>' : ''}</span>
              <span class="rr-val">${r.display}</span>
            </div>`
          )
          .join('')}
      </div>
    </div>`;
}

function alertChip(n) {
  const flag = (n.flags || [])[0];
  const cls = flag === 'promo' ? 'warn' : 'bad';
  return `<span class="badge ${cls}" title="${esc(n.raw_text)}">${esc(n.competitor_name || 'Unknown')}: ${esc((n.flagLabels || [])[0] || 'intel')}${n.currency ? ' · ' + n.currency : ''}</span>`;
}

async function runScrapeAll() {
  toast('Scraping competitor sites…');
  try {
    const results = await api.post('/scrape', {});
    const found = results.reduce((a, r) => a + (r.rates_found || 0), 0);
    const errs = results.filter((r) => r.status === 'error').length;
    toast(`Scrape done: ${found} rate(s) from ${results.length} site(s)${errs ? `, ${errs} failed` : ''}`);
    if (state.view === 'dashboard') navigate('dashboard');
  } catch (e) {
    toast(e.message, true);
  }
}

// ===========================================================================
// TRENDS & INSIGHTS
// ===========================================================================
views.trends = async function () {
  const t = state.trends;
  if (!t.competitorId) t.competitorId = state.competitors.find((c) => !c.is_self)?.id || state.competitors[0]?.id;
  if (!t.currency) t.currency = state.meta.currencies[0].code;

  app.innerHTML = `
    <div class="section-head"><div><h2>Trends &amp; Insights</h2><div class="section-sub">Pick a competitor and currency to see rate history and an auto-generated read on what they're doing.</div></div></div>
    <div class="controls">
      <label class="field">Competitor<select id="tCompetitor">${competitorOptions(t.competitorId)}</select></label>
      <label class="field">Currency<select id="tCurrency">${currencyOptions(t.currency)}</select></label>
      <label class="field">Timeframe
        <div class="seg" id="tRange">
          ${[7, 30, 90].map((d) => `<button data-d="${d}" class="${t.days === d ? 'active' : ''}">${d}d</button>`).join('')}
        </div>
      </label>
    </div>
    <div id="trendBody"><div class="loading">Loading…</div></div>
  `;
  $('#tCompetitor').addEventListener('change', (e) => {
    t.competitorId = Number(e.target.value);
    renderTrendBody();
  });
  $('#tCurrency').addEventListener('change', (e) => {
    t.currency = e.target.value;
    renderTrendBody();
  });
  $('#tRange').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    t.days = Number(b.dataset.d);
    document.querySelectorAll('#tRange button').forEach((x) => x.classList.toggle('active', x === b));
    renderTrendBody();
  });
  await renderTrendBody();
};

async function renderTrendBody() {
  const t = state.trends;
  const body = $('#trendBody');
  body.innerHTML = '<div class="loading">Loading…</div>';
  const data = await api.get(`/trends?competitor_id=${t.competitorId}&currency=${t.currency}&days=${t.days}`);
  const self = state.competitors.find((c) => c.is_self);
  const showSelf = self && self.id !== data.competitor.id;
  const selfData = showSelf ? await api.get(`/trends?competitor_id=${self.id}&currency=${t.currency}&days=${t.days}`).catch(() => null) : null;

  body.innerHTML = `
    <div class="insights-layout">
      <div class="card chart-box"><div id="trendChart"></div></div>
      <div class="card insights-panel">
        <h3>🧠 Smart insights <span class="muted" style="font-weight:400">· ${esc(data.competitor.name)} · ${data.currency}</span></h3>
        ${statGrid(data)}
        <div style="margin-top:14px">${data.signals.map((s) => `<div class="signal ${s.level}"><span class="dot"></span><span>${esc(s.text)}</span></div>`).join('')}</div>
        <ul class="narrative">${data.narrative.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>
    </div>
  `;

  const series = [];
  const compPoints = data.series.filter((p) => p.sell != null).map((p) => ({ t: p.t, v: p.sell }));
  series.push({ name: data.competitor.name, color: cssVar('--accent'), points: compPoints, width: 2.5, fill: true });
  if (selfData) {
    const sp = selfData.series.filter((p) => p.sell != null).map((p) => ({ t: p.t, v: p.sell }));
    if (sp.length) series.push({ name: 'Crown (us)', color: cssVar('--brand'), points: sp, dashed: true });
  }
  if (data.market?.length) {
    series.push({ name: 'Market avg', color: '#8a94a6', points: data.market.map((m) => ({ t: `${m.day}T12:00:00Z`, v: m.avg })), dashed: true, width: 1.5 });
  }
  lineChart($('#trendChart'), { series, decimals: data.decimals, height: 340 });
}

function statGrid(data) {
  const s = data.stats;
  if (!s) return '<div class="muted" style="margin-top:8px">No rate history yet for this pick.</div>';
  const d7cls = s.change7 == null ? '' : s.change7 >= 0 ? 'delta-up' : 'delta-down';
  return `<div class="statgrid">
    <div class="stat"><div class="s-val">${s.current.toFixed(data.decimals)}</div><div class="s-lab">Current</div></div>
    <div class="stat"><div class="s-val ${d7cls}">${pct(s.change7Pct)}</div><div class="s-lab">7-day</div></div>
    <div class="stat"><div class="s-val">${data.rank ? `#${data.rank}/${data.fieldSize}` : '—'}</div><div class="s-lab">Rank now</div></div>
    <div class="stat"><div class="s-val">${s.moves}</div><div class="s-lab">Moves/7d</div></div>
    <div class="stat"><div class="s-val">${s.low.toFixed(data.decimals)}</div><div class="s-lab">30d low</div></div>
    <div class="stat"><div class="s-val">${s.high.toFixed(data.decimals)}</div><div class="s-lab">30d high</div></div>
  </div>`;
}

// ===========================================================================
// INTEL FEED
// ===========================================================================
views.intel = async function () {
  const feed = await api.get('/intel?limit=150');
  app.innerHTML = `
    <div class="section-head">
      <div><h2>Intel Feed</h2><div class="section-sub">Everything the floor has heard — rates, stock, promos — parsed into signals.</div></div>
      <div class="controls" style="margin:0">
        <label class="field">Filter<select id="intelFilter"><option value="">All competitors</option>${competitorOptions(null)}</select></label>
        <button class="btn small" id="addIntelBtn">+ Add intel</button>
      </div>
    </div>
    <div id="intelList">${feed.length ? feed.map(intelItem).join('') : '<div class="empty-state">No intel logged yet. Head to Capture to add the first note.</div>'}</div>
  `;
  $('#addIntelBtn').addEventListener('click', () => navigate('capture'));
  $('#intelFilter').addEventListener('change', async (e) => {
    const q = e.target.value ? `?competitor_id=${e.target.value}&limit=150` : '?limit=150';
    const f = await api.get(`/intel${q}`);
    $('#intelList').innerHTML = f.length ? f.map(intelItem).join('') : '<div class="empty-state">No intel for that competitor yet.</div>';
  });
};

function intelItem(n) {
  const p = n.parsed || {};
  const chips = [];
  for (const r of p.rates || []) if (r.value != null) chips.push(`<span class="chip mono">${r.currency} ${r.display}${r.adjusted ? ' ?' : ''}</span>`);
  for (const fl of n.flagLabels || []) {
    const bad = /stock|undercut/.test(fl);
    chips.push(`<span class="badge ${bad ? 'bad' : 'warn'}">${esc(fl)}</span>`);
  }
  if (p.eta) chips.push(`<span class="chip">ETA ${esc(p.eta)}</span>`);
  return `<div class="card intel-item">
    <div class="intel-head">
      <span class="intel-comp">${esc(n.competitor_name || 'Unattributed')}</span>
      ${n.currency ? `<span class="badge accent">${n.currency}</span>` : ''}
      <span class="intel-meta">${esc(n.created_by || 'anon')} · ${dateTime(n.created_at)}</span>
    </div>
    <div class="intel-raw">"${esc(n.raw_text)}"</div>
    ${chips.length ? `<div class="intel-chips">${chips.join('')}</div>` : ''}
  </div>`;
}

// ===========================================================================
// CAPTURE (log rate + log intel)
// ===========================================================================
views.capture = async function () {
  app.innerHTML = `
    <div class="section-head"><div><h2>Capture Intel</h2><div class="section-sub">Log a rate you heard at the counter, or drop a free-text note and we'll parse it.</div></div></div>
    <div class="row">
      <div class="card grow" style="padding:18px;min-width:320px">
        <h3 style="margin-bottom:14px">💬 Log free-text intel</h3>
        <form id="intelForm">
          <label class="field">What did you hear / see? <span class="req">*</span>
            <textarea id="iRaw" placeholder="e.g. travel money oz is doing usd at 64 but don't have stock till coming Thur"></textarea>
          </label>
          <div class="preview-box" id="iPreview"><span class="muted">Detected signals will appear here as you type…</span></div>
          <div class="form-grid" style="margin-top:12px">
            <label class="field">Competitor<select id="iComp">${competitorOptions(null, { includeAuto: true })}</select></label>
            <label class="field">Your name<input id="iBy" placeholder="e.g. Priya" /></label>
          </div>
          <label class="field" style="flex-direction:row;align-items:center;gap:8px;margin-top:10px">
            <input type="checkbox" id="iCapture" checked style="width:auto" /> Also record the detected rate on the board
          </label>
          <button class="btn" type="submit" style="margin-top:14px">Save intel</button>
        </form>
      </div>

      <div class="card grow" style="padding:18px;min-width:320px">
        <h3 style="margin-bottom:14px">🧾 Log a counter rate</h3>
        <form id="rateForm">
          <div class="form-grid">
            <label class="field">Competitor <span class="req">*</span><select id="rComp">${competitorOptions(null)}</select></label>
            <label class="field">Currency <span class="req">*</span><select id="rCur">${currencyOptions('USD')}</select></label>
            <label class="field">Sell rate (units/AUD) <span class="req">*</span><input id="rSell" inputmode="decimal" placeholder="e.g. 0.6450 or 64" /></label>
            <label class="field">Buy-back rate<input id="rBuy" inputmode="decimal" placeholder="optional" /></label>
            <label class="field">Source<select id="rSrc"><option value="counter">Heard at counter</option><option value="online">Seen online</option><option value="intel">Customer intel</option></select></label>
            <label class="field">Your name<input id="rBy" placeholder="e.g. Marcus" /></label>
          </div>
          <label class="field" style="margin-top:12px">Note<input id="rNote" placeholder="optional context" /></label>
          <div class="help">Tip: type the rate as customers say it ("64") and we'll normalise it to 0.6400 for that currency.</div>
          <button class="btn" type="submit" style="margin-top:14px">Add rate to board</button>
        </form>
      </div>
    </div>
  `;

  // live intel preview
  const raw = $('#iRaw');
  const preview = $('#iPreview');
  const updatePreview = debounce(async () => {
    const text = raw.value.trim();
    if (!text) {
      preview.innerHTML = '<span class="muted">Detected signals will appear here as you type…</span>';
      return;
    }
    try {
      const p = await api.post('/intel/preview', { raw_text: text, currency: null });
      const chips = [];
      for (const r of p.rates || []) if (r.value != null) chips.push(`<span class="chip mono">${r.currency} ${r.display}${r.adjusted ? ' ?' : ''}</span>`);
      for (const fl of p.flagLabels || []) chips.push(`<span class="badge ${/stock|undercut/.test(fl) ? 'bad' : 'warn'}">${esc(fl)}</span>`);
      if (p.eta) chips.push(`<span class="chip">ETA ${esc(p.eta)}</span>`);
      if (p.competitorGuess) chips.unshift(`<span class="badge accent">→ ${esc(p.competitorGuess.name)}</span>`);
      preview.innerHTML = chips.length ? `<div class="intel-chips">${chips.join('')}</div><div class="help" style="margin-top:8px">${esc(p.summary)}</div>` : '<span class="muted">No structured signals detected — it will still be saved as a note.</span>';
      // auto-select detected competitor if user left it on auto
      if (p.competitorGuess && !$('#iComp').value) $('#iComp').value = p.competitorGuess.id;
    } catch {
      /* ignore preview errors */
    }
  }, 260);
  raw.addEventListener('input', updatePreview);

  $('#intelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw_text = $('#iRaw').value.trim();
    if (!raw_text) return toast('Enter what you heard', true);
    try {
      const r = await api.post('/intel', {
        raw_text,
        competitor_id: $('#iComp').value || null,
        created_by: $('#iBy').value.trim() || null,
        captureRates: $('#iCapture').checked,
      });
      const promoted = r.promotedRates?.length ? ` · ${r.promotedRates.length} rate(s) added to board` : '';
      toast(`Intel saved${promoted}`);
      $('#iRaw').value = '';
      preview.innerHTML = '<span class="muted">Detected signals will appear here as you type…</span>';
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#rateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sell = $('#rSell').value.trim();
    if (!sell) return toast('Enter a sell rate', true);
    try {
      await api.post('/rates', {
        competitor_id: Number($('#rComp').value),
        currency: $('#rCur').value,
        sell_rate: parseFloat(sell),
        buy_rate: $('#rBuy').value.trim() ? parseFloat($('#rBuy').value) : null,
        source: $('#rSrc').value,
        captured_by: $('#rBy').value.trim() || null,
        note: $('#rNote').value.trim() || null,
      });
      toast('Rate added to the board');
      $('#rSell').value = '';
      $('#rBuy').value = '';
      $('#rNote').value = '';
    } catch (err) {
      toast(err.message, true);
    }
  });
};

// ===========================================================================
// COMPETITORS
// ===========================================================================
views.competitors = async function () {
  const [runs] = await Promise.all([api.get('/scrape/runs?limit=12').catch(() => [])]);
  const comps = state.competitors;
  app.innerHTML = `
    <div class="section-head"><div><h2>Competitors</h2><div class="section-sub">Onboard rivals and (optionally) point us at their online rate page to auto-scrape.</div></div></div>
    <div class="insights-layout" style="grid-template-columns:1.4fr 1fr">
      <div class="card" style="padding:6px 6px 2px">
        <table class="tbl">
          <thead><tr><th>Name</th><th>Location</th><th>Scrape</th><th></th></tr></thead>
          <tbody id="compRows">
            ${comps.map(compRow).join('')}
          </tbody>
        </table>
      </div>
      <div class="card" style="padding:18px">
        <h3 id="formTitle" style="margin-bottom:14px">➕ Add competitor</h3>
        <form id="compForm">
          <input type="hidden" id="cId" />
          <label class="field">Name <span class="req">*</span><input id="cName" placeholder="e.g. Travel Money Oz" required /></label>
          <label class="field" style="margin-top:10px">Location <span class="req">*</span><input id="cLoc" placeholder="e.g. Queen St Mall, Brisbane" required /></label>
          <label class="field" style="margin-top:10px">Website<input id="cWeb" placeholder="https://…" /></label>
          <label class="field" style="margin-top:10px">Notes<input id="cNotes" placeholder="anything useful" /></label>
          <details class="adv">
            <summary>Advanced: auto-scrape config</summary>
            <div class="form-grid" style="margin-top:10px">
              <label class="field">Strategy<select id="cStrat"><option value="">None (manual only)</option><option value="auto">Auto (scan page text)</option><option value="selector">Selector (HTML table)</option><option value="json">JSON API</option></select></label>
              <label class="field">Rates URL<input id="cUrl" placeholder="https://…/exchange-rates" /></label>
            </div>
            <div class="help">"Auto" scans the page for currency codes and nearby numbers — good enough to start, tune later. Selector/JSON need a small config; see the README.</div>
          </details>
          <div class="inline-actions" style="margin-top:14px">
            <button class="btn" type="submit" id="compSubmit">Add competitor</button>
            <button class="btn secondary" type="button" id="compReset" style="display:none">Cancel</button>
          </div>
        </form>
      </div>
    </div>
    <div class="subtle-divider"></div>
    <div class="section-head"><h3>Recent scrape runs</h3><button class="btn secondary small" id="scrapeAll2">⟳ Scrape all now</button></div>
    <div class="card" style="padding:6px"><table class="tbl"><thead><tr><th>When</th><th>Competitor</th><th>Status</th><th>Result</th></tr></thead>
      <tbody id="runRows">${runs.length ? runs.map(runRow).join('') : '<tr><td colspan="4" class="muted" style="padding:16px">No scrape runs yet.</td></tr>'}</tbody></table></div>
  `;

  wireCompetitorForm();
  $('#scrapeAll2').addEventListener('click', async () => {
    await runScrapeAll();
    navigate('competitors');
  });
  document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => startEdit(Number(b.dataset.edit))));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removeCompetitor(Number(b.dataset.del))));
  document.querySelectorAll('[data-scrape]').forEach((b) => b.addEventListener('click', () => scrapeOne(Number(b.dataset.scrape), b)));
};

function compRow(c) {
  const cfg = c.scrape_config;
  return `<tr>
    <td><b>${esc(c.name)}</b>${c.is_self ? ' <span class="self-tag">US</span>' : ''}${c.website ? `<br><a href="${esc(c.website)}" target="_blank" rel="noopener" class="muted" style="font-size:12px">${esc(c.website.replace(/^https?:\/\//, ''))}</a>` : ''}</td>
    <td>${esc(c.location)}</td>
    <td>${cfg?.url ? `<span class="badge good">${esc(cfg.strategy || 'auto')}</span>` : '<span class="muted">manual</span>'}</td>
    <td><div class="inline-actions">
      ${cfg?.url ? `<button class="btn secondary small" data-scrape="${c.id}">Scrape</button>` : ''}
      <button class="btn secondary small" data-edit="${c.id}">Edit</button>
      ${c.is_self ? '' : `<button class="btn danger small" data-del="${c.id}">Del</button>`}
    </div></td>
  </tr>`;
}
function runRow(r) {
  const cls = r.status === 'ok' ? 'good' : r.status === 'error' ? 'bad' : 'warn';
  return `<tr><td class="muted">${dateTime(r.started_at)}</td><td>${esc(r.competitor_name || '—')}</td><td><span class="badge ${cls}">${esc(r.status)}</span></td><td class="muted">${esc(r.message || '')}</td></tr>`;
}

function wireCompetitorForm() {
  $('#compForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#cId').value;
    const strat = $('#cStrat').value;
    const url = $('#cUrl').value.trim();
    const scrape_config = strat && url ? { strategy: strat, url } : null;
    const payload = {
      name: $('#cName').value.trim(),
      location: $('#cLoc').value.trim(),
      website: $('#cWeb').value.trim() || null,
      notes: $('#cNotes').value.trim() || null,
      scrape_config,
    };
    if (!payload.name || !payload.location) return toast('Name and location are required', true);
    try {
      if (id) await api.put(`/competitors/${id}`, payload);
      else await api.post('/competitors', payload);
      toast(id ? 'Competitor updated' : 'Competitor added');
      state.competitors = await api.get('/competitors');
      navigate('competitors');
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#compReset').addEventListener('click', () => navigate('competitors'));
}

function startEdit(id) {
  const c = state.competitors.find((x) => x.id === id);
  if (!c) return;
  $('#cId').value = c.id;
  $('#cName').value = c.name;
  $('#cLoc').value = c.location;
  $('#cWeb').value = c.website || '';
  $('#cNotes').value = c.notes || '';
  $('#cStrat').value = c.scrape_config?.strategy || '';
  $('#cUrl').value = c.scrape_config?.url || '';
  $('#formTitle').textContent = `✏️ Edit ${c.name}`;
  $('#compSubmit').textContent = 'Save changes';
  $('#compReset').style.display = '';
  if (c.scrape_config) $('.adv').setAttribute('open', '');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function removeCompetitor(id) {
  const c = state.competitors.find((x) => x.id === id);
  if (!confirm(`Delete "${c?.name}" and all its rates? This can't be undone.`)) return;
  try {
    await api.del(`/competitors/${id}`);
    state.competitors = await api.get('/competitors');
    toast('Competitor deleted');
    navigate('competitors');
  } catch (e) {
    toast(e.message, true);
  }
}

async function scrapeOne(id, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const [res] = await api.post('/scrape', { competitor_id: id });
    toast(`${res.competitor}: ${res.status} — ${res.message}`, res.status === 'error');
  } catch (e) {
    toast(e.message, true);
  } finally {
    navigate('competitors');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function setupChrome() {
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.view)));
  $('#refreshBtn').addEventListener('click', async () => {
    state.competitors = await api.get('/competitors');
    navigate(state.view);
  });
  const themeBtn = $('#themeBtn');
  const stored = localStorage.getItem('theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);
  themeBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    navigate(state.view); // re-render charts with new theme colours
  });
}

(async function boot() {
  try {
    await loadCore();
    setupChrome();
    await navigate('dashboard');
  } catch (e) {
    app.innerHTML = `<div class="empty-state">⚠ Could not start: ${esc(e.message)}</div>`;
  }
})();
