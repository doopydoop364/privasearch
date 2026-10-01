import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeResult, pageResult } from '../src/privanet/fake-transport.js';
import { crawlTrap, discoveryPriority } from '../src/policy.js';
import { urlKey } from '../src/url.js';
import { rig } from './helpers.js';

const DAY = 86400000; const HOUR = 3600000;
const sha = (n: number) => n.toString(16).padStart(64, '0');
const never = () => { throw new Error('no fetch expected'); };

/** Runs one fetch of a URL straight through the frontier with a chosen content hash, and returns the updated row. */
function fetchOnce(r: ReturnType<typeof rig>, url: string, hash: number, extra: Parameters<typeof pageResult>[3] = {}) {
  const leased = r.frontier.lease(r.time.now, 50).find(l => l.url === url); assert.ok(leased, `${url} should be due`);
  r.frontier.complete(leased.urlKey, pageResult(url, r.time.now, { title: 't', text: `v${hash}` }, { contentSha256: sha(hash), ...extra }), r.time.now);
  const row = r.frontier.getByUrl(url); assert.ok(row); return row;
}

test('adaptive recrawl: unchanged pages are looked at less and less often, changed pages sooner, within bounds', () => {
  const r = rig(never, { hostDelayMs: 0, recrawlMs: 4 * DAY, recrawlMinMs: 1 * DAY, recrawlMaxMs: 16 * DAY });
  const url = 'https://a.example/'; r.frontier.add(url, { queue: 'PUBLIC' }, r.time.now);
  let row = fetchOnce(r, url, 1);
  assert.deepEqual([row.interval_ms, row.next_at - r.time.now, row.change_count], [4 * DAY, 4 * DAY, 0]); // the first fetch starts at the initial interval
  r.advance(4 * DAY); row = fetchOnce(r, url, 1); assert.deepEqual([row.interval_ms, row.unchanged_streak], [8 * DAY, 1]);
  r.advance(8 * DAY); row = fetchOnce(r, url, 1); assert.deepEqual([row.interval_ms, row.unchanged_streak], [16 * DAY, 2]);
  r.advance(16 * DAY); row = fetchOnce(r, url, 1); assert.equal(row.interval_ms, 16 * DAY); // capped
  r.advance(16 * DAY); row = fetchOnce(r, url, 2); // the content hash changed
  assert.deepEqual([row.interval_ms, row.change_count, row.unchanged_streak, row.last_changed_at], [8 * DAY, 1, 0, r.time.now]);
  for (const expected of [4 * DAY, 2 * DAY, 1 * DAY, 1 * DAY]) { r.advance(row.interval_ms ?? 0); row = fetchOnce(r, url, row.change_count + 10); assert.equal(row.interval_ms, expected); } // halves, floors at the minimum
});

test('a 304 counts as unchanged, a probe changes nothing, and a page many other sites link to is capped sooner', () => {
  const r = rig(never, { hostDelayMs: 0, recrawlMs: 4 * DAY, recrawlMaxMs: 60 * DAY, importantRecrawlMaxMs: 10 * DAY });
  const url = 'https://a.example/'; r.frontier.add(url, { queue: 'PUBLIC' }, r.time.now); fetchOnce(r, url, 1);
  r.advance(4 * DAY); let [l] = r.frontier.lease(r.time.now, 5); assert.ok(l);
  r.frontier.complete(l.urlKey, outcomeResult('NOT_MODIFIED', url, r.time.now, { httpStatus: 304 }), r.time.now);
  assert.equal(r.frontier.getByUrl(url)?.interval_ms, 8 * DAY); assert.equal(r.frontier.getByUrl(url)?.unchanged_streak, 1);
  r.advance(8 * DAY); [l] = r.frontier.lease(r.time.now, 5); assert.ok(l);
  r.frontier.complete(l.urlKey, outcomeResult('PROBED', url, r.time.now, { httpStatus: 200 }), r.time.now);
  assert.equal(r.frontier.getByUrl(url)?.interval_ms, 8 * DAY); // a probe says nothing about change
  // five other hosts link here: it is important, so it is never left longer than the important cap
  for (let i = 0; i < 5; i++) r.db.prepare('INSERT OR IGNORE INTO links (src_key,dst_key,dst_url,src_host,dst_host) VALUES (?,?,?,?,?)').run(`s${i}`, urlKey(url), url, `h${i}.example`, 'a.example');
  r.advance(8 * DAY); fetchOnce(r, url, 1); assert.equal(r.frontier.getByUrl(url)?.interval_ms, 10 * DAY); // unchanged would double to 16 days; the cap is 10
});

