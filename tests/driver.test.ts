import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeResult, pageResult } from '../src/privanet/fake-transport.js';
import { TransportError } from '../src/privanet/transport.js';
import { idempotencyKeyFor, urlKey } from '../src/url.js';
import { rig } from './helpers.js';

const at = 1_000_000_000;
const site = (pages: Record<string, ReturnType<typeof pageResult>>) => (input: { url: string }) => pages[input.url] ?? outcomeResult('HTTP_ERROR', input.url, at, { httpStatus: 404 });

test('end to end through the fake path: seed, crawl, discover, recrawl politely, index and search', async () => {
  const pages = {
    'https://a.example/': pageResult('https://a.example/', at, { title: 'Alpine hiking guide', text: 'Trails, huts and passes in the Alps.', links: [{ url: 'https://a.example/routes?utm_source=feed#top' }, { url: 'https://b.example/' }, { url: 'https://a.example/skip', nofollow: true }, { url: 'ftp://a.example/x' }, { url: 'http://127.0.0.1/admin' }] }),
    'https://a.example/routes': pageResult('https://a.example/routes', at, { title: 'Routes', text: 'Ridge routes above the treeline.' }),
    'https://b.example/': pageResult('https://b.example/', at, { title: 'Harbour tides', text: 'Tide tables for the harbour.' }),
  };
  const r = rig(site(pages));
  assert.equal(r.frontier.add('https://a.example/', { queue: 'DEMAND' }, r.time.now), 'ADDED');
  const first = await r.crawler.runOnce();
  assert.deepEqual([first.submitted, first.outcomes.FETCHED, first.indexed, first.discovered], [1, 1, 1, 2]); // routes + b.example; nofollow, ftp and IP literal never enter
  assert.equal(r.frontier.getByUrl('https://a.example/routes')?.queue, 'PUBLIC'); // discovery is public work, never demand
  assert.equal(r.frontier.getByUrl('https://a.example/skip'), undefined);
  assert.equal((await r.crawler.runOnce()).submitted, 1); // only b.example is free: a.example is inside its 1 s host delay
  r.advance(1000); assert.equal((await r.crawler.runOnce()).submitted, 1); // then a.example/routes
  assert.deepEqual(r.transport.calls.map(c => c.queue), ['DEMAND', 'PUBLIC', 'PUBLIC']);
  assert.equal(r.transport.calls.every(c => c.idempotencyKey === idempotencyKeyFor(c.input.url, 0)), true);
  assert.deepEqual(r.documents.search('alps').map(h => h.url), ['https://a.example/']);
  assert.deepEqual(r.documents.search('tide harbour').map(h => h.title), ['Harbour tides']);
  assert.equal(r.documents.count().indexed, 3);
});

