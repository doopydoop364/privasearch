import test from 'node:test';
import assert from 'node:assert/strict';
import { DemandPlanner } from '../src/demand.js';
import { expandTemplate } from '../src/discovery.js';
import { openDatabase } from '../src/db.js';
import { DocumentStore } from '../src/documents.js';
import type { DocumentInput } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { Searcher } from '../src/ranking.js';
import { urlKey } from '../src/url.js';

const MIN = 60000; const HOUR = 3600000;
let n = 0;
const doc = (url: string, title: string, text: string): DocumentInput =>
  ({ urlKey: urlKey(url), url, finalUrl: url, title, description: '', canonicalUrl: null, language: 'en', text, contentSha256: (++n).toString(16).padStart(64, '0'), fetchedAt: 1_000, httpStatus: 200 });

function rig(options: ConstructorParameters<typeof DemandPlanner>[3] = {}) {
  const db = openDatabase(':memory:'); const time = { now: 10_000_000 };
  const documents = new DocumentStore(db); const frontier = new Frontier(db, { hostDelayMs: 0 });
  const planner = new DemandPlanner(db, frontier, documents, { clock: () => time.now, templates: ['https://wiki.example/wiki/{title}'], ...options });
  const searcher = new Searcher(documents, () => time.now);
  /** A search as the API performs it: rank, then let the planner look at the first page. */
  const search = (q: string) => { const result = searcher.search(q); return { result, crawl: planner.consider(q, result) }; };
  return { db, time, documents, frontier, planner, searcher, search, advance(ms: number) { time.now += ms; } };
}
const demandUrls = (r: ReturnType<typeof rig>) => (r.db.prepare(`SELECT url FROM urls WHERE queue='DEMAND' AND state='PENDING' ORDER BY url`).all() as Array<{ url: string }>).map(x => x.url);

test('a query with no results schedules demand crawling from the configured templates, and says so', () => {
  const r = rig();
  const { result, crawl } = r.search('rust programming language');
  assert.deepEqual([result.total, crawl.triggered, crawl.state, crawl.candidates], [0, true, 'scheduled', 1]);
  assert.deepEqual(demandUrls(r), ['https://wiki.example/wiki/Rust_programming_language']);
  assert.equal(r.frontier.getByUrl('https://wiki.example/wiki/Rust_programming_language')?.priority, 100);
});

test('a query that already has enough strong results does not crawl anything', () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.documents.upsert(doc(`https://s${i}.example/p`, 'Sourdough starter guide', `How to keep a sourdough starter alive, part ${i}.`));
  const { result, crawl } = r.search('sourdough starter');
  assert.ok(result.strong >= 3, `expected 3 strong results, got ${result.strong}`);
  assert.deepEqual([crawl.triggered, crawl.state], [false, 'none']); assert.deepEqual(demandUrls(r), []);
});

test('weak means fewer than three STRONG results: two good pages, or partial matches only, still trigger', () => {
  const r = rig();
  r.documents.upsert(doc('https://a.example/1', 'Sourdough starter guide', 'sourdough starter basics'));
  r.documents.upsert(doc('https://b.example/1', 'Sourdough starter tips', 'sourdough starter tips'));
  assert.equal(r.search('sourdough starter').crawl.state, 'scheduled'); // two strong
  const p = rig(); p.documents.upsert(doc('https://c.example/1', 'Alpine flowers', 'flowers of the Alps'));
  const partial = p.search('alpine hiking routes'); assert.deepEqual([partial.result.total, partial.result.strong, partial.crawl.triggered], [1, 0, true]); // a partial match only
});

