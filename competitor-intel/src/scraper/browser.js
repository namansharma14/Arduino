// Headless-browser rendering for JS-heavy competitor sites (Travelex, TMOZ, …).
// Uses playwright-core + any locally available Chromium. playwright-core ships no
// browser; install one with:  npx --yes playwright install chromium
// or point SCRAPE_CHROME_PATH at an existing Chrome/Chromium binary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let chromiumMod = null;
async function pw() {
  if (!chromiumMod) chromiumMod = (await import('playwright-core')).chromium;
  return chromiumMod;
}

function scanBrowsersDir(dir, out) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const d of fs.readdirSync(dir)) {
    if (!d.startsWith('chromium')) continue;
    out.push(
      path.join(dir, d, 'chrome-linux', 'chrome'),
      path.join(dir, d, 'chrome-linux', 'headless_shell'),
      path.join(dir, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    );
  }
}

export async function findChrome() {
  const candidates = [];
  if (process.env.SCRAPE_CHROME_PATH) candidates.push(process.env.SCRAPE_CHROME_PATH);
  scanBrowsersDir(process.env.PLAYWRIGHT_BROWSERS_PATH, candidates);
  scanBrowsersDir(path.join(os.homedir(), '.cache', 'ms-playwright'), candidates);
  try {
    const chromium = await pw();
    candidates.push(chromium.executablePath());
  } catch {
    /* registry may not resolve — fine */
  }
  candidates.push(
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  );
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function browserAvailable() {
  return !!(await findChrome());
}

// Render a page and return its post-JS HTML. With sniff:true, also captures JSON
// responses that look rate-related — the fastest route to a site's hidden API.
export async function renderPage(
  url,
  { timeoutMs = 30000, waitSelector = null, extraWaitMs = 1500, sniff = false, userAgent = null } = {}
) {
  const exe = await findChrome();
  if (!exe) {
    throw new Error('No Chromium found — run: npx --yes playwright install chromium (or set SCRAPE_CHROME_PATH)');
  }
  const chromium = await pw();
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const ctx = await browser.newContext({
      userAgent: userAgent || undefined,
      viewport: { width: 1366, height: 900 },
      locale: 'en-AU',
      timezoneId: 'Australia/Brisbane',
    });
    const page = await ctx.newPage();
    const jsonHits = [];
    if (sniff) {
      page.on('response', async (r) => {
        try {
          const ct = r.headers()['content-type'] || '';
          if (!/json/i.test(ct)) return;
          const body = await r.text();
          if (body.length < 20 || body.length > 2_000_000) return;
          if (/\b(USD|EUR|GBP|JPY|NZD|THB|rate|currenc)/i.test(body)) {
            jsonHits.push({ url: r.url(), size: body.length, sample: body.slice(0, 400) });
          }
        } catch {
          /* response body may be gone — ignore */
        }
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 9000 }).catch(() => {});
    if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 9000 }).catch(() => {});
    if (extraWaitMs) await page.waitForTimeout(extraWaitMs);
    const html = await page.content();
    return { html, jsonHits };
  } finally {
    await browser.close();
  }
}
