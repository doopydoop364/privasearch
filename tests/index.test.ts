import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../src/db.js';
import { DocumentStore } from '../src/documents.js';
import type { DocumentInput } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { parseCrawlUrl, urlKey } from '../src/url.js';

const sha = (n: number) => n.toString(16).padStart(64, '0');
const doc = (url: string, title: string, text: string, hash: number, extra: Partial<DocumentInput> = {}): DocumentInput =>
  ({ urlKey: urlKey(url), url, finalUrl: url, title, description: '', canonicalUrl: null, language: 'en', text, contentSha256: sha(hash), fetchedAt: 1_000, httpStatus: 200, ...extra });
const norm = (url: string) => { const p = parseCrawlUrl(url); assert.ok(p.ok, url); return p.url; };

test('changed original promotes its old hash copies while preserving explicit canonical aliases', () => {
  const db = openDatabase(':memory:'); const s = new DocumentStore(db);
  try {
    const original = 'https://a.example/'; const mirror = 'https://b.example/'; const mirror2 = 'https://c.example/';
    s.upsert(doc(original, 'Original', 'lighthouse history', 1));
    s.upsert(doc(mirror, 'Mirror', 'lighthouse history', 1));
    s.upsert(doc(mirror2, 'Mirror two', 'lighthouse history', 1));
    s.upsert(doc('https://a.example/alias', 'Alias', 'canonical alias', 2, { canonicalUrl: original }));
    s.upsert(doc(original, 'Changed', 'harbour replacement', 3));
    assert.equal(s.search('lighthouse').length, 1);
    assert.equal(s.search('harbour').length, 1);
    assert.equal(s.search('canonical').length, 0);
    assert.deepEqual(s.count(), { documents: 4, indexed: 2, duplicates: 2 });
    // The promoted group remains recoverable when its new representative goes away.
    s.remove(urlKey(s.search('lighthouse')[0]!.url));
    assert.equal(s.search('lighthouse').length, 1);
  } finally { db.close(); }
});

test('the index and the frontier survive a restart: same file, new process state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privasearch-idx-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'var', 'privasearch.sqlite');
  let db = openDatabase(path); let documents = new DocumentStore(db); let frontier = new Frontier(db);
  documents.upsert(doc('https://a.example/1', 'Persistent page', 'text that must survive', 1));
  documents.setLinks(urlKey('https://a.example/1'), 'a.example', [{ key: urlKey('https://b.example/'), url: 'https://b.example/', host: 'b.example' }]);
  frontier.add('https://pending.example/x', { queue: 'PUBLIC', priority: 7 }, 5);
  db.close();
  db = openDatabase(path); documents = new DocumentStore(db); frontier = new Frontier(db);
  assert.deepEqual(documents.search('survive').map(h => h.url), ['https://a.example/1']);
  assert.equal(documents.linkCount(), 1);
  assert.deepEqual([frontier.getByUrl('https://pending.example/x')?.state, frontier.getByUrl('https://pending.example/x')?.priority], ['PENDING', 7]);
  db.close();
});