test('all twelve outcomes are handled through the driver, each with its own effect', async () => {
  const u = (n: string) => `https://${n}.example/`;
  const results: Record<string, () => unknown> = {
    fetched: () => pageResult(u('fetched'), at, { title: 'Doc', text: 'x', links: [] }),
    notmod: () => outcomeResult('NOT_MODIFIED', u('notmod'), at, { httpStatus: 304 }),
    probed: () => outcomeResult('PROBED', u('probed'), at, { httpStatus: 200 }),
    redirect: () => outcomeResult('REDIRECT', u('redirect'), at, { httpStatus: 301, redirectTarget: 'https://target.example/new' }),
    robots: () => outcomeResult('ROBOTS_DISALLOWED', u('robots'), at, { robots: { verdict: 'DISALLOWED' } }),
    robotsun: () => outcomeResult('ROBOTS_UNAVAILABLE', u('robotsun'), at, { robots: { verdict: 'UNAVAILABLE' } }),
    blocked: () => outcomeResult('BLOCKED_TARGET', u('blocked'), at),
    limited: () => outcomeResult('RATE_LIMITED', u('limited'), at, { retryAfterSec: 30 }),
    ctype: () => outcomeResult('UNSUPPORTED_CONTENT_TYPE', u('ctype'), at, { httpStatus: 200, contentType: 'application/pdf' }),
    big: () => outcomeResult('TOO_LARGE', u('big'), at, { httpStatus: 200 }),
    http: () => outcomeResult('HTTP_ERROR', u('http'), at, { httpStatus: 503, retryAfterSec: 120 }),
    failed: () => outcomeResult('FETCH_FAILED', u('failed'), at, { error: { code: 'DNS', retryable: true } }),
  };
  const r = rig(input => { const name = new URL(input.url).hostname.split('.')[0] ?? ''; const make = results[name]; if (!make) throw new Error(`no canned result for ${name}`); return make(); });
  for (const name of Object.keys(results)) r.frontier.add(u(name), { queue: 'PUBLIC' }, r.time.now);
  const summary = await r.crawler.runOnce();
  assert.equal(summary.submitted, 12); assert.equal(summary.invalidResults, 0); assert.equal(summary.transportErrors, 0);
  assert.deepEqual(Object.keys(summary.outcomes).sort(), ['BLOCKED_TARGET', 'FETCHED', 'FETCH_FAILED', 'HTTP_ERROR', 'NOT_MODIFIED', 'PROBED', 'RATE_LIMITED', 'REDIRECT', 'ROBOTS_DISALLOWED', 'ROBOTS_UNAVAILABLE', 'TOO_LARGE', 'UNSUPPORTED_CONTENT_TYPE']);
  const state = (n: string) => r.frontier.getByUrl(u(n))?.state;
  assert.deepEqual(['fetched', 'notmod', 'probed', 'redirect', 'ctype', 'big'].map(state), Array(6).fill('DONE'));
  assert.deepEqual(['robots', 'robotsun', 'limited', 'http', 'failed'].map(state), Array(5).fill('PENDING')); // all retried later
  assert.equal(state('blocked'), 'BLOCKED');
  assert.equal(r.frontier.getByUrl('https://target.example/new')?.state, 'PENDING');
  assert.equal(r.documents.count().indexed, 1); // only the FETCHED page is indexed
  assert.equal(r.frontier.getByUrl(u('limited'))?.attempts, 0); assert.equal(r.frontier.getByUrl(u('http'))?.attempts, 1);
});

test('results are untrusted: schema violations and impossible claims are rejected, counted as failed attempts, and never stored or followed', async () => {
  const good = (url: string) => pageResult(url, at, { title: 'Real', text: 'real text', links: [{ url: 'https://evil.example/' }] });
  const bad: Record<string, (url: string) => unknown> = {
    schema: url => ({ ...good(url), extraField: 1 }),
    notobject: () => 'FETCHED',
    wrongurl: () => good('https://someone-else.example/'),
    offhost: url => ({ ...good(url), finalUrl: 'https://evil.example/landing' }),
    invalidfinal: url => ({ ...good(url), finalUrl: 'http://127.0.0.1/' }),
    fetchednopage: url => ({ ...good(url), page: undefined }),
    fetched404: url => ({ ...good(url), httpStatus: 404 }),
    redirectnotarget: url => outcomeResult('REDIRECT', url, at, { httpStatus: 301 }),
    httperrorok: url => outcomeResult('HTTP_ERROR', url, at, { httpStatus: 200 }),
    limitednodelay: url => outcomeResult('RATE_LIMITED', url, at),
    failednoerror: url => outcomeResult('FETCH_FAILED', url, at),
  };
  const r = rig(input => { const make = bad[new URL(input.url).hostname.split('.')[0] ?? '']; if (!make) throw new Error('unknown canned case'); return make(input.url); }); // keys are lowercase: URL hostnames are

  for (const name of Object.keys(bad)) r.frontier.add(`https://${name}.example/`, { queue: 'PUBLIC' }, r.time.now);
  const summary = await r.crawler.runOnce();
  assert.equal(summary.invalidResults, Object.keys(bad).length); assert.deepEqual(summary.outcomes, {});
  assert.equal(r.documents.count().documents, 0); assert.equal(r.frontier.getByUrl('https://evil.example/'), undefined); // nothing from a rejected result is used
  for (const name of Object.keys(bad)) { const row = r.frontier.getByUrl(`https://${name}.example/`); assert.deepEqual([row?.state, row?.attempts, row?.generation], ['PENDING', 1, 1], name); assert.match(row?.last_outcome ?? '', /^INVALID_RESULT:/); }
});

