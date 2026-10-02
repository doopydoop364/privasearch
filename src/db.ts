import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { registrableDomain } from './domain.js';
import { urlKey } from './url.js';

/**
 * The one SQLite database behind PrivaSearch: frontier, hosts, documents, the full-text index, the link graph and the
 * demand-crawl query ledger. `initSchema` is idempotent and migrates a database created by an older version in place, so every
 * component can call it from its constructor and an upgrade never needs a manual step.
 *
 * Schema version 2 (0.4.0) adds: documents.{canonical_key, host, first_seen_at, last_changed_at, change_count}, the `links` table,
 * urls.{interval_ms, change_count, unchanged_streak, last_changed_at}, the `queries` table and a small `meta` table (a per-install salt for query hashes).
 * Schema version 3 adds `docs_index`, which maps a page to its full-text row so the row can be replaced by rowid. `docs_fts.url_key` is UNINDEXED,
 * so deleting by it scanned the whole index and made every ingest cost proportional to the index size.
 * Schema version 4 (crawl quality) adds the registrable-domain level: urls.{domain, source, external}, hosts.urls, documents.low_value, and the
 * `domains`, `states`, `domain_links` tables. The per-domain and per-state counters are maintained by TRIGGERS on `urls`, in the same transaction as every
 * state change, so they cannot drift (a crash or a rollback takes the counters with it) and no code path can forget to update them. `rebuildCounters`
 * recomputes them from `urls` (used by the migration and by the consistency test). The migration runs in ONE transaction: it applies completely or not at all.
 */
export const SCHEMA_VERSION = 4;

const TABLES = `
CREATE TABLE IF NOT EXISTS documents (
  url_key TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  canonical_url TEXT, language TEXT, text TEXT NOT NULL, content_sha256 TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  http_status INTEGER NOT NULL, duplicate_of TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS documents_hash ON documents(content_sha256);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(url_key UNINDEXED, title, description, text, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS urls (
  url_key TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL,
  queue TEXT NOT NULL CHECK (queue IN ('DEMAND','PUBLIC')), priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('PENDING','IN_FLIGHT','DONE','BLOCKED','FAILED')),
  generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0, discovered_at INTEGER NOT NULL,
  last_outcome TEXT, last_http INTEGER, etag TEXT, last_modified TEXT, content_sha256 TEXT, fetched_at INTEGER, leased_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS urls_due ON urls(state, next_at);
CREATE INDEX IF NOT EXISTS urls_host ON urls(host, state);
CREATE TABLE IF NOT EXISTS hosts (host TEXT PRIMARY KEY, next_allowed_at INTEGER NOT NULL DEFAULT 0, backoff_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS docs_index (id INTEGER PRIMARY KEY, url_key TEXT NOT NULL UNIQUE) STRICT;
`;
const TABLES_V2 = `
CREATE TABLE IF NOT EXISTS links (
  src_key TEXT NOT NULL, dst_key TEXT NOT NULL, dst_url TEXT NOT NULL, src_host TEXT NOT NULL, dst_host TEXT NOT NULL,
  PRIMARY KEY (src_key, dst_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS links_dst ON links(dst_key);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
-- The demand-crawl ledger. A query is stored only as a hash of its normalised terms, never as text.
CREATE TABLE IF NOT EXISTS queries (
  qkey TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, times_seen INTEGER NOT NULL DEFAULT 1,
  last_crawl_at INTEGER, crawl_rounds INTEGER NOT NULL DEFAULT 0, last_total INTEGER, last_strong INTEGER
) STRICT;
`;
const COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['documents', 'canonical_key', 'TEXT'], ['documents', 'host', 'TEXT'], ['documents', 'first_seen_at', 'INTEGER'],
  ['documents', 'last_changed_at', 'INTEGER'], ['documents', 'change_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['urls', 'interval_ms', 'INTEGER'], ['urls', 'change_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['urls', 'unchanged_streak', 'INTEGER NOT NULL DEFAULT 0'], ['urls', 'last_changed_at', 'INTEGER'],
];


