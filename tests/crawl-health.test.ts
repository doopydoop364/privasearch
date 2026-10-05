import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Frontier } from '../src/frontier.js';
import { outcomeResult, pageResult } from '../src/privanet/fake-transport.js';
import { rig } from './helpers.js';
import { zeroYieldSimulation } from './sim/zero-yield.js';

const never = () => { throw new Error('unexpected fetch'); };

test('thousands of URLs on eight denied domains leave capacity for useful domains', async () => {
  const result = await zeroYieldSimulation(8, 'ROBOTS_DISALLOWED');
  assert.equal(result.attempts, 1800); assert.ok(result.wasted <= 120, JSON.stringify(result));
  assert.ok(result.useful >= 1680, JSON.stringify(result));
});

test('host failure backoff escalates across fresh sibling URLs, including demand', () => {
  const r = rig(never, { hostDelayMs: 0 });
  try {
    for (let i = 0; i < 5; i++) {
      r.frontier.add(`https://bad.test/${i}`, { queue: i % 2 ? 'DEMAND' : 'PUBLIC', priority: i }, r.time.now);
      const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l);
      r.frontier.complete(l.urlKey, outcomeResult('ROBOTS_UNAVAILABLE', l.url, r.time.now, { robots: { verdict: 'UNAVAILABLE' } }), r.time.now);
      r.frontier.add(`https://bad.test/next${i}`, { queue: 'DEMAND', priority: -10 }, r.time.now);
      r.advance(1000 * 2 ** i - 1); assert.equal(r.frontier.lease(r.time.now, 1).length, 0); r.advance(1);
    }
    assert.equal(r.frontier.operationalHealth(r.time.now).outcomes[0]?.outcome, 'ROBOTS_UNAVAILABLE');
  } finally { r.db.close(); }
});

test('demand robots failures exhaust attempts, retain Retry-After, and cannot be reset by searches', () => {
  const r = rig(never, { hostDelayMs: 0, maxAttempts: 5 }); const url = 'https://bad.test/query';
  try {
    r.frontier.add(url, { queue: 'DEMAND' }, r.time.now);
    for (let i = 0; i < 5; i++) {
      const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l);
      r.frontier.complete(l.urlKey, outcomeResult('ROBOTS_UNAVAILABLE', url, r.time.now, { robots: { verdict: 'UNAVAILABLE' }, httpStatus: 503, retryAfterSec: 60 }), r.time.now);
      const row = r.frontier.get(l.urlKey)!;
      r.frontier.add(url, { queue: 'DEMAND' }, r.time.now);
      assert.equal(r.frontier.get(l.urlKey)?.next_at, row.next_at); assert.equal(row.attempts, i + 1);
      r.advance(row.next_at - r.time.now);
    }
    assert.equal(r.frontier.getByUrl(url)?.state, 'FAILED');
    assert.equal(r.frontier.getByUrl(url)?.last_http, 503);
  } finally { r.db.close(); }
});

test('a zero-yield domain has one recovery probe, demand priority, and resets on useful recovery', () => {
  const r = rig(never, { hostDelayMs: 0, preferredLanguages: ['*'], domainConcurrency: 8 });
  try {
    for (let i = 0; i < 12; i++) r.frontier.add(`https://h${i}.bad.test/a`, { queue: 'PUBLIC' }, r.time.now);
    for (let i = 0; i < 8; i++) {
      const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l);
      r.frontier.complete(l.urlKey, outcomeResult('ROBOTS_DISALLOWED', l.url, r.time.now), r.time.now);
    }
    assert.equal(r.frontier.lease(r.time.now, 8).length, 0);
    r.frontier.add('https://asked.bad.test/a', { queue: 'DEMAND' }, r.time.now);
    const [asked] = r.frontier.lease(r.time.now, 8); assert.equal(asked?.queue, 'DEMAND'); assert.ok(asked);
    r.frontier.complete(asked.urlKey, pageResult(asked.url, r.time.now), r.time.now);
    r.frontier.recordPage(asked.urlKey, 'useful', r.time.now);
    assert.ok(r.frontier.lease(r.time.now, 8).length >= 2);
  } finally { r.db.close(); }
});