test('infrastructure failures are not the URL\'s fault: same idempotency key on resubmission, no attempt counted, longer wait when not retryable', async () => {
  let mode: 'down' | 'forbidden' | 'up' = 'down';
  const r = rig(input => { if (mode === 'down') throw new TransportError('UNAVAILABLE', true); if (mode === 'forbidden') throw new TransportError('FORBIDDEN', false); return pageResult(input.url, at, { title: 'Now up', text: 'back' }); });
  r.frontier.add(A, { queue: 'DEMAND' }, r.time.now);
  const down = await r.crawler.runOnce(); assert.deepEqual([down.transportErrors, down.invalidResults], [1, 0]);
  const row = r.frontier.getByUrl(A); assert.deepEqual([row?.state, row?.attempts, row?.generation], ['PENDING', 0, 0]);
  assert.equal((await r.crawler.runOnce()).submitted, 0); // waiting out the infrastructure delay
  r.advance(60_000); mode = 'up';
  assert.equal((await r.crawler.runOnce()).indexed, 1);
  assert.equal(new Set(r.transport.calls.map(c => c.idempotencyKey)).size, 1); // the retry reused the key, so PrivaNet would not create a second job
  const r2 = rig(() => { throw new TransportError('FORBIDDEN', false); }); r2.frontier.add(A, { queue: 'DEMAND' }, r2.time.now);
  await r2.crawler.runOnce(); assert.equal(r2.frontier.getByUrl(A)?.next_at, r2.time.now + 600_000); // a configuration error is not hammered
  r2.advance(60_000); assert.equal((await r2.crawler.runOnce()).submitted, 0);
});
const A = 'https://a.example/';

test('concurrency: different hosts run in parallel, one host is never in flight twice', async () => {
  const r = rig(async input => { await new Promise(resolve => setTimeout(resolve, 5)); return pageResult(input.url, at, { title: input.url }); });
  for (const h of ['a', 'b', 'c', 'd']) for (const p of ['1', '2', '3']) r.frontier.add(`https://${h}.example/${p}`, { queue: 'PUBLIC' }, r.time.now);
  const summary = await r.crawler.runOnce();
  assert.equal(summary.submitted, 4); assert.equal(r.transport.maxInFlight, 4);
  const hosts = r.transport.calls.map(c => new URL(c.input.url).hostname); assert.equal(new Set(hosts).size, 4);
});

test('duplicate content under another URL is kept but not indexed; noindex and 404 remove pages; nofollow suppresses discovery', async () => {
  const same = 'Identical mirrored text about lighthouses.';
  const r = rig(input => {
    const url = input.url;
    if (url.includes('mirror')) return { ...pageResult(url, at, { title: 'Mirror', text: same }), contentSha256: 'a'.repeat(64) };
    if (url.includes('orig')) return { ...pageResult(url, at, { title: 'Original', text: same }), contentSha256: 'a'.repeat(64) };
    if (url.includes('noidx')) return pageResult(url, at, { title: 'Private', text: 'secret words', links: [{ url: 'https://found.example/' }] }, { indexing: { noindex: true, nofollow: false, noarchive: false } });
    if (url.includes('nofol')) return pageResult(url, at, { title: 'Nofollow', text: 'quiet page', links: [{ url: 'https://ignored.example/' }] }, { indexing: { noindex: false, nofollow: true, noarchive: false } });
    return outcomeResult('HTTP_ERROR', url, at, { httpStatus: 410 });
  }, { hostDelayMs: 0 });
  for (const n of ['orig', 'mirror', 'noidx', 'nofol']) r.frontier.add(`https://${n}.example/`, { queue: 'PUBLIC' }, r.time.now);
  await r.crawler.runOnce();
  assert.deepEqual(r.documents.count(), { documents: 3, indexed: 2, duplicates: 1 }); // orig + nofol indexed; mirror stored as a duplicate; noindex never stored
  assert.deepEqual(r.documents.search('lighthouses').map(h => h.title), ['Original']);
  assert.equal(r.documents.search('secret').length, 0);
  assert.notEqual(r.frontier.getByUrl('https://found.example/'), undefined); assert.equal(r.frontier.getByUrl('https://ignored.example/'), undefined);
  // A page that becomes noindex or disappears is removed from the index on recrawl.
  r.documents.upsert({ urlKey: urlKey('https://gone.example/'), url: 'https://gone.example/', finalUrl: 'https://gone.example/', title: 'Old', description: '', canonicalUrl: null, language: null, text: 'stale words', contentSha256: 'b'.repeat(64), fetchedAt: at, httpStatus: 200 });
  assert.equal(r.documents.search('stale').length, 1);
  r.frontier.add('https://gone.example/', { queue: 'DEMAND' }, r.time.now); await r.crawler.runOnce();
  assert.equal(r.documents.search('stale').length, 0);
});

