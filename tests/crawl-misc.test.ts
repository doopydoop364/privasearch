import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase, rebuildCounters } from '../src/db.js';
import { DocumentStore } from '../src/documents.js';
import type { DocumentInput } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { outcomeResult, pageResult } from '../src/privanet/fake-transport.js';
import { urlKey } from '../src/url.js';
import { rig } from './helpers.js';

const never = () => { throw new Error('no fetch expected'); };
let n = 0;
const doc = (url: string, over: Partial<DocumentInput> = {}): DocumentInput => ({ urlKey: urlKey(url), url, finalUrl: url, title: `t ${url}`, description: '', canonicalUrl: null, language: 'en', text: `body ${url} ${++n}`, contentSha256: (++n).toString(16).padStart(64, '0'), fetchedAt: 1_000, httpStatus: 200, ...over });
const HOUR = 3600000;

test('a page someone asks about again is refreshed, but only once per cooldown', () => {
  const r = rig(never, { hostDelayMs: 0, recrawlMinMs: 6 * HOUR });
  r.frontier.add('https://a.example/p', { queue: 'PUBLIC', source: 'seed' }, r.time.now);
  const [l] = r.frontier.lease(r.time.now, 1); r.frontier.complete(l!.urlKey, pageResult(l!.url, r.time.now, { title: 't', text: 'x'.repeat(80) }), r.time.now);
  const nextAt = () => r.frontier.getByUrl('https://a.example/p')!.next_at; const original = nextAt(); assert.ok(original > r.time.now + 24 * HOUR);
  r.advance(HOUR); r.frontier.add('https://a.example/p', { queue: 'DEMAND', source: 'demand', priority: 100 }, r.time.now); assert.equal(nextAt(), original, 'asked within the cooldown: nothing changes');
  r.advance(7 * HOUR); r.frontier.add('https://a.example/p', { queue: 'DEMAND', source: 'demand', priority: 100 }, r.time.now); assert.equal(nextAt(), r.time.now, 'asked after the cooldown: due now');
  assert.equal(r.frontier.lease(r.time.now, 1).length, 1);
});

test('refreshes are spread over domains: a giant site with the oldest backlog does not take every refresh slot', () => {
  const r = rig(never, { hostDelayMs: 0, recrawlShare: 1, preferredLanguages: ['*'], domainConcurrency: 8, familyConcurrency: 8 });
  for (let i = 0; i < 30; i++) r.frontier.add(`https://h${i}.big.org/p`, { queue: 'PUBLIC', source: 'seed' }, r.time.now); r.frontier.add('https://small.net/p', { queue: 'PUBLIC', source: 'seed' }, r.time.now);
  for (const l of r.frontier.lease(r.time.now, 40)) r.frontier.complete(l.urlKey, pageResult(l.url, r.time.now, { title: 't', text: 'x'.repeat(60) }), r.time.now);
  r.db.prepare(`UPDATE urls SET next_at = ? WHERE host LIKE '%.big.org'`).run(r.time.now - 10 * HOUR); r.db.prepare(`UPDATE urls SET next_at = ? WHERE host = 'small.net'`).run(r.time.now - 1 * HOUR);
  const picked = r.frontier.lease(r.time.now + 1, 2).map(l => l.host); assert.ok(picked.includes('small.net'), `refreshed: ${picked.join()}`);
});

test('authority counts independent registrable domains: fifty subdomains of one site are one voice, and a site linking to itself says nothing', () => {
  const db = openDatabase(':memory:'); const store = new DocumentStore(db); const target = 'https://target.org/page'; store.upsert(doc(target));
  const link = (src: string) => { const url = `https://${src}/x`; store.upsert(doc(url)); store.setLinks(urlKey(url), src, [{ key: urlKey(target), url: target, host: 'target.org' }]); };
  for (let i = 0; i < 50; i++) link(`s${i}.farm.example`); assert.equal(store.inboundHosts([urlKey(target)]).get(urlKey(target)), 1);
  link('blog.one.org'); link('news.two.com'); link('www.target.org'); assert.equal(store.inboundHosts([urlKey(target)]).get(urlKey(target)), 3);
  link('alice.github.io'); link('bob.github.io'); assert.equal(store.inboundHosts([urlKey(target)]).get(urlKey(target)), 5); // platform subdomains are different sites
});

test('store counts (documents, duplicates, indexed, links) are exact after upserts, duplicates, canonical absorption, removal and link rewrites', () => {
  const db = openDatabase(':memory:'); const store = new DocumentStore(db);
  const exact = () => { const c = store.count(); const sql = (q: string) => Number((db.prepare(q).get() as { n: number }).n);
    assert.deepEqual([c.documents, c.duplicates, c.indexed, store.linkCount()], [sql('SELECT COUNT(*) AS n FROM documents'), sql('SELECT COUNT(*) AS n FROM documents WHERE duplicate_of IS NOT NULL'), sql('SELECT COUNT(*) AS n FROM docs_index'), sql('SELECT COUNT(*) AS n FROM links')]); return c; };
  store.upsert(doc('https://a.example/1', { contentSha256: 'a'.repeat(64) })); store.upsert(doc('https://a.example/2', { contentSha256: 'a'.repeat(64) })); // an exact duplicate
  store.upsert(doc('https://a.example/3', { canonicalUrl: 'https://a.example/1' })); store.setLinks(urlKey('https://a.example/1'), 'a.example', [{ key: 'k1', url: 'https://b.example/', host: 'b.example' }, { key: 'k2', url: 'https://c.example/', host: 'c.example' }]);
  assert.deepEqual(exact(), { documents: 3, indexed: 1, duplicates: 2 }); assert.equal(store.linkCount(), 2);
  store.setLinks(urlKey('https://a.example/1'), 'a.example', [{ key: 'k1', url: 'https://b.example/', host: 'b.example' }]); assert.equal(store.linkCount(), 1); exact();
  store.upsert(doc('https://a.example/2', { contentSha256: 'b'.repeat(64) })); exact(); // no longer a duplicate
  store.remove(urlKey('https://a.example/1')); exact(); rebuildCounters(db); exact();
});