const TABLES_V4 = `
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY, family TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0, pending_demand INTEGER NOT NULL DEFAULT 0, in_flight INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  urls INTEGER NOT NULL DEFAULT 0,
  vtime REAL NOT NULL DEFAULT 0, leased INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0, useful INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, low_value INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
  yield REAL NOT NULL DEFAULT 0.5, yield_at INTEGER NOT NULL DEFAULT 0, ref_domains INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS domains_ready ON domains(vtime) WHERE pending > 0;
CREATE INDEX IF NOT EXISTS domains_young ON domains(vtime) WHERE pending > 0 AND done < 5;
CREATE INDEX IF NOT EXISTS domains_family ON domains(family);
CREATE TABLE IF NOT EXISTS states (state TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0) STRICT, WITHOUT ROWID;
INSERT OR IGNORE INTO states (state, n) VALUES ('PENDING',0),('IN_FLIGHT',0),('DONE',0),('BLOCKED',0),('FAILED',0),('PENDING_DEMAND',0),('URLS',0);
-- Store-wide counts (pages, duplicates, indexed pages, link rows), exact and O(1) for /health and /status.
CREATE TABLE IF NOT EXISTS counts (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0) STRICT, WITHOUT ROWID;
INSERT OR IGNORE INTO counts (k, n) VALUES ('documents',0),('duplicates',0),('indexed',0),('links',0);
-- Distinct (linking domain, linked domain) pairs: authority counts independent domains, never raw link volume.
CREATE TABLE IF NOT EXISTS domain_links (src_domain TEXT NOT NULL, dst_domain TEXT NOT NULL, PRIMARY KEY (src_domain, dst_domain)) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS urls_domain_pending ON urls(domain, queue, priority DESC, next_at) WHERE state='PENDING';
CREATE INDEX IF NOT EXISTS urls_domain_state ON urls(domain, state);
CREATE INDEX IF NOT EXISTS urls_demand_domain ON urls(domain) WHERE source='demand';
`;
// Triggers keep counters exact. They run inside the transaction of the statement that fires them.
const TRIGGERS_V4 = `
CREATE TRIGGER IF NOT EXISTS urls_count_insert AFTER INSERT ON urls WHEN NEW.domain IS NOT NULL BEGIN
  INSERT OR IGNORE INTO domains (domain, first_seen) VALUES (NEW.domain, NEW.discovered_at);
  INSERT OR IGNORE INTO hosts (host) VALUES (NEW.host);
  UPDATE hosts SET urls = urls + 1 WHERE host = NEW.host;
  UPDATE domains SET urls = urls + 1, pending = pending + (NEW.state='PENDING'), pending_demand = pending_demand + (NEW.state='PENDING' AND NEW.queue='DEMAND'),
    in_flight = in_flight + (NEW.state='IN_FLIGHT'), done = done + (NEW.state='DONE'), failed = failed + (NEW.state='FAILED') WHERE domain = NEW.domain;
  UPDATE states SET n = n + 1 WHERE state IN (NEW.state, 'URLS');
  UPDATE states SET n = n + 1 WHERE state = 'PENDING_DEMAND' AND NEW.state='PENDING' AND NEW.queue='DEMAND';
END;
CREATE TRIGGER IF NOT EXISTS urls_count_update AFTER UPDATE OF state, queue ON urls WHEN NEW.domain IS NOT NULL AND (OLD.state <> NEW.state OR OLD.queue <> NEW.queue) BEGIN
  UPDATE domains SET pending = pending - (OLD.state='PENDING') + (NEW.state='PENDING'),
    pending_demand = pending_demand - (OLD.state='PENDING' AND OLD.queue='DEMAND') + (NEW.state='PENDING' AND NEW.queue='DEMAND'),
    in_flight = in_flight - (OLD.state='IN_FLIGHT') + (NEW.state='IN_FLIGHT'), done = done - (OLD.state='DONE') + (NEW.state='DONE'), failed = failed - (OLD.state='FAILED') + (NEW.state='FAILED')
    WHERE domain = NEW.domain;
  UPDATE states SET n = n - 1 WHERE state = OLD.state AND OLD.state <> NEW.state;
  UPDATE states SET n = n + 1 WHERE state = NEW.state AND OLD.state <> NEW.state;
  UPDATE states SET n = n - 1 WHERE state = 'PENDING_DEMAND' AND OLD.state='PENDING' AND OLD.queue='DEMAND';
  UPDATE states SET n = n + 1 WHERE state = 'PENDING_DEMAND' AND NEW.state='PENDING' AND NEW.queue='DEMAND';
END;
CREATE TRIGGER IF NOT EXISTS documents_count_insert AFTER INSERT ON documents BEGIN
  UPDATE counts SET n = n + 1 WHERE k = 'documents'; UPDATE counts SET n = n + 1 WHERE k = 'duplicates' AND NEW.duplicate_of IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS documents_count_delete AFTER DELETE ON documents BEGIN
  UPDATE counts SET n = n - 1 WHERE k = 'documents'; UPDATE counts SET n = n - 1 WHERE k = 'duplicates' AND OLD.duplicate_of IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS documents_count_update AFTER UPDATE OF duplicate_of ON documents WHEN (OLD.duplicate_of IS NULL) <> (NEW.duplicate_of IS NULL) BEGIN
  UPDATE counts SET n = n + (NEW.duplicate_of IS NOT NULL) - (OLD.duplicate_of IS NOT NULL) WHERE k = 'duplicates';
END;
CREATE TRIGGER IF NOT EXISTS docs_index_count_insert AFTER INSERT ON docs_index BEGIN UPDATE counts SET n = n + 1 WHERE k = 'indexed'; END;
CREATE TRIGGER IF NOT EXISTS docs_index_count_delete AFTER DELETE ON docs_index BEGIN UPDATE counts SET n = n - 1 WHERE k = 'indexed'; END;
CREATE TRIGGER IF NOT EXISTS links_count_insert AFTER INSERT ON links BEGIN UPDATE counts SET n = n + 1 WHERE k = 'links'; END;
CREATE TRIGGER IF NOT EXISTS links_count_delete AFTER DELETE ON links BEGIN UPDATE counts SET n = n - 1 WHERE k = 'links'; END;
CREATE TRIGGER IF NOT EXISTS urls_count_delete AFTER DELETE ON urls WHEN OLD.domain IS NOT NULL BEGIN
  UPDATE hosts SET urls = urls - 1 WHERE host = OLD.host;
  UPDATE domains SET urls = urls - 1, pending = pending - (OLD.state='PENDING'), pending_demand = pending_demand - (OLD.state='PENDING' AND OLD.queue='DEMAND'),
    in_flight = in_flight - (OLD.state='IN_FLIGHT'), done = done - (OLD.state='DONE'), failed = failed - (OLD.state='FAILED') WHERE domain = OLD.domain;
  UPDATE states SET n = n - 1 WHERE state IN (OLD.state, 'URLS');
  UPDATE states SET n = n - 1 WHERE state = 'PENDING_DEMAND' AND OLD.state='PENDING' AND OLD.queue='DEMAND';
END;
`;
const COLUMNS_V4: Array<[table: string, column: string, ddl: string]> = [
  ['urls', 'domain', 'TEXT'], ['urls', 'source', `TEXT NOT NULL DEFAULT 'discovered'`], ['urls', 'external', 'INTEGER NOT NULL DEFAULT 0'],
  ['hosts', 'urls', 'INTEGER NOT NULL DEFAULT 0'], ['documents', 'low_value', 'INTEGER NOT NULL DEFAULT 0'],
];

