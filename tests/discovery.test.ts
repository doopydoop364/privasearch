import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { DemandPlanner } from '../src/demand.js';
import { openDatabase } from '../src/db.js';
import { discover, frontierSource, linkSource, queryIntent, urlSource } from '../src/discovery.js';
import { DocumentStore } from '../src/documents.js';
import type { DocumentInput } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { HttpDiscoveryProvider, pickUrls, validateProviderEndpoint } from '../src/provider.js';
import type { DiscoveryProvider } from '../src/provider.js';
import { Searcher } from '../src/ranking.js';
import { parseServiceConfig, ConfigError } from '../src/service-config.js';
import { urlKey } from '../src/url.js';

let n = 0;
const doc = (url: string, title: string, text: string): DocumentInput => ({ urlKey: urlKey(url), url, finalUrl: url, title, description: '', canonicalUrl: null, language: 'en', text, contentSha256: (++n).toString(16).padStart(64, '0'), fetchedAt: 1_000, httpStatus: 200 });
function rig(options: ConstructorParameters<typeof DemandPlanner>[3] = {}) {
  const db = openDatabase(':memory:'); const time = { now: 10_000_000 }; const documents = new DocumentStore(db); const frontier = new Frontier(db, { hostDelayMs: 0, preferredLanguages: ['*'] });
  const planner = new DemandPlanner(db, frontier, documents, { clock: () => time.now, templates: [], ...options }); const searcher = new Searcher(documents, () => time.now);
  return { db, time, documents, frontier, planner, search: (q: string) => planner.consider(q, searcher.search(q)) };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

async function stub(handler: (url: URL, headers: IncomingHttpHeaders, respond: (status: number, body: string, headers?: Record<string, string>) => void) => void): Promise<{ server: Server; endpoint: string; seen: Array<{ url: URL; headers: IncomingHttpHeaders }> }> {
  const seen: Array<{ url: URL; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => { const url = new URL(req.url ?? '/', 'http://x'); seen.push({ url, headers: req.headers }); handler(url, req.headers, (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return { server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`, seen };
}

test('query intent: a URL or domain typed as the query is its own candidate; a phrase is not guessed at', () => {
  assert.equal(queryIntent('chatgpt.com'), 'url'); assert.equal(queryIntent('https://example.org/a/b'), 'url'); assert.equal(queryIntent('rust programming'), 'informational'); assert.equal(queryIntent('chatgpt'), 'informational'); assert.equal(queryIntent('1.2.3'), 'informational');
  const r = rig({ sources: [urlSource] });
  assert.deepEqual([r.search('chatgpt.com').state, r.frontier.getByUrl('https://chatgpt.com/')?.queue], ['scheduled', 'DEMAND']); assert.equal(r.frontier.getByUrl('http://127.0.0.1/'), undefined);
  assert.equal(r.search('127.0.0.1').state, 'no_candidates'); // an IP literal is refused by URL admission, as everywhere
  assert.deepEqual(urlSource({ query: 'https://example.org/page?utm_source=x', db: r.db, documents: r.documents, terms: [], hits: [], limit: 5 }), ['https://example.org/page']);
});

test('local candidates are diverse: a giant site cannot fill a demand round, and its outward links come first', () => {
  const r = rig({ templates: [] });
  for (let i = 0; i < 40; i++) r.frontier.add(`https://en.wiki.example/wiki/Chatgpt_${i}`, { queue: 'PUBLIC', priority: 44, depth: 1, source: 'discovered' }, r.time.now);
  r.frontier.add('https://official.example/chatgpt', { queue: 'PUBLIC', priority: 44, depth: 1, source: 'discovered' }, r.time.now);
  const terms = ['chatgpt']; const ctx = { db: r.db, documents: r.documents, terms, hits: [], limit: 12 };
  const picked = discover([frontierSource], ctx); assert.ok(picked.filter(u => u.includes('wiki.example')).length <= 2, 'at most two per domain'); assert.ok(picked.includes('https://official.example/chatgpt') || picked.length >= 2);
  // linkSource: outward links of the best hit before its own site's
  r.documents.upsert({ ...doc('https://en.wiki.example/wiki/ChatGPT', 'ChatGPT', 'chatgpt article'), urlKey: urlKey('https://en.wiki.example/wiki/ChatGPT') });
  r.documents.setLinks(urlKey('https://en.wiki.example/wiki/ChatGPT'), 'en.wiki.example', [
    { key: urlKey('https://en.wiki.example/wiki/Nav1'), url: 'https://en.wiki.example/wiki/Nav1', host: 'en.wiki.example' }, { key: urlKey('https://en.wiki.example/wiki/Nav2'), url: 'https://en.wiki.example/wiki/Nav2', host: 'en.wiki.example' },
    { key: urlKey('https://other.example/review'), url: 'https://other.example/review', host: 'other.example' }]);
  const hits = new Searcher(r.documents, () => r.time.now).search('chatgpt').hits;
  assert.equal(linkSource({ db: r.db, documents: r.documents, terms, hits, limit: 12 })[0], 'https://other.example/review');
});

test('a provider only names URLs: the request is a plain GET with the query and nothing else, and what comes back is validated, deduplicated and bounded', async () => {
  const { server, endpoint, seen } = await stub((_u, _h, respond) => respond(200, JSON.stringify({ results: [
    { url: 'https://a.example/1' }, { url: 'https://a.example/2' }, { url: 'https://a.example/3' }, { url: 'https://b.example/' }, { url: 'ftp://nope.example/' }, { url: 'http://127.0.0.1/admin' }, { url: 'https://b.example/' }, { title: 'no url' }, 'https://c.example/x', 42 ] })));
  try {
    const p = new HttpDiscoveryProvider({ endpoint }); const urls = await p.discover('secret words here', 10);
    assert.deepEqual(urls, ['https://a.example/1', 'https://a.example/2', 'https://b.example/', 'https://c.example/x']); // 2 per domain, invalid/internal/duplicate dropped
    const req = seen[0]!; assert.equal(req.url.searchParams.get('q'), 'secret words here'); assert.equal(req.url.searchParams.get('format'), 'json');
    for (const forbidden of ['authorization', 'cookie', 'x-api-key', 'x-forwarded-for', 'referer', 'proxy-authorization']) assert.equal(req.headers[forbidden], undefined, forbidden);
    assert.equal(req.headers['user-agent'], 'PrivaSearch-discovery'); assert.deepEqual([...req.url.searchParams.keys()].sort(), ['format', 'q']);
    assert.deepEqual(await p.discover('x', 1), ['https://a.example/1']);
  } finally { server.close(); }
});

test('a provider that misbehaves is bounded: oversize, non-JSON, redirect, error status and a slow answer all fail without a result', async () => {
  const big = await stub((_u, _h, respond) => respond(200, JSON.stringify({ results: [], pad: 'x'.repeat(5000) }))); const text = await stub((_u, _h, respond) => respond(200, 'hello', { 'content-type': 'text/html' }));
  const redirect = await stub((_u, _h, respond) => respond(302, '', { location: 'http://127.0.0.1:1/elsewhere' })); const bad = await stub((_u, _h, respond) => respond(500, '{}')); const slow = await stub(() => { /* never answers */ });
  try {
    await assert.rejects(new HttpDiscoveryProvider({ endpoint: big.endpoint, maxBytes: 1000 }).discover('q', 5), /too large/); await assert.rejects(new HttpDiscoveryProvider({ endpoint: text.endpoint }).discover('q', 5), /JSON/);
    await assert.rejects(new HttpDiscoveryProvider({ endpoint: redirect.endpoint }).discover('q', 5)); await assert.rejects(new HttpDiscoveryProvider({ endpoint: bad.endpoint }).discover('q', 5), /status 500/);
    await assert.rejects(new HttpDiscoveryProvider({ endpoint: slow.endpoint, timeoutMs: 100 }).discover('q', 5)); assert.equal(redirect.seen.length, 1, 'the redirect was not followed');
  } finally { for (const s of [big, text, redirect, bad, slow]) { s.server.closeAllConnections(); s.server.close(); } }
});

test('provider endpoints: https, or http to a loopback address only; no credentials, no query string', () => {
  for (const ok of ['https://search.example/search', 'http://127.0.0.1:8080/search', 'http://localhost/s']) assert.doesNotThrow(() => validateProviderEndpoint(ok), ok);
  for (const bad of ['http://search.example/search', 'ftp://x.example/', 'https://user:pw@search.example/', 'https://search.example/s?key=abc', 'nonsense', 'http://192.168.1.5/s']) assert.throws(() => validateProviderEndpoint(bad), Error, bad);
  assert.deepEqual(pickUrls({ urls: ['https://a.example/'] }, 5), ['https://a.example/']); assert.deepEqual(pickUrls(['https://a.example/', { url: 'https://b.example/' }], 5), ['https://a.example/', 'https://b.example/']); assert.deepEqual(pickUrls('nope', 5), []);
});

test('configuration: a provider needs the explicit acknowledgement that queries leave PrivaSearch, and the endpoint is never echoed', () => {
  const secret = 'https://search.example/s3cr3t-path';
  assert.throws(() => parseServiceConfig({ PRIVASEARCH_DISCOVERY_PROVIDER_URL: secret }), (e: unknown) => e instanceof ConfigError && e.names[0] === 'PRIVASEARCH_DISCOVERY_PROVIDER_SEND_QUERIES' && !e.message.includes('s3cr3t'));
  assert.throws(() => parseServiceConfig({ PRIVASEARCH_DISCOVERY_PROVIDER_SEND_QUERIES: 'true' }), ConfigError);
  assert.throws(() => parseServiceConfig({ PRIVASEARCH_DISCOVERY_PROVIDER_URL: 'http://search.example/s3cr3t', PRIVASEARCH_DISCOVERY_PROVIDER_SEND_QUERIES: 'true' }), (e: unknown) => e instanceof ConfigError && !e.message.includes('s3cr3t'));
  assert.equal(parseServiceConfig({}).provider, undefined); // off by default
  const on = parseServiceConfig({ PRIVASEARCH_DISCOVERY_PROVIDER_URL: secret, PRIVASEARCH_DISCOVERY_PROVIDER_SEND_QUERIES: 'true', PRIVASEARCH_DISCOVERY_PROVIDER_MAX_PER_HOUR: '5' }); assert.deepEqual([on.provider?.maxPerHour, on.provider?.timeoutMs], [5, 5000]);
});

test('the planner asks the provider only for a weak search that is being scheduled, never for a strong one, never beyond the hourly cap, and a failing provider changes nothing', async () => {
  const asked: string[] = []; let fail = false; const outcomes: Array<{ ok: boolean; named: number; added: number }> = [];
  const provider: DiscoveryProvider = { name: 'spy', async discover(query) { asked.push(query); if (fail) throw new Error('boom with the query inside'); return ['https://named.example/page', 'https://named.example/other', 'https://third.example/']; } };
  const r = rig({ provider, providerMaxPerHour: 2, onProvider: o => outcomes.push(o), maxCandidates: 5 });
  for (let i = 0; i < 3; i++) r.documents.upsert(doc(`https://s${i}.example/p`, 'Sourdough starter guide', `How to keep a sourdough starter alive, part ${i}.`));
  assert.equal(r.search('sourdough starter').state, 'none'); await tick(); assert.deepEqual(asked, []); // strong: no provider
  const weak = r.search('quantum gardening'); await tick(); assert.deepEqual([weak.state, asked], ['no_candidates', ['quantum gardening']]); // the planner itself named nothing; the provider did
  assert.equal(r.frontier.getByUrl('https://named.example/page')?.queue, 'DEMAND'); assert.equal(r.frontier.getByUrl('https://named.example/page')?.source, 'provider'); assert.deepEqual(outcomes, [{ ok: true, named: 3, added: 3 }]);
  r.time.now += 3 * 3600000; fail = true; const again = r.search('quantum gardening'); await tick(); assert.equal(asked.length, 2); assert.deepEqual(outcomes[1], { ok: false, named: 0, added: 0 }); assert.notEqual(again.state, 'disabled');
  r.time.now += 100 * 3600000; for (const q of ['another weak query', 'a third weak query', 'a fourth weak query']) { r.search(q); await tick(); } assert.equal(asked.length, 4, 'the hourly cap of 2 held: two of the three searches in this hour reached the provider');
  const stored = JSON.stringify(r.db.prepare('SELECT * FROM queries').all()); assert.equal(stored.includes('quantum'), false, 'the query is never stored as text');
});

test('without a provider nothing is ever sent anywhere and local discovery behaves as before', () => {
  const r = rig({ templates: ['https://wiki.example/wiki/{title}'] }); const result = r.search('rust language'); assert.equal(result.state, 'scheduled'); assert.equal(r.frontier.getByUrl('https://wiki.example/wiki/Rust_language')?.queue, 'DEMAND');
});