test('searching the same thing again does not cause a crawl storm: cooldown, order-insensitive, case-insensitive, and it doubles while the query stays weak', () => {
  const r = rig();
  assert.equal(r.search('rust language').crawl.state, 'scheduled');
  const queued = demandUrls(r).length;
  for (const q of ['rust language', 'Language RUST', 'rust   language!']) { const { crawl } = r.search(q); assert.deepEqual([crawl.triggered, crawl.state], [false, 'cooldown']); assert.ok((crawl.retryAfterSec ?? 0) > 0); }
  assert.equal(demandUrls(r).length, queued); // nothing added
  r.advance(29 * MIN); assert.equal(r.search('rust language').crawl.state, 'cooldown');
  r.advance(2 * MIN); // the first cooldown (30 minutes) is over, but the page is still waiting in the demand queue: in progress, nothing new started
  const again = r.search('rust language').crawl; assert.deepEqual([again.triggered, again.state, again.candidates], [false, 'scheduled', 1]);
  r.advance(10 * MIN); assert.equal(r.search('rust language').crawl.state, 'cooldown'); // and the lookup is not repeated on every search
  // a query that keeps being weak is retried less and less often: 30 min, 60 min, 2 h ... capped at 24 h
  const q = rig({ templates: ['https://wiki.example/wiki/{title}', 'https://other.example/{slug}'], maxCandidates: 1 }); assert.equal(q.search('zebra crossing').crawl.state, 'scheduled');
  q.advance(31 * MIN); assert.equal(q.search('zebra crossing').crawl.state, 'scheduled'); // round two, one candidate each time (the cap), a new one
  q.advance(31 * MIN); assert.equal(q.search('zebra crossing').crawl.state, 'cooldown'); // the second round doubled the wait to an hour
  q.advance(30 * MIN); assert.notEqual(q.search('zebra crossing').crawl.state, 'cooldown');
});

test('only a salted hash of the query is stored: no query text in the database, and the same query hashes the same way', () => {
  const r = rig(); r.search('my very private search about gout'); r.search('another good pharmacy question');
  const dump = JSON.stringify([r.db.prepare('SELECT * FROM queries').all(), r.db.prepare('SELECT * FROM meta').all()]);
  for (const word of ['private', 'gout', 'pharmacy', 'question']) assert.equal(dump.includes(word), false, word);
  assert.equal(r.planner.queryKey('Gout PRIVATE'), r.planner.queryKey('private gout')); assert.notEqual(r.planner.queryKey('private gout'), r.planner.queryKey('private goat'));
  const other = rig(); assert.notEqual(other.planner.queryKey('private gout'), r.planner.queryKey('private gout')); // the salt is per install
  const again = new DemandPlanner(r.db, r.frontier, r.documents, { clock: () => r.time.now }); assert.equal(again.queryKey('private gout'), r.planner.queryKey('private gout')); // and persistent
});

test('paging through results never triggers crawling, and nothing searchable never does either', () => {
  const r = rig(); const { result } = r.search('anything at all'); assert.equal(demandUrls(r).length, 1);
  const fresh = rig(); assert.equal(fresh.searcher.search('anything at all', { offset: 10 }).hits.length, 0); // the API only calls consider() for offset 0 (tested there)
  assert.equal(fresh.planner.consider('!!!', fresh.searcher.search('!!!')).state, 'none'); assert.equal(result.total, 0);
});

test('guards: busy queue, hourly limit, and candidates are capped', () => {
  const busy = rig({ maxPendingDemand: 2, templates: ['https://wiki.example/a/{slug}', 'https://wiki.example/b/{slug}'] });
  assert.equal(busy.search('first query here').crawl.state, 'scheduled'); // fills the queue (2)
  assert.deepEqual(busy.search('second query here').crawl.state, 'busy');
  const limited = rig({ maxQueriesPerHour: 2 });
  assert.equal(limited.search('one').crawl.state, 'scheduled'); assert.equal(limited.search('two').crawl.state, 'scheduled');
  assert.deepEqual([limited.search('three').crawl.state, limited.search('three').crawl.retryAfterSec], ['rate_limited', 60]);
  limited.advance(HOUR + MIN); assert.equal(limited.search('three').crawl.state, 'scheduled'); // the hour passed
  const capped = rig({ maxCandidates: 2, templates: ['https://a.example/{slug}', 'https://b.example/{slug}', 'https://c.example/{slug}'] });
  assert.equal(capped.search('cap me').crawl.candidates, 2);
});

