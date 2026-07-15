// CLI: run a scrape from the terminal / cron outside the server.
//   node src/scrape-cli.js            # scrape all configured competitors
//   node src/scrape-cli.js "Name"     # scrape one competitor by name
import { competitors as competitorsRepo } from './db.js';
import { scrapeAll, scrapeCompetitor } from './scraper/engine.js';

const target = process.argv.slice(2).join(' ').trim();

(async () => {
  if (target) {
    const c = competitorsRepo.getByName(target);
    if (!c) {
      console.error(`No competitor named "${target}"`);
      process.exit(1);
    }
    const r = await scrapeCompetitor(c);
    console.log(`${c.name}: ${r.status} — ${r.message}`);
  } else {
    const results = await scrapeAll();
    if (!results.length) console.log('No competitors have a scrape config yet.');
    for (const r of results) console.log(`${r.competitor}: ${r.status} — ${r.message}`);
  }
  process.exit(0);
})();