/** Recomputes every counter from the `urls` table. Cheap enough to run in a migration or a test, never needed in normal operation (the triggers keep them exact). */
export function rebuildCounters(db: DatabaseSync, familyOf: (domain: string) => string = d => d): void {
  db.exec(`UPDATE domains SET pending=0, pending_demand=0, in_flight=0, done=0, failed=0, urls=0; UPDATE hosts SET urls=0; UPDATE states SET n=0;`);
  db.exec(`INSERT OR IGNORE INTO domains (domain, first_seen) SELECT domain, MIN(discovered_at) FROM urls WHERE domain IS NOT NULL GROUP BY domain;
    INSERT OR IGNORE INTO hosts (host) SELECT DISTINCT host FROM urls;
    UPDATE hosts SET urls = (SELECT COUNT(*) FROM urls u WHERE u.host = hosts.host);
    UPDATE domains SET urls=c.n, pending=c.p, pending_demand=c.pd, in_flight=c.i, done=c.d, failed=c.f FROM
      (SELECT domain, COUNT(*) AS n, SUM(state='PENDING') AS p, SUM(state='PENDING' AND queue='DEMAND') AS pd, SUM(state='IN_FLIGHT') AS i, SUM(state='DONE') AS d, SUM(state='FAILED') AS f FROM urls WHERE domain IS NOT NULL GROUP BY domain) AS c
      WHERE domains.domain = c.domain;
    UPDATE states SET n = (SELECT COUNT(*) FROM urls WHERE state = states.state) WHERE state IN ('PENDING','IN_FLIGHT','DONE','BLOCKED','FAILED');
    UPDATE states SET n = (SELECT COUNT(*) FROM urls) WHERE state='URLS';
    UPDATE states SET n = (SELECT COUNT(*) FROM urls WHERE state='PENDING' AND queue='DEMAND') WHERE state='PENDING_DEMAND';
    UPDATE counts SET n = CASE k WHEN 'documents' THEN (SELECT COUNT(*) FROM documents) WHEN 'duplicates' THEN (SELECT COUNT(*) FROM documents WHERE duplicate_of IS NOT NULL)
      WHEN 'indexed' THEN (SELECT COUNT(*) FROM docs_index) WHEN 'links' THEN (SELECT COUNT(*) FROM links) ELSE n END;`);
  for (const row of db.prepare(`SELECT domain FROM domains WHERE family=''`).all() as Array<{ domain: string }>) db.prepare('UPDATE domains SET family=? WHERE domain=?').run(familyOf(row.domain), row.domain);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(row => row.name === column);
}

