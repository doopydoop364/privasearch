import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { analyzeFrontier } from '../src/analyze.js';
import { SCHEMA_VERSION, openDatabase, rebuildCounters } from '../src/db.js';
import { Frontier } from '../src/frontier.js';
import { pageResult } from '../src/privanet/fake-transport.js';
import { rig } from './helpers.js';

const never = () => { throw new Error('no fetch expected'); };
const FIXTURE = new URL('../../tests/fixtures/privasearch-0.4.1-schema3.sqlite.gz', import.meta.url);
function v3Copy(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'privasearch-v3-')); const path = join(dir, 'prod.sqlite'); writeFileSync(path, gunzipSync(readFileSync(FIXTURE))); return { dir, path };
}
const counters = (db: DatabaseSync) => ({
  domains: db.prepare('SELECT domain, pending, pending_demand, in_flight, done, failed, urls FROM domains ORDER BY domain').all(),
  states: db.prepare('SELECT state, n FROM states ORDER BY state').all(), hosts: db.prepare('SELECT host, urls FROM hosts ORDER BY host').all(),
});

test('migration from a real 0.4.1 (schema 3) database: read-only analysis first, then one-transaction upgrade that keeps every page and counts every URL', () => {
  const { dir, path } = v3Copy();
  try {
    const bytes = readFileSync(path); const mtime = statSync(path).mtimeMs;
    const before = analyzeFrontier(path); // read-only, works on schema 3
    assert.ok(before.pending.total > 1000); assert.equal(before.pending.topDomains[0]?.key, 'wiki.test'); assert.ok(before.pending.top1DomainShare > 0.9);
    assert.deepEqual(readFileSync(path), bytes); assert.equal(statSync(path).mtimeMs, mtime); // analyze did not touch the production file

    const old = new DatabaseSync(path); const docs = Number((old.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n); const indexed = Number((old.prepare('SELECT COUNT(*) AS n FROM docs_index').get() as { n: number }).n);
    const links = Number((old.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }).n); const queries = Number((old.prepare('SELECT COUNT(*) AS n FROM queries').get() as { n: number }).n);
    const urls = Number((old.prepare('SELECT COUNT(*) AS n FROM urls').get() as { n: number }).n); const demand = Number((old.prepare(`SELECT COUNT(*) AS n FROM urls WHERE queue='DEMAND'`).get() as { n: number }).n);
    assert.equal((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3); old.close();

    const db = openDatabase(path);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
    const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    assert.equal(n('SELECT COUNT(*) AS n FROM documents'), docs); assert.equal(n('SELECT COUNT(*) AS n FROM docs_index'), indexed); assert.equal(n('SELECT COUNT(*) AS n FROM links'), links);
    assert.equal(n('SELECT COUNT(*) AS n FROM queries'), queries); assert.equal(n('SELECT COUNT(*) AS n FROM urls'), urls);
    assert.equal(n('SELECT COUNT(*) AS n FROM urls WHERE domain IS NULL'), 0);
    assert.equal(n(`SELECT n FROM states WHERE state='URLS'`), urls); assert.equal(n(`SELECT n FROM states WHERE state='PENDING_DEMAND'`), n(`SELECT COUNT(*) AS n FROM urls WHERE state='PENDING' AND queue='DEMAND'`));
    assert.equal(n(`SELECT COUNT(*) AS n FROM urls WHERE source='demand'`), demand); assert.ok(n(`SELECT COUNT(*) AS n FROM urls WHERE source='seed'`) >= 1);
    assert.equal(n(`SELECT pending AS n FROM domains WHERE domain='wiki.test'`), n(`SELECT COUNT(*) AS n FROM urls WHERE domain='wiki.test' AND state='PENDING'`));
    const exact = counters(db); rebuildCounters(db); assert.deepEqual(counters(db), exact); // the migrated counters are the rebuilt counters
    // The upgraded database is a working frontier: it leases, completes, and keeps the counters exact.
    const frontier = new Frontier(db, { hostDelayMs: 0 }); const leased = frontier.lease(1_000_000_000_000, 4); assert.ok(leased.length > 0);
    for (const l of leased) frontier.complete(l.urlKey, pageResult(l.url, 1_000_000_000_000, { title: 't', text: 'x'.repeat(100) }), 1_000_000_000_000);
    const after = counters(db); rebuildCounters(db); assert.deepEqual(counters(db), after);
    db.close();
    openDatabase(path).close(); // opening again changes nothing and does not re-migrate
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed migration leaves the version 3 database exactly as it was (one transaction, nothing half-applied)', () => {
  const { dir, path } = v3Copy();
  try {
    const sabotage = new DatabaseSync(path); sabotage.exec('CREATE TABLE domains (x INTEGER)'); sabotage.close(); // an incompatible leftover: CREATE INDEX ... ON domains(vtime) fails in the middle of the migration
    assert.throws(() => openDatabase(path));
    const db = new DatabaseSync(path);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
    const columns = (db.prepare('PRAGMA table_info(urls)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(!columns.includes('domain') && !columns.includes('source'), 'the ALTERs were rolled back');
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name IN ('states','domain_links') OR name LIKE 'urls_count_%'`).get(), undefined);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rows written without a domain (an older version after a rollback) are adopted and keep real sources of the others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privasearch-adopt-')); const path = join(dir, 'p.sqlite');
  try {
    const db = openDatabase(path); const f = new Frontier(db, {});
    f.add('https://a.example/redirected', { queue: 'PUBLIC', depth: 2, source: 'redirect' }, 1);
    db.prepare(`INSERT INTO urls (url_key, url, host, queue, priority, state, next_at, depth, discovered_at) VALUES ('legacy','https://b.example/legacy','b.example','PUBLIC',5,'PENDING',1,0,1)`).run();
    db.close();
    const again = openDatabase(path);
    assert.equal((again.prepare(`SELECT domain FROM urls WHERE url_key='legacy'`).get() as { domain: string }).domain, 'b.example');
    assert.equal((again.prepare(`SELECT source FROM urls WHERE url='https://a.example/redirected'`).get() as { source: string }).source, 'redirect'); // not overwritten by the inference
    assert.equal(Number((again.prepare(`SELECT pending FROM domains WHERE domain='b.example'`).get() as { pending: number }).pending), 1);
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('trigger-maintained counters equal a full recount after random add, lease, complete, fail, release and a rolled-back transaction', () => {
  const r = rig(never, { hostDelayMs: 0, maxUrlsPerHost: 100000, maxPendingPerDomain: 100000, maxPendingPerFamily: 100000, preferredLanguages: ['*'] });
  let seed = 12345; const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const hosts = ['a.example.com', 'b.example.com', 'x.test', 'y.example.org', 'blog.one.github.io', 'blog.two.github.io'];
  const check = () => { const live = counters(r.db); rebuildCounters(r.db); assert.deepEqual(counters(r.db), live); };
  for (let step = 0; step < 400; step++) {
    const op = rnd(10);
    if (op < 4) r.frontier.add(`https://${hosts[rnd(hosts.length)]}/p/${rnd(60)}`, { queue: rnd(5) === 0 ? 'DEMAND' : 'PUBLIC', priority: rnd(90), depth: rnd(3), source: rnd(2) ? 'discovered' : 'seed' }, r.time.now);
    else if (op < 6) r.frontier.lease(r.time.now, 1 + rnd(4));
    else if (op < 8) { const row = r.db.prepare(`SELECT url_key, url FROM urls WHERE state='IN_FLIGHT' LIMIT 1`).get() as { url_key: string; url: string } | undefined; if (row) r.frontier.complete(row.url_key, pageResult(row.url, r.time.now, { title: 't' }), r.time.now); }
    else if (op === 8) { const row = r.db.prepare(`SELECT url_key FROM urls WHERE state='IN_FLIGHT' LIMIT 1`).get() as { url_key: string } | undefined; if (row) { if (rnd(2)) r.frontier.fail(row.url_key, r.time.now, 'x'); else r.frontier.release(row.url_key, r.time.now, 10); } }
    else { try { r.frontier.atomically(() => { r.frontier.add(`https://${hosts[rnd(hosts.length)]}/rolled/${rnd(50)}`, { queue: 'PUBLIC', priority: 5 }, r.time.now); r.frontier.lease(r.time.now, 3); throw new Error('abort'); }); } catch { /* rolled back */ } }
    r.advance(1500);
    if (step % 40 === 0) check();
  }
  r.frontier.requeueAll(); check();
  r.db.prepare(`DELETE FROM urls WHERE state='DONE' AND url_key IN (SELECT url_key FROM urls LIMIT 20)`).run(); check();
});

test('a crash between a lease and its completion cannot leave counters wrong: a reopened database requeues, and the counters still match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privasearch-crash-')); const path = join(dir, 'p.sqlite');
  try {
    let db = openDatabase(path); let f = new Frontier(db, { hostDelayMs: 0 });
    for (let i = 0; i < 10; i++) f.add(`https://site${i}.org/`, { queue: 'PUBLIC', priority: 10 }, 1);
    assert.equal(f.lease(2, 6).length, 6); db.close(); // the process dies with six requests in flight
    db = openDatabase(path); f = new Frontier(db, { hostDelayMs: 0 });
    assert.equal(f.stats().IN_FLIGHT, 6); assert.equal(f.requeueAll(), 6); assert.equal(f.stats().PENDING, 10); assert.equal(f.stats().IN_FLIGHT, 0);
    const live = counters(db); rebuildCounters(db); assert.deepEqual(counters(db), live); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

