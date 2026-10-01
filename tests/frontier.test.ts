import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeResult, pageResult } from '../src/privanet/fake-transport.js';
import { urlKey } from '../src/url.js';
import { rig } from './helpers.js';

const respond = () => { throw new Error('unused'); };
const A = 'https://a.example/'; const key = (u: string) => urlKey(u);

test('admission: canonical dedup, rejection reasons, depth limit, and demand promotes known public work', () => {
  const r = rig(respond, { maxDepth: 2 });
  assert.equal(r.frontier.add('https://a.example/x#f', { queue: 'PUBLIC' }, r.time.now), 'ADDED');
  assert.equal(r.frontier.add('https://A.example:443/x', { queue: 'PUBLIC' }, r.time.now), 'EXISTS');
  assert.equal(r.frontier.add('http://127.0.0.1/', { queue: 'PUBLIC' }, r.time.now), 'IP_LITERAL');
  assert.equal(r.frontier.add('https://a.example/deep', { queue: 'PUBLIC', depth: 3 }, r.time.now), 'TOO_DEEP');
  assert.equal(r.frontier.getByUrl('https://a.example/x')?.queue, 'PUBLIC');
  assert.equal(r.frontier.add('https://a.example/x', { queue: 'DEMAND', priority: 9 }, r.time.now), 'EXISTS');
  assert.equal(r.frontier.getByUrl('https://a.example/x')?.queue, 'DEMAND'); assert.equal(r.frontier.getByUrl('https://a.example/x')?.priority, 9);
});

test('politeness: one in-flight request per host, a delay between requests, and demand served before public', () => {
  const r = rig(respond, { hostDelayMs: 5000 });
  for (const u of ['https://a.example/1', 'https://a.example/2', 'https://b.example/1', 'https://c.example/1']) r.frontier.add(u, { queue: 'PUBLIC' }, r.time.now);
  r.frontier.add('https://c.example/urgent', { queue: 'DEMAND' }, r.time.now);
  const first = r.frontier.lease(r.time.now, 10);
  assert.equal(first.length, 3); assert.deepEqual(new Set(first.map(l => l.host)).size, 3); // one per host, even with limit 10
  assert.equal(first.find(l => l.host === 'c.example')?.url, 'https://c.example/urgent'); // demand beat public on the same host
  assert.equal(r.frontier.lease(r.time.now, 10).length, 0); // hosts are in flight
  const done = first.find(l => l.host === 'a.example');
  assert.ok(done); r.frontier.complete(done.urlKey, pageResult(done.url, r.time.now, { title: 't' }), r.time.now);
  assert.equal(r.frontier.lease(r.time.now, 10).length, 0); // a.example must wait out the 5 s delay (b and c are still in flight)
  r.advance(4999); assert.equal(r.frontier.lease(r.time.now, 10).length, 0);
  r.advance(1); const next = r.frontier.lease(r.time.now, 10); assert.equal(next.length, 1); assert.equal(next[0]?.url, 'https://a.example/2');
});

test('robots Crawl-delay raises the per-host delay above the default', () => {
  const r = rig(respond, { hostDelayMs: 1000 });
  r.frontier.add('https://a.example/1', { queue: 'PUBLIC' }, r.time.now); r.frontier.add('https://a.example/2', { queue: 'PUBLIC' }, r.time.now);
  const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l);
  r.frontier.complete(l.urlKey, pageResult(l.url, r.time.now, {}, { robots: { verdict: 'ALLOWED', crawlDelaySec: 30 } }), r.time.now);
  r.advance(29_999); assert.equal(r.frontier.lease(r.time.now, 1).length, 0); r.advance(1); assert.equal(r.frontier.lease(r.time.now, 1).length, 1);
});