test('through the crawler: changed content replaces the indexed text, unchanged content is not counted as a change, and the page is refreshed on its interval', async () => {
  let version = 1;
  const r = rig(input => pageResult(input.url, r.time.now, { title: 'Weather', text: version === 1 ? 'sunny with light winds' : 'storm warning for the coast' }, { contentSha256: sha(version) }), { hostDelayMs: 0, recrawlMs: 2 * DAY });
  r.frontier.add('https://w.example/', { queue: 'PUBLIC' }, r.time.now);
  assert.deepEqual([(await r.crawler.runOnce()).changed, r.documents.search('sunny').length], [1, 1]);
  r.advance(2 * DAY); const same = await r.crawler.runOnce(); assert.deepEqual([same.submitted, same.changed], [1, 0]); // refreshed, nothing changed
  assert.equal(r.documents.get(urlKey('https://w.example/'))?.changeCount, 0);
  r.advance(4 * DAY); version = 2; const changed = await r.crawler.runOnce(); assert.equal(changed.changed, 1);
  assert.deepEqual([r.documents.search('sunny').length, r.documents.search('storm').length], [0, 1]); // the index follows the page
  assert.equal(r.documents.get(urlKey('https://w.example/'))?.changeCount, 1);
});

test('a page that kept failing is retried rarely and after everything else, never ahead of new work', () => {
  const r = rig(never, { hostDelayMs: 0, maxAttempts: 1, failedRecheckMs: 10 * DAY });
  r.frontier.add('https://dead.example/', { queue: 'PUBLIC' }, r.time.now);
  const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l);
  r.frontier.complete(l.urlKey, outcomeResult('FETCH_FAILED', l.url, r.time.now, { error: { code: 'TLS', retryable: false } }), r.time.now);
  assert.equal(r.frontier.getByUrl('https://dead.example/')?.state, 'FAILED');
  r.advance(9 * DAY); assert.equal(r.frontier.lease(r.time.now, 5).length, 0);
  r.advance(1 * DAY); r.frontier.add('https://fresh.example/', { queue: 'PUBLIC' }, r.time.now);
  assert.deepEqual(r.frontier.lease(r.time.now, 1).map(x => x.host), ['fresh.example']); // new work first (the single-slot recrawl turn is not this one)
  assert.deepEqual(r.frontier.lease(r.time.now, 5).map(x => x.host), ['dead.example']); // then the rare retry
});

test('lease mix: a share of every lease goes to due recrawls, and either side fills what the other cannot use', () => {
  const r = rig(never, { hostDelayMs: 0, recrawlShare: 0.25, recrawlMs: DAY });
  for (let i = 0; i < 8; i++) { const u = `https://done${i}.example/`; r.frontier.add(u, { queue: 'PUBLIC' }, r.time.now); fetchOnce(r, u, i + 1); }
  r.advance(DAY);
  for (let i = 0; i < 20; i++) r.frontier.add(`https://new${i}.example/`, { queue: 'PUBLIC', priority: 10 }, r.time.now);
  const mixed = r.frontier.lease(r.time.now, 8); assert.equal(mixed.length, 8);
  assert.equal(mixed.filter(l => l.host.startsWith('done')).length, 2); assert.equal(mixed.filter(l => l.host.startsWith('new')).length, 6); // 25% of 8, the rest new work
  const onlyRecrawls = rig(never, { hostDelayMs: 0, recrawlMs: DAY });
  for (let i = 0; i < 4; i++) { const u = `https://r${i}.example/`; onlyRecrawls.frontier.add(u, { queue: 'PUBLIC' }, onlyRecrawls.time.now); fetchOnce(onlyRecrawls, u, i + 1); }
  onlyRecrawls.advance(DAY); assert.equal(onlyRecrawls.frontier.lease(onlyRecrawls.time.now, 8).length, 4); // nothing new: recrawls get every slot
  const single = rig(never, { hostDelayMs: 0, recrawlMs: DAY });
  single.frontier.add('https://old.example/', { queue: 'PUBLIC' }, single.time.now); fetchOnce(single, 'https://old.example/', 1); single.advance(DAY);
  for (let i = 0; i < 8; i++) single.frontier.add(`https://n${i}.example/`, { queue: 'PUBLIC' }, single.time.now);
  const order = []; for (let i = 0; i < 4; i++) { const [l] = single.frontier.lease(single.time.now, 1); assert.ok(l); order.push(l.host === 'old.example' ? 'recrawl' : 'new'); }
  assert.deepEqual(order, ['new', 'new', 'new', 'recrawl']); // one lease in four is a recrawl even one slot at a time
});

