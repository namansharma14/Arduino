// Crown Currency — Competitor Intel server.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import api from './routes/index.js';
import { DEFAULTS } from './config.js';
import { scrapeAll } from './scraper/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '256kb' }));
app.use('/api', api);
app.use(
  express.static(path.join(__dirname, 'public'), {
    // Force revalidation so staff never run a stale app.js after an update.
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// SPA fallback (any non-API GET returns the app shell).
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(DEFAULTS.port, () => {
  console.log(`\n  Crown Competitor Intel running → http://localhost:${DEFAULTS.port}\n`);
  if (DEFAULTS.autoScrape && cron.validate(DEFAULTS.scrapeCron)) {
    cron.schedule(DEFAULTS.scrapeCron, async () => {
      const started = new Date().toISOString();
      try {
        const results = await scrapeAll();
        const found = results.reduce((a, r) => a + (r.rates_found || 0), 0);
        console.log(`[${started}] scheduled scrape: ${results.length} competitor(s), ${found} rate(s)`);
      } catch (e) {
        console.error(`[${started}] scheduled scrape failed:`, e.message);
      }
    });
    console.log(`  Auto-scrape scheduled (${DEFAULTS.scrapeCron}). Set AUTO_SCRAPE=false to disable.\n`);
  }
});

// Graceful shutdown so WAL files flush cleanly.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}

export default app;