test('a database written by 0.3.2 is migrated in place: rows kept, new columns backfilled, new tables present', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privasearch-mig-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE documents (url_key TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, canonical_url TEXT, language TEXT, text TEXT NOT NULL, content_sha256 TEXT NOT NULL, fetched_at INTEGER NOT NULL, http_status INTEGER NOT NULL, duplicate_of TEXT) STRICT;
    CREATE VIRTUAL TABLE docs_fts USING fts5(url_key UNINDEXED, title, description, text, tokenize='unicode61 remove_diacritics 2');
    CREATE TABLE urls (url_key TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL, queue TEXT NOT NULL CHECK (queue IN ('DEMAND','PUBLIC')), priority INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK (state IN ('PENDING','IN_FLIGHT','DONE','BLOCKED','FAILED')), generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0, discovered_at INTEGER NOT NULL, last_outcome TEXT, last_http INTEGER, etag TEXT, last_modified TEXT, content_sha256 TEXT, fetched_at INTEGER, leased_at INTEGER) STRICT;
    CREATE TABLE hosts (host TEXT PRIMARY KEY, next_allowed_at INTEGER NOT NULL DEFAULT 0, backoff_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0) STRICT;`);
  const key = urlKey('https://old.example/page');
  old.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(key, 'https://old.example/page', 'https://old.example/page', 'Old page', '', null, 'en', 'legacy words', sha(9), 777, 200, null);
  old.prepare('INSERT INTO docs_fts (url_key,title,description,text) VALUES (?,?,?,?)').run(key, 'Old page', '', 'legacy words');
  old.prepare(`INSERT INTO urls (url_key,url,host,queue,state,next_at,discovered_at,content_sha256) VALUES (?,?,?,?,?,?,?,?)`).run(key, 'https://old.example/page', 'old.example', 'PUBLIC', 'DONE', 5, 1, sha(9));
  old.close();

  const db = openDatabase(path); const documents = new DocumentStore(db); const frontier = new Frontier(db);
  assert.equal(Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
  assert.deepEqual(documents.search('legacy').map(h => h.title), ['Old page']);
  const row = db.prepare('SELECT host, first_seen_at, last_changed_at, change_count FROM documents WHERE url_key=?').get(key) as { host: string; first_seen_at: number; last_changed_at: number; change_count: number };
  assert.deepEqual([row.host, row.first_seen_at, row.last_changed_at, row.change_count], ['old.example', 777, 777, 0]);
  assert.equal(frontier.get(key)?.interval_ms, null); assert.equal(frontier.get(key)?.change_count, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('links','queries')`).get() as { n: number }).n, 2);
  assert.doesNotThrow(() => { openDatabase(path).close(); }); // opening again is a no-op
  db.close();
});

test('URL variants collapse to one entry: tracking parameters, fragments, case, escapes and a trailing dot; meaningful parameters are kept', () => {
  assert.equal(norm('HTTPS://Example.COM./a/%7Efoo?utm_source=x&id=7#top'), 'https://example.com/a/~foo?id=7');
  assert.equal(norm('https://example.com/a/~foo?id=7&fbclid=abc'), 'https://example.com/a/~foo?id=7');
  assert.notEqual(norm('https://example.com/a?id=7'), norm('https://example.com/a?id=8')); // a parameter that selects a resource is not removed
  assert.equal(norm('https://example.com'), norm('https://example.com/'));
  const f = new Frontier(openDatabase(':memory:'));
  assert.equal(f.add('https://example.com/a?utm_campaign=1', { queue: 'PUBLIC' }, 1), 'ADDED');
  assert.equal(f.add('https://EXAMPLE.com/a#frag', { queue: 'PUBLIC' }, 1), 'EXISTS');
  assert.equal(f.stats().PENDING, 1);
});

test('a page that names another page as canonical is a duplicate of it, whichever arrives first, and never leaves a pair with no original', () => {
  const s = new DocumentStore(openDatabase(':memory:'));
  // the variant arrives first, naming the canonical page, which is not known yet: indexed
  s.upsert(doc('https://c.example/p?ref=1', 'Variant', 'shared words', 1, { canonicalUrl: 'https://c.example/p' }));
  assert.deepEqual(s.search('shared').map(h => h.url), ['https://c.example/p?ref=1']);
  // the canonical page arrives (different bytes): the variant stops being a separate result
  const result = s.upsert(doc('https://c.example/p', 'Canonical', 'shared words plus', 2));
  assert.equal(result.duplicateOf, undefined);
  assert.deepEqual(s.search('shared').map(h => h.url), ['https://c.example/p']);
  assert.deepEqual(s.count(), { documents: 2, indexed: 1, duplicates: 1 });
  // the other order: canonical known first
  const t = new DocumentStore(openDatabase(':memory:'));
  t.upsert(doc('https://c.example/q', 'Canonical', 'other words', 3));
  assert.equal(t.upsert(doc('https://c.example/q?x=1', 'Variant', 'other words here', 4, { canonicalUrl: 'https://c.example/q' })).duplicateOf, urlKey('https://c.example/q'));
  // two pages naming each other: the first one stays the original, the pair is never both hidden
  const u = new DocumentStore(openDatabase(':memory:'));
  u.upsert(doc('https://c.example/a', 'A', 'mutual words', 5, { canonicalUrl: 'https://c.example/b' }));
  u.upsert(doc('https://c.example/b', 'B', 'mutual words too', 6, { canonicalUrl: 'https://c.example/a' }));
  assert.equal(u.count().indexed >= 1, true);
});

