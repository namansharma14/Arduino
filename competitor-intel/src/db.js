// SQLite persistence layer (better-sqlite3, synchronous).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'intel.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  location    TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS competitors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  store_id      INTEGER REFERENCES stores(id) ON DELETE CASCADE,
  website       TEXT,
  location      TEXT NOT NULL,
  is_self       INTEGER NOT NULL DEFAULT 0,   -- 1 = Crown Currency (our baseline for that store)
  active        INTEGER NOT NULL DEFAULT 1,
  scrape_config TEXT,                          -- JSON string, null = manual only
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, store_id)
);

CREATE TABLE IF NOT EXISTS intel_notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id INTEGER REFERENCES competitors(id) ON DELETE SET NULL,
  raw_text      TEXT NOT NULL,
  parsed        TEXT,
  currency      TEXT,
  flags         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT
);

CREATE TABLE IF NOT EXISTS rates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  currency      TEXT NOT NULL,                 -- ISO code, e.g. USD
  sell_rate     REAL,                          -- foreign units per 1 AUD (customer buys travel money)
  buy_rate      REAL,                          -- foreign units per 1 AUD (customer sells foreign back)
  source        TEXT NOT NULL DEFAULT 'counter', -- online | counter | intel
  captured_at   TEXT NOT NULL DEFAULT (datetime('now')),
  captured_by   TEXT,
  note          TEXT,
  intel_id      INTEGER REFERENCES intel_notes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_rates_lookup ON rates(competitor_id, currency, captured_at);