test('each outcome has an explicit scheduling policy', () => {
  const r = rig(respond, { maxAttempts: 3, backoffBaseMs: 1000, hostDelayMs: 0 });
  const DAY = 86400000; const now = r.time.now;
  const run = (url: string, result: (u: string) => ReturnType<typeof outcomeResult>) => {
    r.frontier.add(url, { queue: 'PUBLIC' }, now); const [l] = r.frontier.lease(now, 50).filter(x => x.url === url); assert.ok(l, url);
    r.frontier.complete(l.urlKey, result(url), now); const row = r.frontier.getByUrl(url); assert.ok(row); return row;
  };
  const fetched = run('https://f.example/', u => pageResult(u, now, { title: 't' }, { etag: '"e1"', lastModified: 'Tue, 15 Nov 1994 08:12:31 GMT' }));
  assert.deepEqual([fetched.state, fetched.last_outcome, fetched.etag, fetched.generation], ['DONE', 'FETCHED', '"e1"', 1]); assert.equal(fetched.next_at, now + 7 * DAY);
  assert.equal(run('https://nm.example/', u => outcomeResult('NOT_MODIFIED', u, now, { httpStatus: 304 })).state, 'DONE');
  assert.equal(run('https://pr.example/', u => outcomeResult('PROBED', u, now, { httpStatus: 200 })).state, 'DONE');
  const red = run('https://red.example/', u => outcomeResult('REDIRECT', u, now, { httpStatus: 301, redirectTarget: 'https://elsewhere.example/new' }));
  assert.equal(red.state, 'DONE'); assert.equal(r.frontier.getByUrl('https://elsewhere.example/new')?.state, 'PENDING'); // the target is new work, not followed by the node
  const robots = run('https://rd.example/', u => outcomeResult('ROBOTS_DISALLOWED', u, now)); assert.deepEqual([robots.state, robots.next_at], ['PENDING', now + DAY]);
  const blocked = run('https://bt.example/', u => outcomeResult('BLOCKED_TARGET', u, now)); assert.equal(blocked.state, 'BLOCKED');
  const rl = run('https://rl.example/', u => outcomeResult('RATE_LIMITED', u, now, { retryAfterSec: 90 })); assert.deepEqual([rl.state, rl.attempts, rl.next_at], ['PENDING', 0, now + 90_000]);
  assert.equal(run('https://ct.example/', u => outcomeResult('UNSUPPORTED_CONTENT_TYPE', u, now, { httpStatus: 200 })).next_at, now + 30 * DAY);
  assert.equal(run('https://big.example/', u => outcomeResult('TOO_LARGE', u, now, { httpStatus: 200 })).state, 'DONE');
  assert.deepEqual([run('https://gone.example/', u => outcomeResult('HTTP_ERROR', u, now, { httpStatus: 410 })).state, r.frontier.getByUrl('https://gone.example/')?.next_at], ['DONE', now + 30 * DAY]);
  assert.equal(run('https://nf.example/', u => outcomeResult('HTTP_ERROR', u, now, { httpStatus: 403 })).state, 'DONE');
  const busy = run('https://busy.example/', u => outcomeResult('HTTP_ERROR', u, now, { httpStatus: 503, retryAfterSec: 600 })); assert.deepEqual([busy.state, busy.attempts, busy.next_at], ['PENDING', 1, now + 600_000]); // Retry-After beats the 1 s backoff
  const flaky = run('https://flaky.example/', u => outcomeResult('FETCH_FAILED', u, now, { error: { code: 'TIMEOUT', retryable: true } })); assert.deepEqual([flaky.state, flaky.attempts, flaky.next_at], ['PENDING', 1, now + 1000]);
  const dead = run('https://dead.example/', u => outcomeResult('FETCH_FAILED', u, now, { error: { code: 'TLS', retryable: false } })); assert.equal(dead.state, 'FAILED');
  const ru = run('https://ru.example/', u => outcomeResult('ROBOTS_UNAVAILABLE', u, now, { robots: { verdict: 'UNAVAILABLE' } })); assert.deepEqual([ru.state, ru.attempts], ['PENDING', 1]);
});