test('change tracking: the first fetch, an unchanged refetch, and a changed refetch are told apart', () => {
  const s = new DocumentStore(openDatabase(':memory:'));
  const first = s.upsert(doc('https://t.example/', 'T', 'v1', 1, { fetchedAt: 100 })); assert.deepEqual([first.firstSeen, first.changed], [true, true]);
  const same = s.upsert(doc('https://t.example/', 'T', 'v1', 1, { fetchedAt: 200 })); assert.deepEqual([same.firstSeen, same.changed], [false, false]);
  assert.deepEqual([s.get(urlKey('https://t.example/'))?.fetchedAt, s.get(urlKey('https://t.example/'))?.lastChangedAt, s.get(urlKey('https://t.example/'))?.changeCount], [200, 100, 0]);
  const changed = s.upsert(doc('https://t.example/', 'T', 'v2 new words', 2, { fetchedAt: 300 })); assert.equal(changed.changed, true);
  assert.deepEqual([s.get(urlKey('https://t.example/'))?.lastChangedAt, s.get(urlKey('https://t.example/'))?.changeCount], [300, 1]);
  assert.deepEqual(s.search('words').map(h => h.url), ['https://t.example/']); // the index follows the update
});

test('link graph: replaced on refetch, counted per distinct OTHER host, and removed with the page', () => {
  const s = new DocumentStore(openDatabase(':memory:'));
  const target = urlKey('https://t.example/x'); const link = { key: target, url: 'https://t.example/x', host: 't.example' };
  s.setLinks(urlKey('https://a.example/'), 'a.example', [link, link]);
  s.setLinks(urlKey('https://a.example/2'), 'a.example', [link]);
  s.setLinks(urlKey('https://b.example/'), 'b.example', [link]);
  s.setLinks(urlKey('https://t.example/y'), 't.example', [link]); // a site linking to itself says nothing
  assert.equal(s.inboundHosts([target]).get(target), 2);
  s.setLinks(urlKey('https://b.example/'), 'b.example', []); assert.equal(s.inboundHosts([target]).get(target), 1);
  s.upsert(doc('https://a.example/', 'A', 'a', 1)); s.remove(urlKey('https://a.example/')); assert.equal(s.outlinks(urlKey('https://a.example/')).length, 0);
});

test('replacing a page replaces its full-text row, including for rows migrated from 0.3.x; a stale duplicate row from an old database is dropped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'privasearch-mig3-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'v2.sqlite');
  const db0 = openDatabase(path); // then rewound to look like a 0.4.0 database: no docs_index yet
  const key = urlKey('https://old.example/page');
  db0.exec('DROP TABLE docs_index'); db0.exec('PRAGMA user_version=2');
  db0.prepare('INSERT INTO documents (url_key,url,final_url,title,description,text,content_sha256,fetched_at,http_status,host) VALUES (?,?,?,?,?,?,?,?,?,?)').run(key, 'https://old.example/page', 'https://old.example/page', 'Old', '', 'alpha words', sha(1), 1, 200, 'old.example');
  db0.prepare('INSERT INTO docs_fts (url_key,title,description,text) VALUES (?,?,?,?)').run(key, 'Old', '', 'alpha words');
  db0.prepare('INSERT INTO docs_fts (url_key,title,description,text) VALUES (?,?,?,?)').run(key, 'Old', '', 'stale words'); // 0.4.0 could leave this behind
  db0.close();
  const db = openDatabase(path); const documents = new DocumentStore(db);
  assert.equal(documents.count().indexed, 1, 'the stale row is gone and the page is indexed once');
  documents.upsert(doc('https://old.example/page', 'New', 'omega words', 2));
  assert.deepEqual([documents.search('alpha').length, documents.search('stale').length, documents.search('omega').map(h => h.title)], [0, 0, ['New']]);
  assert.equal(documents.count().indexed, 1);
  documents.remove(key); assert.deepEqual([documents.count().indexed, documents.search('omega').length], [0, 0]);
  db.close();
});

