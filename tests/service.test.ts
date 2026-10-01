import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { ConfigError, parseServiceConfig } from '../src/service-config.js';
import type { ServiceConfig } from '../src/service-config.js';
import { startService } from '../src/service.js';
import type { Service } from '../src/service.js';
import { FakeTransport, outcomeResult, pageResult } from '../src/privanet/fake-transport.js';
import type { Responder } from '../src/privanet/fake-transport.js';
import { TransportError } from '../src/privanet/transport.js';
import type { FetchRequest, FetchTransport } from '../src/privanet/transport.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value !== undefined && value !== false) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
}
const quiet = () => undefined;
const configFor = (dbPath: string, over: Partial<ServiceConfig> = {}): ServiceConfig => ({
  dbPath, host: '127.0.0.1', port: 0, concurrency: 4, seeds: [], templates: [], frontier: { hostDelayMs: 0, backoffBaseMs: 40 },
  demand: { enabled: true, minStrong: 3, cooldownMs: 30 * 60000, maxCandidates: 12, maxPendingDemand: 300, maxQueriesPerHour: 30 }, shutdownMs: 300, progressMs: 3600000, ...over });
const WEB = new Map<string, { title: string; text: string; links?: string[] }>([
  ['https://wiki.example/wiki/Alpine_hiking', { title: 'Alpine hiking', text: 'Alpine hiking routes cross the Alps; huts and passes. See also the trail guides.', links: ['https://trails.example/alps-routes', 'https://trails.example/huts', 'https://gear.example/boots'] }],
  ['https://trails.example/alps-routes', { title: 'Alpine hiking routes in the Alps', text: 'The best alpine hiking routes: ridge walks, passes and glacier trails.', links: ['https://trails.example/huts'] }],
  ['https://trails.example/huts', { title: 'Alpine hiking huts', text: 'Mountain huts for alpine hiking: booking, prices and seasons.' }],
  ['https://gear.example/boots', { title: 'Hiking boots', text: 'How to pick boots for alpine hiking, the fit and the sole.' }],
  ['https://seed.example/', { title: 'Seed page', text: 'The seed page has some words and a link.', links: ['https://seed.example/second'] }],
  ['https://seed.example/second', { title: 'Second seed page', text: 'Discovered without anyone searching for it.' }],
]);
const web = (clock: () => number = Date.now): Responder => input => { const page = WEB.get(input.url);
  return page ? pageResult(input.url, clock(), { title: page.title, text: page.text, links: (page.links ?? []).map(url => ({ url })) }) : outcomeResult('HTTP_ERROR', input.url, clock(), { httpStatus: 404 }); };
