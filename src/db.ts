import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { urlKey } from './url.js';

/**
 * The one SQLite database behind PrivaSearch: frontier, hosts, documents, the full-text index, the link graph and the
 * demand-crawl query ledger. `initSchema` is idempotent and migrates a database created by an older version in place, so every
 * component can call it from its constructor and an upgrade never needs a manual step.
 *
 * Schema version 2 (0.4.0) adds: documents.{canonical_key, host, first_seen_at, last_changed_at, change_count}, the `links` table,
 * urls.{interval_ms, change_count, unchanged_streak, last_changed_at}, the `queries` table and a small `meta` table (a per-install salt for query hashes).
 */
export const SCHEMA_VERSION = 2;

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

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(row => row.name === column);
}

export function initSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(TABLES);
  for (const [table, column, ddl] of COLUMNS) if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  db.exec(TABLES_V2);
  db.exec('CREATE INDEX IF NOT EXISTS documents_canonical ON documents(canonical_key); CREATE INDEX IF NOT EXISTS documents_host ON documents(host);');
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version < SCHEMA_VERSION) {
    // Backfill what the new columns can be derived from, once, for rows written by an older version.
    for (const row of db.prepare('SELECT url_key, url FROM documents WHERE host IS NULL').all() as Array<{ url_key: string; url: string }>) {
      let host = ''; try { host = new URL(row.url).hostname; } catch { /* leave empty */ }
      db.prepare('UPDATE documents SET host=?, first_seen_at=COALESCE(first_seen_at, fetched_at), last_changed_at=COALESCE(last_changed_at, fetched_at) WHERE url_key=?').run(host, row.url_key);
    }
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  }
}

/** Opens (creating the directory if needed) and migrates the database file. `:memory:` is allowed for tests. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path); initSchema(db); return db;
}

/** The URL key of a canonical or link target, or undefined when the URL is not admissible. Used for the canonical and link tables. */
export { urlKey };