test('family concentration aggregates one operator across many domains and hosts', () => {
  const r = rig(never, { families: { operator: ['wiki.test', 'media.test', 'dictionary.test'] }, preferredLanguages: ['*'] });
  try {
    for (const domain of ['wiki.test', 'media.test', 'dictionary.test', 'independent.test']) for (let i = 0; i < 10; i++) r.frontier.add(`https://h${i}.${domain}/a`, { queue: 'PUBLIC' }, r.time.now);
    const c = r.frontier.concentration(r.time.now);
    assert.equal(c.pending.top1, 0.25); assert.equal(c.pending.effectiveDomains, 4);
    assert.equal(c.families.pending.top1, 0.75); assert.equal(c.families.pending.herfindahl, 0.625);
    assert.equal(c.families.pending.topDomain, 'operator');
  } finally { r.db.close(); }
});

test('retry age uses first failure rather than admission, and pre-upgrade ages stay unknown', () => {
  const r = rig(never, { hostDelayMs: 0 });
  try {
    r.frontier.add('https://old.test/a', { queue: 'DEMAND' }, r.time.now - 10 * 86400000);
    const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l);
    r.frontier.complete(l.urlKey, outcomeResult('ROBOTS_UNAVAILABLE', l.url, r.time.now), r.time.now);
    r.advance(2 * 3600000);
    let q = r.frontier.operationalHealth(r.time.now).queues[0]!;
    assert.equal(q.retryHourToDay, 1); assert.equal(q.retryOverDay, 0);
    r.db.prepare('DELETE FROM crawl_retries').run(); r.advance(60000);
    q = r.frontier.operationalHealth(r.time.now).queues[0]!;
    assert.equal(q.retryAgeUnknown, 1);
  } finally { r.db.close(); }
});

test('thin-page recrawls cannot manufacture eight new-page failures or prevent refreshing indexed pages', async () => {
  const r = rig(({ url }) => pageResult(url, r.time.now, { title: 'Short document', text: 'A short legitimate document.' }), { hostDelayMs: 0, recrawlMs: 1000, recrawlMinMs: 1000, recrawlMaxMs: 1000 });
  try {
    r.frontier.add('https://short.test/a', { queue: 'PUBLIC' }, r.time.now);
    for (let i = 0; i < 12; i++) { await r.crawler.runOnce(); r.advance(1000); }
    assert.equal(r.documents.count().indexed, 1);
    assert.equal(r.db.prepare('SELECT bad_streak FROM crawl_health').get()?.bad_streak, 1);
    assert.equal(r.transport.calls.length, 12);
  } finally { r.db.close(); }
});

test('sustained zero yield tightens discovered admission without rejecting explicit demand', () => {
  const r = rig(never, { hostDelayMs: 0 });
  try {
    for (let i = 0; i < 100; i++) r.frontier.add(`https://bad.test/${i}`, { queue: 'PUBLIC', source: 'discovered' }, r.time.now);
    for (let i = 0; i < 8; i++) {
      const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l);
      r.frontier.complete(l.urlKey, outcomeResult('ROBOTS_DISALLOWED', l.url, r.time.now), r.time.now);
    }
    assert.equal(r.frontier.add('https://bad.test/new', { queue: 'PUBLIC', source: 'discovered' }, r.time.now), 'DOMAIN_BUDGET');
    assert.equal(r.frontier.add('https://bad.test/asked', { queue: 'DEMAND' }, r.time.now), 'ADDED');
  } finally { r.db.close(); }
});

test('cooldown, outcome counters and lease generations survive reopening and rollback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-health-')); const path = join(dir, 'state.sqlite'); const now = 1000000;
  let db = openDatabase(path); let f = new Frontier(db, { hostDelayMs: 0, backoffBaseMs: 1000 });
  try {
    for (let i = 0; i < 10; i++) f.add(`https://h${i}.bad.test/a`, { queue: 'PUBLIC' }, now);
    for (let i = 0; i < 8; i++) { const [l] = f.lease(now, 1); assert.ok(l); f.complete(l.urlKey, outcomeResult('ROBOTS_DISALLOWED', l.url, now), now); }
    assert.throws(() => f.atomically(() => { f.recordPage(f.getByUrl('https://h0.bad.test/a')!.url_key, 'useful', now); throw Error('crash'); }));
    db.close(); db = openDatabase(path); f = new Frontier(db, { hostDelayMs: 0 });
    assert.equal(f.requeueAll(), 0); assert.equal(f.lease(now, 8).length, 0);
    const [probe] = f.lease(now + 1000, 8); assert.ok(probe); assert.equal(f.lease(now + 1000, 8).length, 0);
    const generation = probe.generation; db.close(); db = openDatabase(path); f = new Frontier(db, { hostDelayMs: 0 });
    assert.equal(f.requeueAll(), 1); assert.equal(f.get(probe.urlKey)?.generation, generation);
    assert.equal(f.operationalHealth(now).outcomes[0]?.n, 8);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