async function dir(t: { after(fn: () => Promise<void>): void }) { const d = await mkdtemp(join(tmpdir(), 'privasearch-svc-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }
const api = async (s: Service, path: string, headers: Record<string, string> = {}) => { const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { headers }); return { status: res.status, body: await res.json() as Record<string, any> }; }; // eslint-disable-line @typescript-eslint/no-explicit-any

test('search-only mode: no PrivaNet settings means it serves the existing index and crawls nothing, and says so', async t => {
  const d = await dir(t); const first = await startService(configFor(join(d, 'db.sqlite')), { log: quiet });
  const { documents } = first; documents.upsert({ urlKey: 'k', url: 'https://x.example/a', finalUrl: 'https://x.example/a', title: 'Existing page', description: '', canonicalUrl: null, language: 'en', text: 'already indexed words', contentSha256: 'a'.repeat(64), fetchedAt: 1, httpStatus: 200 });
  const search = await api(first, '/search?q=indexed'); assert.deepEqual([search.body.total, search.body.crawl.state], [1, 'disabled']);
  assert.equal((await api(first, '/health')).body.crawling, false); assert.equal(first.crawler, undefined); assert.equal(first.planner, undefined);
  await first.stop();
});

test('the whole loop: an empty index answers at once, demand crawling fetches through the transport, pages become searchable, links feed the frontier, and repeating improves the results', async t => {
  const d = await dir(t); const transport = new FakeTransport(web());
  const s = await startService(configFor(join(d, 'db.sqlite'), { templates: ['https://wiki.example/wiki/{title}'] }), { transport, log: quiet }); t.after(() => s.stop());
  const first = await api(s, '/search?q=alpine%20hiking');
  assert.deepEqual([first.status, first.body.total, first.body.index.state, first.body.crawl.triggered, first.body.crawl.state], [200, 0, 'empty', true, 'scheduled']); // an immediate, honest answer
  await until('the demand-crawled page to be searchable', async () => (await api(s, '/search?q=alpine%20hiking')).body.total > 0);
  assert.equal(transport.calls[0]?.queue, 'DEMAND'); assert.equal(transport.calls[0]?.input.url, 'https://wiki.example/wiki/Alpine_hiking'); // the user's search went to PrivaNet, at demand priority
  // its links were discovered into the frontier and crawled in the background; the repeated search now has strong results
  const better = await until('the discovered pages to be indexed', async () => { const r = await api(s, '/search?q=alpine%20hiking'); return r.body.index.state === 'ready' ? r : undefined; });
  assert.ok(better.body.total >= 3); assert.equal(better.body.crawl.triggered, false); assert.equal(better.body.hits[0].signals.matchedTerms, 2);
  assert.ok(transport.calls.some(c => c.queue === 'PUBLIC' && c.input.url.startsWith('https://trails.example/'))); // discovery is background work, never demand
  assert.equal(transport.calls.every(c => /^https:\/\/(wiki|trails|gear)\.example\//.test(c.input.url)), true); // everything the service touched was a URL it was told or discovered
  const status = (await api(s, '/status')).body; assert.ok(status.documents.links > 0); assert.ok(status.demand.queries >= 1);
});

test('the background crawler works with nobody searching: seeds are crawled and their links discovered and indexed', async t => {
  const d = await dir(t); const transport = new FakeTransport(web());
  const s = await startService(configFor(join(d, 'db.sqlite'), { seeds: ['https://seed.example/'] }), { transport, log: quiet }); t.after(() => s.stop());
  await until('the discovered page to be indexed', () => s.documents.count().indexed >= 2);
  assert.deepEqual(transport.calls.map(c => c.queue), ['PUBLIC', 'PUBLIC']); // no demand: nobody asked
  assert.deepEqual((await api(s, '/search?q=discovered')).body.hits.map((h: { url: string }) => h.url), ['https://seed.example/second']);
});

test('restart: the index, the link graph, the frontier and the demand ledger survive, nothing is re-fetched needlessly, and seeds do not duplicate', async t => {
  const d = await dir(t); const path = join(d, 'db.sqlite'); const transport = new FakeTransport(web());
  const one = await startService(configFor(path, { seeds: ['https://seed.example/'] }), { transport, log: quiet });
  await until('both pages', () => one.documents.count().indexed >= 2); await api(one, '/search?q=zzz%20unknown%20topic');
  const before = { docs: one.documents.count(), links: one.documents.linkCount(), calls: transport.calls.length };
  await one.stop();
  const again = new FakeTransport(web());
  const two = await startService(configFor(path, { seeds: ['https://seed.example/'] }), { transport: again, log: quiet }); t.after(() => two.stop());
  assert.deepEqual([two.documents.count(), two.documents.linkCount()], [before.docs, before.links]);
  assert.deepEqual((await api(two, '/search?q=discovered')).body.hits.map((h: { url: string }) => h.url), ['https://seed.example/second']);
  await sleep(300); assert.equal(again.calls.length, 0, 'fresh pages are not fetched again until they are due'); assert.equal(two.frontier.stats().PENDING, 0);
  assert.equal(two.frontier.getByUrl('https://seed.example/')?.state, 'DONE'); assert.equal(two.planner?.stats().queries, 2); // the ledger is persistent too: the earlier query plus the one just made
});

test('a stop past its deadline gives up on fetches still waiting, returns their URLs to the frontier, and the next start picks them up', async t => {
  const d = await dir(t); const path = join(d, 'db.sqlite');
  const hung: FetchTransport = { fetch: (request: FetchRequest) => new Promise((_resolve, reject) => { request.signal?.addEventListener('abort', () => reject(new TransportError('UNAVAILABLE', true)), { once: true }); }) };
  const one = await startService(configFor(path, { seeds: ['https://seed.example/'], shutdownMs: 200 }), { transport: hung, log: quiet });
  await until('the URL to be in flight', () => one.frontier.stats().IN_FLIGHT === 1);
  const started = Date.now(); await one.stop(); assert.ok(Date.now() - started < 3000, 'a hung fetch must not hold up shutdown forever');
  await one.stop(); // idempotent
  const db = openDatabase(path); const states = db.prepare('SELECT state, attempts FROM urls').all() as Array<{ state: string; attempts: number }>; db.close();
  assert.deepEqual(JSON.parse(JSON.stringify(states)), [{ state: 'PENDING', attempts: 0 }]); // returned without counting an attempt
  const two = await startService(configFor(path, { shutdownMs: 200 }), { transport: new FakeTransport(web()), log: quiet }); t.after(() => two.stop());
  await until('the URL to be crawled after the restart', () => two.documents.count().indexed >= 1);
});

test('a PrivaNet outage costs time, not data: failed submissions are retried under the same key, no attempt is spent, and everything is indexed when it returns', async t => {
  const d = await dir(t); let down = true; const inner = new FakeTransport(web());
  const flaky: FetchTransport = { fetch: async request => { if (down) throw new TransportError('UNAVAILABLE', true); return inner.fetch(request); } };
  const s = await startService(configFor(join(d, 'db.sqlite'), { seeds: ['https://seed.example/'] }), { transport: flaky, log: quiet }); t.after(() => s.stop());
  await sleep(300); assert.equal(s.documents.count().indexed, 0); assert.equal(s.frontier.getByUrl('https://seed.example/')?.attempts, 0);
  assert.equal((await api(s, '/search?q=seed')).status, 200); // searching keeps working while PrivaNet is down
  down = false; await until('indexing after the outage', () => s.documents.count().indexed >= 2, 15000);
  assert.equal(s.frontier.getByUrl('https://seed.example/')?.attempts, 0);
});

test('a bug in the crawl loop never takes the search API down', async t => {
  const d = await dir(t); let explode = true;
  const bad: FetchTransport = { fetch: async () => { if (explode) { explode = false; throw new Error('boom'); } return web()({ url: 'https://seed.example/' } as never, {} as never); } };
  const events: string[] = [];
  const s = await startService(configFor(join(d, 'db.sqlite'), { seeds: ['https://seed.example/'] }), { transport: bad, log: e => events.push(String(e.event)) }); t.after(() => s.stop());
  await sleep(200); assert.equal((await api(s, '/health')).status, 200);
});

test('API token on the service: /search needs it, /health does not', async t => {
  const d = await dir(t); const token = 'f'.repeat(40);
  const s = await startService(configFor(join(d, 'db.sqlite'), { apiToken: token }), { log: quiet }); t.after(() => s.stop());
  assert.equal((await api(s, '/search?q=x')).status, 401); assert.equal((await api(s, '/search?q=x', { authorization: `Bearer ${token}` })).status, 200); assert.equal((await api(s, '/health')).status, 200);
});

test('configuration: all-or-none PrivaNet settings, strict credentials, a token off loopback, and errors name settings, never values', () => {
  const tokenA = 'a'.repeat(64); const tokenB = 'b'.repeat(64);
  const ok = parseServiceConfig({ PRIVANET_COORDINATOR_URL: 'https://10.0.0.68', PRIVANET_DEMAND_TOKEN: tokenA, PRIVANET_PUBLIC_TOKEN: tokenB, PRIVASEARCH_DISCOVERY_TEMPLATES: 'https://wiki.example/wiki/{title}  https://x.example/{slug}' }, '# comment\nhttps://seed.example/\n\n');
  assert.deepEqual([ok.privanet?.coordinatorUrl, ok.seeds, ok.templates.length, ok.port, ok.host, ok.demand.enabled], ['https://10.0.0.68', ['https://seed.example/'], 2, 4020, '127.0.0.1', true]);
  assert.equal(parseServiceConfig({}).privanet, undefined); // search-only
  const fails = (env: Record<string, string>, names: string[]) => { try { parseServiceConfig(env); assert.fail('expected a ConfigError'); } catch (error) { assert.ok(error instanceof ConfigError); assert.deepEqual(error.names.sort(), names.sort()); assert.equal(Object.values(env).some(v => v.length > 8 && error.message.includes(v)), false, 'no value in the message'); } };
  fails({ PRIVANET_COORDINATOR_URL: 'https://x' }, ['PRIVANET_DEMAND_TOKEN', 'PRIVANET_PUBLIC_TOKEN']);
  fails({ PRIVANET_COORDINATOR_URL: 'https://x', PRIVANET_DEMAND_TOKEN: 'short', PRIVANET_PUBLIC_TOKEN: tokenB }, ['PRIVANET_DEMAND_TOKEN']);
  fails({ PRIVANET_COORDINATOR_URL: 'https://x', PRIVANET_DEMAND_TOKEN: tokenA, PRIVANET_PUBLIC_TOKEN: tokenA }, ['PRIVANET_DEMAND_TOKEN', 'PRIVANET_PUBLIC_TOKEN']);
  fails({ PRIVASEARCH_HOST: '0.0.0.0' }, ['PRIVASEARCH_API_TOKEN', 'PRIVASEARCH_HOST']); assert.doesNotThrow(() => parseServiceConfig({ PRIVASEARCH_HOST: '0.0.0.0', PRIVASEARCH_API_TOKEN: 'x'.repeat(40) }));
  fails({ PRIVASEARCH_API_TOKEN: 'tooshort' }, ['PRIVASEARCH_API_TOKEN']); fails({ PRIVASEARCH_PORT: '99999' }, ['PRIVASEARCH_PORT']); fails({ PRIVASEARCH_CONCURRENCY: '0' }, ['PRIVASEARCH_CONCURRENCY']);
  fails({ PRIVASEARCH_RECRAWL_MIN_MS: '999999999', PRIVASEARCH_RECRAWL_MAX_MS: '100000' }, ['PRIVASEARCH_RECRAWL_MIN_MS', 'PRIVASEARCH_RECRAWL_MAX_MS']);
});