test('canonical loops and chains do not lose pages or crash: of two pages naming each other, at least one stays findable', () => {
  const db = openDatabase(':memory:'); const store = new DocumentStore(db);
  store.upsert(doc('https://a.example/x', { canonicalUrl: 'https://a.example/y' })); store.upsert(doc('https://a.example/y', { canonicalUrl: 'https://a.example/x' }));
  assert.ok(store.count().indexed >= 1, 'a canonical loop must not de-index both pages');
  store.upsert(doc('https://a.example/p', { canonicalUrl: 'https://a.example/q' })); store.upsert(doc('https://a.example/q', { canonicalUrl: 'https://a.example/r' })); store.upsert(doc('https://a.example/r'));
  assert.ok(store.count().indexed >= 2); // a chain p -> q -> r keeps its end
  store.upsert(doc('https://a.example/self', { canonicalUrl: 'https://a.example/self' })); assert.ok(store.get(urlKey('https://a.example/self')));
  const f = new Frontier(db, {}); assert.equal(f.stats().PENDING, 0);
});

test('sitemap.txt (opt-in): probed once per host after three useful pages, only same-domain URLs are admitted, at most 100, judged like links, never indexed', async () => {
  const listing = ['https://site.example/a/1', 'https://site.example/a/2', 'https://other.example/steal', 'not a url', 'https://site.example/logo.png', 'https://site.example/calendar/2020/01/01', ...Array.from({ length: 150 }, (_, i) => `https://site.example/s/${i}`)].join('\n');
  const build = (sitemapTxt: boolean) => { const rg = rig((input: { url: string }) => input.url.endsWith('/sitemap.txt') ? pageResult(input.url, rg.time.now, { title: '', text: listing }) : pageResult(input.url, rg.time.now, { title: `page ${input.url}`, text: `distinct content of ${input.url} `.repeat(6) }), { hostDelayMs: 0 });
    const crawler = new (rg.crawler.constructor as new (o: object) => typeof rg.crawler)({ frontier: rg.frontier, documents: rg.documents, transport: rg.transport, clock: () => rg.time.now, batch: 4, ...(sitemapTxt ? { sitemapTxt: true } : {}) }); return { rg, crawler }; };
  const off = build(false); for (let i = 0; i < 5; i++) off.rg.frontier.add(`https://site.example/p${i}`, { queue: 'PUBLIC', source: 'seed' }, off.rg.time.now);
  for (let i = 0; i < 6; i++) { await off.crawler.runOnce(); off.rg.advance(10); } assert.equal(off.rg.frontier.getByUrl('https://site.example/sitemap.txt'), undefined, 'off by default');
  const { rg, crawler } = build(true); for (let i = 0; i < 5; i++) rg.frontier.add(`https://site.example/p${i}`, { queue: 'PUBLIC', source: 'seed' }, rg.time.now);
  for (let i = 0; i < 12; i++) { await crawler.runOnce(); rg.advance(10); }
  const sm = rg.frontier.getByUrl('https://site.example/sitemap.txt'); assert.ok(sm); assert.equal(sm.source, 'sitemap'); assert.equal(sm.state, 'DONE');
  assert.equal(rg.documents.get(sm.url_key), undefined, 'the sitemap is not a page');
  const fromSitemap = Number((rg.db.prepare(`SELECT COUNT(*) AS n FROM urls WHERE source='sitemap' AND url NOT LIKE '%sitemap.txt'`).get() as { n: number }).n);
  assert.ok(fromSitemap > 90 && fromSitemap <= 100, `admitted ${fromSitemap}`); assert.equal(rg.frontier.getByUrl('https://other.example/steal'), undefined); assert.equal(rg.frontier.getByUrl('https://site.example/logo.png'), undefined); assert.equal(rg.frontier.getByUrl('https://site.example/calendar/2020/01/01'), undefined);
  assert.equal(Number((rg.db.prepare(`SELECT COUNT(*) AS n FROM urls WHERE url LIKE '%sitemap.txt'`).get() as { n: number }).n), 1, 'asked once, ever');
  assert.equal(rg.frontier.getByUrl('https://site.example/a/1')?.source, 'sitemap');
});

test('a missing sitemap.txt is a guess that did not pay off: it does not count against the site', async () => {
  const rg = rig((input: { url: string }) => input.url.endsWith('/sitemap.txt') ? outcomeResult('HTTP_ERROR', input.url, rg.time.now, { httpStatus: 404 }) : pageResult(input.url, rg.time.now, { title: 't', text: `content ${input.url} `.repeat(8) }), { hostDelayMs: 0 });
  rg.frontier.add('https://site.example/sitemap.txt', { queue: 'PUBLIC', source: 'sitemap' }, rg.time.now); await rg.crawler.runOnce();
  assert.equal(Number((rg.db.prepare(`SELECT errors AS n FROM domains WHERE domain='site.example'`).get() as { n: number }).n), 0);
});