test('an upsert is atomic: if indexing it fails, nothing of it is kept, and the same holds inside a caller\'s transaction', () => {
  const db = openDatabase(':memory:'); const documents = new DocumentStore(db);
  documents.upsert(doc('https://a.example/1', 'First', 'kept words', 1));
  db.exec(`CREATE TRIGGER fail_index BEFORE INSERT ON docs_index BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  assert.throws(() => documents.upsert(doc('https://a.example/2', 'Second', 'lost words', 2)), /disk full/);
  assert.deepEqual([documents.get(urlKey('https://a.example/2')), documents.count().documents, documents.count().indexed], [undefined, 1, 1]);
  db.exec('DROP TRIGGER fail_index');
  db.exec('BEGIN'); documents.upsert(doc('https://a.example/3', 'Third', 'rolled words', 3)); assert.equal(documents.search('rolled').length, 1); db.exec('ROLLBACK');
  assert.deepEqual([documents.search('rolled').length, documents.count().documents], [0, 1]);
  db.close();
});

test('ingest cost does not grow with the size of the index (the full-text row used to be found by scanning every row)', () => {
  const db = openDatabase(':memory:'); const documents = new DocumentStore(db);
  const words = Array.from({ length: 800 }, (_, i) => `w${i.toString(36)}`); let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  // Small pages and many of them, so the cost of the scan (one visit per stored page, for every page ingested) dominates the cost of indexing one page.
  const page = (i: number) => { const text = Array.from({ length: 20 }, () => words[Math.floor(rnd() * words.length)]).join(' '); documents.upsert(doc(`https://h${i % 50}.example/p/${i}`, `Page ${i}`, text, i + 1)); };
  const timeBatch = (from: number, count: number) => { const start = process.hrtime.bigint(); for (let i = from; i < from + count; i++) page(i); return Number(process.hrtime.bigint() - start) / 1e6 / count; };
  timeBatch(0, 50); const early = timeBatch(50, 200); timeBatch(250, 7500); const late = timeBatch(7750, 200);
  assert.ok(late < early * 4 + 0.5, `per-page ingest went from ${early.toFixed(3)} ms to ${late.toFixed(3)} ms as the index grew from 250 to 7,950 pages`);
  db.close();
});

test('candidates() returns the same pages in the same order as joining every match first (ranking happens before the join, not instead of it)', () => {
  const db = openDatabase(':memory:'); const documents = new DocumentStore(db);
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']; let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = (n: number) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  for (let i = 0; i < 300; i++) documents.upsert(doc(`https://h${i % 7}.example/p/${i}`, pick(3), pick(40), i % 20 === 0 ? 1 : i + 2)); // every 20th page has identical content: a duplicate, not indexed
  const reference = (match: string, limit: number) => (db.prepare(`SELECT d.url_key AS urlKey FROM docs_fts JOIN documents d ON d.url_key = docs_fts.url_key WHERE docs_fts MATCH ? AND d.duplicate_of IS NULL
    ORDER BY bm25(docs_fts, 0.0, 5.0, 2.0, 1.0), d.url_key LIMIT ?`).all(match, limit) as Array<{ urlKey: string }>).map(r => r.urlKey);
  for (const [query, mode] of [['alpha', 'AND'], ['alpha beta', 'AND'], ['alpha beta gamma', 'OR'], ['zeta theta', 'AND'], ['nomatchword', 'AND']] as const) {
    for (const limit of [1, 7, 50, 500]) {
      const match = query.split(' ').map(w => `"${w}"`).join(mode === 'AND' ? ' ' : ' OR ');
      assert.deepEqual(documents.candidates(query, mode, limit).map(c => c.urlKey), reference(match, limit), `${query} (${mode}), limit ${limit}`);
    }
  }
  const counts = documents.count(); assert.deepEqual([counts.documents, counts.duplicates, counts.indexed, documents.indexedCount()], [300, 14, 286, 286]);
  db.close();
});

test('the frontier and the ledger answer the planner\'s per-search questions from indexes, not by scanning', () => {
  const db = openDatabase(':memory:'); const frontier = new Frontier(db);
  for (let i = 0; i < 20; i++) frontier.add(`https://d${i}.example/`, { queue: i % 2 ? 'DEMAND' : 'PUBLIC', priority: 100 }, 1);
  assert.equal(frontier.pendingDemand(), 10);
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(r => r.detail).join('; ');
  assert.match(plan(`SELECT COUNT(*) FROM queries WHERE last_crawl_at > 5`), /USING (COVERING )?INDEX queries_last_crawl/);
  assert.match(plan(`SELECT COUNT(*) FROM documents WHERE duplicate_of IS NOT NULL`), /USING COVERING INDEX documents_duplicate/);
  assert.match(plan(`SELECT COUNT(*) FROM urls INDEXED BY urls_pending_demand WHERE state='PENDING' AND queue='DEMAND'`), /urls_pending_demand/);
  db.close();
});