test('discovery: known waiting URLs that mention the query are promoted to demand, and the links of partial matches are followed', () => {
  const r = rig({ templates: [] });
  r.frontier.add('https://blog.example/posts/sourdough-hydration', { queue: 'PUBLIC', priority: 10 }, r.time.now);
  r.frontier.add('https://blog.example/posts/unrelated', { queue: 'PUBLIC', priority: 99 }, r.time.now);
  assert.equal(r.search('sourdough hydration').crawl.state, 'scheduled');
  assert.equal(r.frontier.getByUrl('https://blog.example/posts/sourdough-hydration')?.queue, 'DEMAND'); // promoted
  assert.equal(r.frontier.getByUrl('https://blog.example/posts/unrelated')?.queue, 'PUBLIC'); // untouched
  // partial match: a page about the topic links to pages never fetched; they are what to crawl next
  const l = rig({ templates: [] });
  l.documents.upsert(doc('https://hub.example/kayaks', 'Kayak hub', 'a hub page about kayak touring'));
  const link = (url: string) => ({ key: urlKey(url), url, host: new URL(url).hostname });
  l.documents.setLinks(urlKey('https://hub.example/kayaks'), 'hub.example', [link('https://paddle.example/kayak-touring-guide'), link('https://paddle.example/contact'), link('https://hub.example/known')]);
  l.frontier.add('https://hub.example/known', { queue: 'PUBLIC' }, l.time.now); // already known: not a new candidate
  const { crawl } = l.search('kayak touring routes');
  assert.deepEqual([crawl.state, crawl.candidates], ['scheduled', 2]);
  assert.deepEqual(demandUrls(l), ['https://paddle.example/contact', 'https://paddle.example/kayak-touring-guide']);
});

test('templates fill in only letters and digits, cannot change the host or add structure, and unsafe expansions are refused', () => {
  assert.equal(expandTemplate('https://wiki.example/wiki/{title}', ['rust', 'programming', 'language']), 'https://wiki.example/wiki/Rust_programming_language');
  assert.equal(expandTemplate('https://s.example/search?q={query}', ['a', 'b']), 'https://s.example/search?q=a+b');
  assert.equal(expandTemplate('https://wiki.example/{slug}', ['über', 'cafe']), 'https://wiki.example/%C3%BCber-cafe');
  const r = rig({ templates: ['https://127.0.0.1/{slug}', 'http://wiki.example:8080/{slug}', 'ftp://wiki.example/{slug}', 'https://ok.example/{slug}'] });
  assert.deepEqual([r.search('evil path').crawl.candidates, demandUrls(r)], [1, ['https://ok.example/evil-path']]); // an IP, a port and a scheme are all refused by URL admission
  const hostile = rig({ templates: ['https://ok.example/{slug}'] }); hostile.search('../../etc/passwd?x=1#y'); // the query becomes letters and digits only
  assert.deepEqual(demandUrls(hostile), ['https://ok.example/etc-passwd-x-1-y']);
});

test('no candidates means no change and a short cooldown, never an error', () => {
  const r = rig({ templates: [] });
  const { crawl } = r.search('nothing to start from'); assert.deepEqual([crawl.triggered, crawl.state, crawl.candidates], [false, 'no_candidates', 0]);
  assert.equal(r.search('nothing to start from').crawl.state, 'cooldown'); assert.equal(r.frontier.stats().PENDING, 0);
});

test('the query ledger is bounded: old queries are forgotten, a hard cap keeps the most recent, and a forgotten query is simply treated as new', () => {
  const r = rig({ minStrong: 3 });
  for (let i = 0; i < 20; i++) { r.search(`topic${i} thing`); r.advance(HOUR); }
  const count = () => r.planner.stats().queries;
  assert.equal(count(), 20);
  assert.equal(r.planner.prune({ maxAgeMs: 100 * HOUR }), 0, 'nothing is older than the window');
  assert.equal(r.planner.prune({ maxAgeMs: 10 * HOUR + 1 }), 10, 'queries last seen more than 10 hours ago are forgotten (the oldest 10 of the 20; the clock moved an hour after each)');
  assert.equal(count(), 10);
  assert.equal(r.planner.prune({ maxAgeMs: 1000 * HOUR, maxRows: 5 }), 5, 'a hard cap removes the least recently seen beyond it');
  const kept = (r.db.prepare('SELECT last_seen FROM queries ORDER BY last_seen').all() as Array<{ last_seen: number }>).map(row => row.last_seen);
  assert.equal(kept.length, 5); assert.ok(Math.min(...kept) > 10_000_000 + 14 * HOUR, 'the most recently seen were kept');
  const again = r.search('topic0 thing'); assert.equal(again.crawl.state === 'cooldown', false, 'a forgotten query is treated as new, not as one in cooldown');
  assert.equal(r.planner.prune(), 0);
});