CREATE INDEX IF NOT EXISTS idx_rates_currency ON rates(currency, captured_at);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id INTEGER REFERENCES competitors(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  rates_found   INTEGER DEFAULT 0,
  message       TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_scrape_runs ON scrape_runs(competitor_id, started_at);
`);

// --- lightweight migration: add store_id to competitors on pre-existing DBs ---
const compCols = db.prepare(`PRAGMA table_info(competitors)`).all().map((c) => c.name);
if (!compCols.includes('store_id')) {
  db.exec(`ALTER TABLE competitors ADD COLUMN store_id INTEGER REFERENCES stores(id)`);
}

// Guarantee at least one store exists so competitors always have a home.
export function ensureDefaultStore() {
  let s = db.prepare('SELECT * FROM stores ORDER BY is_default DESC, id LIMIT 1').get();
  if (!s) {
    const info = db
      .prepare(`INSERT INTO stores (name, location, is_default) VALUES ('Main', 'Head office', 1)`)
      .run();
    s = db.prepare('SELECT * FROM stores WHERE id = ?').get(info.lastInsertRowid);
  }
  // Attach any store-less competitors to the default store.
  db.prepare('UPDATE competitors SET store_id = ? WHERE store_id IS NULL').run(s.id);
  return s;
}
ensureDefaultStore();

export default db;

// ---------------------------------------------------------------------------
const parseJSON = (s, fallback) => {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

function hydrateCompetitor(row) {
  if (!row) return row;
  return {
    ...row,
    is_self: !!row.is_self,
    active: !!row.active,
    scrape_config: parseJSON(row.scrape_config, null),
  };
}

export const stores = {
  all() {
    return db.prepare('SELECT * FROM stores ORDER BY is_default DESC, name').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  },
  getByName(name) {
    return db.prepare('SELECT * FROM stores WHERE name = ?').get(name);
  },
  create({ name, location = null, is_default = 0 }) {
    const info = db
      .prepare('INSERT INTO stores (name, location, is_default) VALUES (?, ?, ?)')
      .run(name, location, is_default ? 1 : 0);
    return this.get(info.lastInsertRowid);
  },
};

export const competitors = {
  all({ includeInactive = true, store_id = null } = {}) {
    const where = [];
    const params = [];
    if (!includeInactive) where.push('active = 1');
    if (store_id) {
      where.push('store_id = ?');
      params.push(store_id);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db
      .prepare(`SELECT * FROM competitors ${clause} ORDER BY is_self DESC, name`)
      .all(...params)
      .map(hydrateCompetitor);
  },
  get(id) {
    return hydrateCompetitor(db.prepare('SELECT * FROM competitors WHERE id = ?').get(id));
  },
  selfFor(store_id) {
    return hydrateCompetitor(
      db.prepare('SELECT * FROM competitors WHERE store_id = ? AND is_self = 1 LIMIT 1').get(store_id)
    );
  },
  create({ name, store_id, website = null, location, is_self = 0, scrape_config = null, notes = null }) {
    const info = db
      .prepare(
        `INSERT INTO competitors (name, store_id, website, location, is_self, scrape_config, notes)
         VALUES (@name, @store_id, @website, @location, @is_self, @scrape_config, @notes)`
      )
      .run({
        name,
        store_id,
        website,
        location,
        is_self: is_self ? 1 : 0,
        scrape_config: scrape_config ? JSON.stringify(scrape_config) : null,
        notes,
      });
    return this.get(info.lastInsertRowid);
  },
  update(id, patch) {
    const cur = db.prepare('SELECT * FROM competitors WHERE id = ?').get(id);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      website: patch.website ?? cur.website,
      location: patch.location ?? cur.location,
      store_id: patch.store_id ?? cur.store_id,
      active: patch.active === undefined ? cur.active : patch.active ? 1 : 0,
      notes: patch.notes ?? cur.notes,
      scrape_config:
        patch.scrape_config === undefined
          ? cur.scrape_config
          : patch.scrape_config
            ? JSON.stringify(patch.scrape_config)
            : null,
    };
    db.prepare(
      `UPDATE competitors SET name=@name, website=@website, location=@location, store_id=@store_id,
         active=@active, notes=@notes, scrape_config=@scrape_config WHERE id=@id`
    ).run({ ...next, id });
    return this.get(id);
  },
  remove(id) {
    return db.prepare('DELETE FROM competitors WHERE id = ?').run(id).changes > 0;
  },
};

export const rates = {
  insert({
    competitor_id,
    currency,
    sell_rate = null,
    buy_rate = null,
    source = 'counter',
    captured_at = null,
    captured_by = null,
    note = null,
    intel_id = null,
  }) {
    const info = db
      .prepare(
        `INSERT INTO rates (competitor_id, currency, sell_rate, buy_rate, source, captured_at, captured_by, note, intel_id)
         VALUES (@competitor_id, @currency, @sell_rate, @buy_rate, @source,
                 COALESCE(@captured_at, datetime('now')), @captured_by, @note, @intel_id)`
      )
      .run({
        competitor_id,
        currency: currency.toUpperCase(),
        sell_rate,
        buy_rate,
        source,
        captured_at,
        captured_by,
        note,
        intel_id,
      });
    return db.prepare('SELECT * FROM rates WHERE id = ?').get(info.lastInsertRowid);
  },
  series(competitor_id, currency, { sinceDays = null } = {}) {
    const clause = sinceDays ? `AND captured_at >= datetime('now', ?)` : '';
    const params = [competitor_id, currency.toUpperCase()];
    if (sinceDays) params.push(`-${sinceDays} days`);
    return db
      .prepare(
        `SELECT * FROM rates
         WHERE competitor_id = ? AND currency = ? ${clause}
         ORDER BY captured_at ASC`
      )
      .all(...params);
  },
  // Latest rate per competitor for a currency, scoped to a store.
  latestByCurrency(currency, store_id) {
    return db
      .prepare(
        `SELECT r.* FROM rates r
         JOIN competitors c ON c.id = r.competitor_id
         JOIN (
           SELECT competitor_id, MAX(captured_at) AS mx
           FROM rates WHERE currency = ?
           GROUP BY competitor_id
         ) t ON t.competitor_id = r.competitor_id AND t.mx = r.captured_at
         WHERE r.currency = ? AND c.store_id = ? AND c.active = 1`
      )
      .all(currency.toUpperCase(), currency.toUpperCase(), store_id);
  },
  latest(competitor_id, currency) {
    return db
      .prepare(
        `SELECT * FROM rates WHERE competitor_id = ? AND currency = ?
         ORDER BY captured_at DESC LIMIT 1`
      )
      .get(competitor_id, currency.toUpperCase());
  },
  recent(limit = 50, store_id = null) {
    const clause = store_id ? 'WHERE c.store_id = ?' : '';
    const params = store_id ? [store_id, limit] : [limit];
    return db
      .prepare(
        `SELECT r.*, c.name AS competitor_name FROM rates r
         JOIN competitors c ON c.id = r.competitor_id
         ${clause} ORDER BY r.captured_at DESC LIMIT ?`
      )
      .all(...params);
  },
  currenciesTracked(store_id = null) {
    const clause = store_id ? 'WHERE c.store_id = ?' : '';
    const params = store_id ? [store_id] : [];
    return db
      .prepare(
        `SELECT DISTINCT r.currency FROM rates r
         JOIN competitors c ON c.id = r.competitor_id ${clause}
         ORDER BY r.currency`
      )
      .all(...params)
      .map((r) => r.currency);
  },
};

export const intel = {
  insert({ competitor_id = null, raw_text, parsed = null, currency = null, flags = null, created_by = null }) {
    const info = db
      .prepare(
        `INSERT INTO intel_notes (competitor_id, raw_text, parsed, currency, flags, created_by)
         VALUES (@competitor_id, @raw_text, @parsed, @currency, @flags, @created_by)`
      )
      .run({
        competitor_id,
        raw_text,
        parsed: parsed ? JSON.stringify(parsed) : null,
        currency,
        flags: flags ? JSON.stringify(flags) : null,
        created_by,
      });
    return this.get(info.lastInsertRowid);
  },
  get(id) {
    const row = db
      .prepare(
        `SELECT n.*, c.name AS competitor_name, c.store_id FROM intel_notes n
         LEFT JOIN competitors c ON c.id = n.competitor_id WHERE n.id = ?`
      )
      .get(id);
    if (!row) return row;
    return { ...row, parsed: parseJSON(row.parsed, null), flags: parseJSON(row.flags, []) };
  },
  feed({ limit = 100, competitor_id = null, store_id = null } = {}) {
    const where = [];
    const params = [];
    if (competitor_id) {
      where.push('n.competitor_id = ?');
      params.push(competitor_id);
    }
    if (store_id) {
      where.push('c.store_id = ?');
      params.push(store_id);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    return db
      .prepare(
        `SELECT n.*, c.name AS competitor_name, c.store_id FROM intel_notes n
         LEFT JOIN competitors c ON c.id = n.competitor_id
         ${clause} ORDER BY n.created_at DESC LIMIT ?`
      )
      .all(...params)
      .map((row) => ({ ...row, parsed: parseJSON(row.parsed, null), flags: parseJSON(row.flags, []) }));
  },
};

export const scrapeRuns = {
  start(competitor_id) {
    const info = db
      .prepare(`INSERT INTO scrape_runs (competitor_id, status) VALUES (?, 'running')`)
      .run(competitor_id);
    return info.lastInsertRowid;
  },
  finish(id, { status, rates_found = 0, message = null }) {
    db.prepare(
      `UPDATE scrape_runs SET status=?, rates_found=?, message=?, finished_at=datetime('now') WHERE id=?`
    ).run(status, rates_found, message, id);
  },
  recent(limit = 50, store_id = null) {
    const clause = store_id ? 'WHERE c.store_id = ?' : '';
    const params = store_id ? [store_id, limit] : [limit];
    return db
      .prepare(
        `SELECT s.*, c.name AS competitor_name FROM scrape_runs s
         LEFT JOIN competitors c ON c.id = s.competitor_id
         ${clause} ORDER BY s.started_at DESC LIMIT ?`
      )
      .all(...params);
  },
};