export function initSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(TABLES);
  for (const [table, column, ddl] of COLUMNS) if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  db.exec(TABLES_V2);
  db.exec(`CREATE INDEX IF NOT EXISTS documents_canonical ON documents(canonical_key); CREATE INDEX IF NOT EXISTS documents_host ON documents(host);
    -- Counting duplicates, and the demand planner's "how many queries scheduled crawling this hour", must not read every stored page or ledger row.
    CREATE INDEX IF NOT EXISTS documents_duplicate ON documents(duplicate_of) WHERE duplicate_of IS NOT NULL;
    CREATE INDEX IF NOT EXISTS queries_last_crawl ON queries(last_crawl_at);
    CREATE INDEX IF NOT EXISTS queries_last_seen ON queries(last_seen);
    CREATE INDEX IF NOT EXISTS urls_pending_demand ON urls(priority, next_at) WHERE state='PENDING' AND queue='DEMAND';`);
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version >= 4) {
    db.exec(TABLES_V4); db.exec(TRIGGERS_V4);
    // Rows written by an older version after a rollback have no domain (their trigger-less inserts are invisible to the counters): adopt them.
    if (db.prepare('SELECT 1 FROM urls WHERE domain IS NULL LIMIT 1').get() !== undefined) migrateV4(db);
  }
  if (version < SCHEMA_VERSION) {
    // Backfill what the new columns can be derived from, once, for rows written by an older version.
    for (const row of db.prepare('SELECT url_key, url FROM documents WHERE host IS NULL').all() as Array<{ url_key: string; url: string }>) {
      let host = ''; try { host = new URL(row.url).hostname; } catch { /* leave empty */ }
      db.prepare('UPDATE documents SET host=?, first_seen_at=COALESCE(first_seen_at, fetched_at), last_changed_at=COALESCE(last_changed_at, fetched_at) WHERE url_key=?').run(host, row.url_key);
    }
    if (version < 3) {
      // Map every existing full-text row to its page (keeping its rowid), dropping any stale second row for the same page.
      db.exec('DELETE FROM docs_fts WHERE rowid NOT IN (SELECT MIN(rowid) FROM docs_fts GROUP BY url_key)');
      db.exec('INSERT OR IGNORE INTO docs_index (id, url_key) SELECT rowid, url_key FROM docs_fts');
    }
    if (version < 4) migrateV4(db); // creates the v4 structures, backfills, installs the triggers and sets user_version=4, all in one transaction
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  }
}

/**
 * One transaction: either every v4 structure, the backfill, the triggers and the version bump exist, or the database is exactly as it was (still version 3, still usable
 * by 0.4.1). Also used to adopt rows with no domain (written by an older version after a rollback): those rows, and only those, get a domain and an inferred source.
 */
function migrateV4(db: DatabaseSync): void {
  inTransaction(db, () => {
    for (const [table, column, ddl] of COLUMNS_V4) if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    db.exec(TABLES_V4);
    // source is INFERRED for rows that have none (written by an older version): demand queue -> demand, depth 0 -> seed, the rest discovered. Rows that already carry
    // a domain were written by this version and keep their real source (redirect, sitemap, provider, ...).
    db.exec(`UPDATE urls SET source = CASE WHEN queue='DEMAND' THEN 'demand' WHEN depth=0 THEN 'seed' ELSE 'discovered' END WHERE domain IS NULL`);
    // domain: one UPDATE per distinct host (urls_host is indexed), not per row.
    for (const { host } of db.prepare('SELECT DISTINCT host FROM urls WHERE domain IS NULL').all() as Array<{ host: string }>) db.prepare('UPDATE urls SET domain=? WHERE host=? AND domain IS NULL').run(registrableDomain(host), host);
    rebuildCounters(db);
    db.exec(TRIGGERS_V4);
    db.exec('PRAGMA user_version=4');
  });
}

let savepoints = 0;
/**
 * Runs `work` atomically. Outside a transaction it takes the write lock up front (BEGIN IMMEDIATE); inside one (a caller grouping several steps)
 * it uses a savepoint, so the same code is correct on its own and as part of a larger unit.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) {
    const name = `sp${savepoints++}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = work(); db.exec(`RELEASE ${name}`); return result; } catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
  }
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Opens (creating the directory if needed) and migrates the database file. `:memory:` is allowed for tests. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path); initSchema(db); return db;
}

/** The URL key of a canonical or link target, or undefined when the URL is not admissible. Used for the canonical and link tables. */
export { urlKey };