test('run(): a continuous pipeline keeps the concurrency bound, refills a slot the moment it frees, and never has one host in flight twice', async () => {
  const inFlightByHost = new Map<string, number>(); let violations = 0; const startedAt = new Map<string, number>(); const endedAt = new Map<string, number>();
  const r = rig(async input => {
    const host = new URL(input.url).hostname; const now = performance.now();
    inFlightByHost.set(host, (inFlightByHost.get(host) ?? 0) + 1); if ((inFlightByHost.get(host) ?? 0) > 1) violations++;
    startedAt.set(input.url, now);
    await new Promise(resolve => setTimeout(resolve, host.startsWith('slow') ? 120 : 5));
    endedAt.set(input.url, performance.now()); inFlightByHost.set(host, (inFlightByHost.get(host) ?? 1) - 1);
    return pageResult(input.url, at, { title: input.url });
  }, { hostDelayMs: 0 });
  const urls = ['https://slow.example/1', 'https://a.example/1', 'https://b.example/1', 'https://c.example/1', 'https://d.example/1', 'https://e.example/1', 'https://a.example/2', 'https://b.example/2'];
  for (const url of urls) r.frontier.add(url, { queue: 'PUBLIC' }, r.time.now);
  const summary = await r.crawler.run({ concurrency: 3, until: () => r.documents.count().documents >= urls.length, idleMs: 2 });
  assert.equal(summary.submitted, urls.length); assert.equal(r.documents.count().documents, urls.length);
  assert.ok(r.transport.maxInFlight <= 3, `in flight ${r.transport.maxInFlight}`); assert.equal(violations, 0, 'one host is never in flight twice');
  // Refill: a batch loop would have started only the first 3 URLs before the slow one finished; the pipeline keeps starting more as the fast slots free.
  const slowEnd = endedAt.get('https://slow.example/1') ?? 0; const startedWhileSlowRan = urls.filter(u => (startedAt.get(u) ?? Infinity) < slowEnd).length;
  assert.ok(startedWhileSlowRan >= 6, `only ${startedWhileSlowRan} URLs started while the slow one was running`);
});

test('run(): stops when told to, finishes what it already submitted, and does not lease more after an abort', async () => {
  const controller = new AbortController();
  const r = rig(async input => { await new Promise(resolve => setTimeout(resolve, 10)); if (input.url.endsWith('/3')) controller.abort(); return pageResult(input.url, at, { title: input.url }); }, { hostDelayMs: 0 });
  for (let i = 1; i <= 40; i++) r.frontier.add(`https://h${i}.example/${i % 5 === 3 ? 3 : 1}`, { queue: 'PUBLIC' }, r.time.now);
  const summary = await r.crawler.run({ concurrency: 4, signal: controller.signal, idleMs: 2 });
  assert.ok(summary.submitted < 40, 'aborted before the whole frontier was submitted');
  assert.equal(r.frontier.stats().IN_FLIGHT, 0, 'nothing is left in flight: every submitted crawl was ingested or released');
  assert.equal(r.documents.count().documents, summary.indexed + summary.duplicates);
});