test('demand is always first, then discovery by priority: shallow pages before deep ones, a seed before both', () => {
  const r = rig(never, { hostDelayMs: 0 });
  r.frontier.add('https://deep.example/', { queue: 'PUBLIC', depth: 5, priority: discoveryPriority(5) }, r.time.now);
  r.frontier.add('https://shallow.example/', { queue: 'PUBLIC', depth: 1, priority: discoveryPriority(1) }, r.time.now);
  r.frontier.add('https://seed.example/', { queue: 'PUBLIC', priority: 60 }, r.time.now);
  r.frontier.add('https://asked.example/', { queue: 'DEMAND', priority: 100 }, r.time.now);
  assert.deepEqual(r.frontier.lease(r.time.now, 4).map(l => l.host), ['asked.example', 'seed.example', 'shallow.example', 'deep.example']);
  assert.ok(discoveryPriority(1) > discoveryPriority(5) && discoveryPriority(100) === 0);
  // a link rediscovered with a better priority is raised, not duplicated
  const q = rig(never, { hostDelayMs: 0 });
  q.frontier.add('https://x.example/', { queue: 'PUBLIC', priority: 1 }, q.time.now); assert.equal(q.frontier.add('https://x.example/', { queue: 'PUBLIC', priority: 30 }, q.time.now), 'EXISTS');
  assert.equal(q.frontier.getByUrl('https://x.example/')?.priority, 30);
});

test('crawl traps: calendars, filters, session ids, repeating paths and deep pagination are refused for discovered links only', () => {
  const trap: Record<string, string | undefined> = {
    'https://s.example/calendar/2031/05?month=6': 'CALENDAR', 'https://s.example/events/2031/05/14': 'CALENDAR', 'https://s.example/list?year=2031&month=2': 'CALENDAR',
    'https://s.example/a/b/a/b/a/b': 'REPEATING_SEGMENTS', 'https://s.example/1/2/3/4/5/6/7/8/9/10/11': 'TOO_MANY_SEGMENTS',
    'https://s.example/p?a=1&b=2&c=3&d=4&e=5&f=6': 'TOO_MANY_PARAMS', ['https://s.example/p?q=' + 'x'.repeat(170)]: 'LONG_QUERY',
    'https://s.example/p?sessionid=abc': 'SESSION_OR_FILTER_PARAM', 'https://s.example/p?sort=price&id=3': 'SESSION_OR_FILTER_PARAM', 'https://s.example/p?PHPSESSID=1': 'SESSION_OR_FILTER_PARAM',
    'https://s.example/blog?page=99': 'DEEP_PAGINATION', 'https://s.example/blog/page/45/': 'DEEP_PAGINATION',
    'https://s.example/blog?page=3': undefined, 'https://s.example/blog/page/2/': undefined, 'https://s.example/about': undefined, 'https://s.example/2031/05/14/post-title': undefined,
    'https://s.example/docs/guide?id=7': undefined, 'https://s.example/a/b/a/b': undefined,
  };
  for (const [url, reason] of Object.entries(trap)) assert.equal(crawlTrap(url), reason, url);
  const r = rig(never);
  assert.equal(r.frontier.add('https://s.example/calendar/2031/05?month=6', { queue: 'PUBLIC', source: 'discovered' }, r.time.now), 'TRAP:CALENDAR');
  assert.equal(r.frontier.getByUrl('https://s.example/calendar/2031/05?month=6'), undefined);
  assert.equal(r.frontier.add('https://s.example/calendar/2031/05?month=6', { queue: 'PUBLIC', source: 'seed' }, r.time.now), 'ADDED'); // an operator's seed is never judged
});

