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