test('errors back off exponentially and attempts are bounded', () => {
  const r = rig(respond, { maxAttempts: 4, backoffBaseMs: 1000, hostDelayMs: 0 });
  r.frontier.add('https://e.example/1', { queue: 'PUBLIC' }, r.time.now);
  const waits: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l, `attempt ${i}`);
    r.frontier.complete(l.urlKey, outcomeResult('FETCH_FAILED', l.url, r.time.now, { error: { code: 'RESET', retryable: true } }), r.time.now);
    const row = r.frontier.get(l.urlKey); assert.ok(row); waits.push(row.next_at - r.time.now); r.advance(Math.max(waits.at(-1) ?? 0, 1));
  }
  assert.deepEqual(waits.slice(0, 3), [1000, 2000, 4000]); assert.equal(r.frontier.get(key('https://e.example/1'))?.state, 'FAILED'); // the fourth failure is terminal
  // The loop waited out the 30-day recheck interval after the terminal failure: a URL that kept failing is retried rarely, not never (it is the only thing due).
  assert.equal(r.frontier.lease(r.time.now, 1).length, 1);
});

test('a failing host backs off as a whole: its other URLs wait too, other hosts do not', () => {
  const r = rig(respond, { backoffBaseMs: 1000, hostDelayMs: 0 });
  for (const u of ['https://e.example/1', 'https://e.example/2', 'https://ok.example/1', 'https://ok.example/2']) r.frontier.add(u, { queue: 'PUBLIC' }, r.time.now);
  const leased = r.frontier.lease(r.time.now, 5); const first = leased.find(l => l.host === 'e.example'); const fine = leased.find(l => l.host === 'ok.example'); assert.ok(first && fine);
  r.frontier.complete(fine.urlKey, pageResult(fine.url, r.time.now, { title: 't' }), r.time.now);
  r.frontier.complete(first.urlKey, outcomeResult('HTTP_ERROR', first.url, r.time.now, { httpStatus: 503 }), r.time.now);
  assert.deepEqual(r.frontier.lease(r.time.now, 5).map(l => l.host), ['ok.example']);
  r.advance(999); assert.equal(r.frontier.lease(r.time.now, 5).filter(l => l.host === 'e.example').length, 0);
  r.advance(1); assert.equal(r.frontier.lease(r.time.now, 5).filter(l => l.host === 'e.example').length, 1);
});

test('generation advances only when a result arrived; an infrastructure release keeps the key so PrivaNet deduplicates', () => {
  const r = rig(respond, { hostDelayMs: 0 });
  r.frontier.add(A, { queue: 'DEMAND' }, r.time.now);
  const [first] = r.frontier.lease(r.time.now, 1); assert.ok(first); assert.equal(first.generation, 0);
  r.frontier.release(first.urlKey, r.time.now, 5000); r.advance(5000);
  const [again] = r.frontier.lease(r.time.now, 1); assert.ok(again); assert.equal(again.generation, 0);
  r.frontier.complete(again.urlKey, outcomeResult('HTTP_ERROR', A, r.time.now, { httpStatus: 500 }), r.time.now); r.advance(10 * 60_000);
  const [after] = r.frontier.lease(r.time.now, 1); assert.ok(after); assert.equal(after.generation, 1);
});

test('stale leases are requeued without counting an attempt, and recrawls send the stored validators', () => {
  const r = rig(respond, { staleLeaseMs: 1000, hostDelayMs: 0, recrawlMs: 5000 });
  r.frontier.add(A, { queue: 'PUBLIC' }, r.time.now);
  const [l] = r.frontier.lease(r.time.now, 1); assert.ok(l); r.advance(1001); assert.equal(r.frontier.requeueStale(r.time.now), 1);
  const [l2] = r.frontier.lease(r.time.now, 1); assert.ok(l2); assert.equal(r.frontier.get(l2.urlKey)?.attempts, 0);
  r.frontier.complete(l2.urlKey, pageResult(A, r.time.now, { title: 't' }, { etag: '"v9"', lastModified: 'Tue, 15 Nov 1994 08:12:31 GMT' }), r.time.now);
  r.advance(5000); const [again] = r.frontier.lease(r.time.now, 1); assert.deepEqual(again?.validators, { etag: '"v9"', lastModified: 'Tue, 15 Nov 1994 08:12:31 GMT' });
  assert.deepEqual(r.frontier.stats(), { PENDING: 0, IN_FLIGHT: 1, DONE: 0, BLOCKED: 0, FAILED: 0 });
});