test('through the crawler: trapped links are counted and never queued; the per-host budget bounds what one site can fill', async () => {
  const links = ['https://t.example/about', 'https://t.example/calendar/2031/05?month=6', 'https://t.example/x?sessionid=9', 'https://t.example/a', 'https://t.example/b', 'https://t.example/c'];
  const r = rig(input => pageResult(input.url, r.time.now, { title: 'T', text: 'hello', links: links.map(url => ({ url })) }), { hostDelayMs: 0, maxUrlsPerHost: 4 });
  r.frontier.add('https://t.example/', { queue: 'PUBLIC' }, r.time.now);
  const summary = await r.crawler.runOnce();
  assert.deepEqual([summary.discovered, summary.trapped], [3, 3]); // the seed + 3 links fill the budget of 4; the calendar and session-id links are traps and the last link is over budget
  assert.equal(r.frontier.add('https://t.example/seed2', { queue: 'PUBLIC' }, r.time.now), 'ADDED'); // seeds and demand are not held to the discovery budget
});

test('rate limits and Retry-After: the host waits as told, other hosts carry on, and no attempt is spent', async () => {
  const r = rig(input => input.url.startsWith('https://slow.') ? outcomeResult('RATE_LIMITED', input.url, r.time.now, { retryAfterSec: 120 }) : pageResult(input.url, r.time.now, { title: 'ok', text: 'fine' }), { hostDelayMs: 1000 });
  for (const u of ['https://slow.example/1', 'https://slow.example/2', 'https://fine.example/1', 'https://fine.example/2']) r.frontier.add(u, { queue: 'PUBLIC' }, r.time.now);
  await r.crawler.runOnce();
  assert.equal(r.frontier.getByUrl('https://slow.example/1')?.attempts, 0);
  r.advance(60_000); assert.deepEqual((await r.crawler.runOnce()).submitted, 1); // only fine.example's second page; slow.example is still inside its 120 s
  assert.deepEqual(r.transport.calls.filter(c => c.input.url.startsWith('https://slow.')).length, 1);
  r.advance(61_000); assert.equal((await r.crawler.runOnce()).submitted >= 1, true); // after the wait it is asked again
  assert.equal(r.transport.calls.filter(c => c.input.url.startsWith('https://slow.')).length, 2);
});

test('robots: a disallowed URL is never indexed and is not asked for again for a day; a 429 with Retry-After backs the URL off', async () => {
  const r = rig(input => input.url.endsWith('/private') ? outcomeResult('ROBOTS_DISALLOWED', input.url, r.time.now, { robots: { verdict: 'DISALLOWED' } })
    : input.url.endsWith('/busy') ? outcomeResult('HTTP_ERROR', input.url, r.time.now, { httpStatus: 429, retryAfterSec: 3600 }) : pageResult(input.url, r.time.now, { title: 'ok', text: 'hello' }), { hostDelayMs: 0, backoffBaseMs: 1000 });
  r.frontier.add('https://r.example/private', { queue: 'PUBLIC' }, r.time.now); r.frontier.add('https://q.example/busy', { queue: 'PUBLIC' }, r.time.now);
  const first = await r.crawler.runOnce(); assert.equal(first.outcomes.ROBOTS_DISALLOWED, 1); assert.equal(r.documents.count().documents, 0);
  r.advance(HOUR - 1); assert.equal((await r.crawler.runOnce()).submitted, 0); // 429 asked for an hour; robots asked for a day
  r.advance(1); assert.deepEqual((await r.crawler.runOnce()).submitted, 1); // the busy URL again, not the robots-denied one
  assert.equal(r.transport.calls.filter(c => c.input.url.endsWith('/private')).length, 1);
  r.advance(DAY); assert.equal(r.transport.calls.filter(c => c.input.url.endsWith('/private')).length, 1); // (re-checked only when the next pass runs)
  await r.crawler.runOnce(); assert.equal(r.transport.calls.filter(c => c.input.url.endsWith('/private')).length, 2);
});
