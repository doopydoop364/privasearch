import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DemandPlanner } from '../src/demand.js';
import { openDatabase } from '../src/db.js';
import { DocumentStore } from '../src/documents.js';
import type { DocumentInput } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { createSearchServer } from '../src/server.js';
import { urlKey } from '../src/url.js';

let n = 0;
const doc = (url: string, title: string, text: string): DocumentInput =>
  ({ urlKey: urlKey(url), url, finalUrl: url, title, description: '', canonicalUrl: null, language: 'en', text, contentSha256: (++n).toString(16).padStart(64, '0'), fetchedAt: 5_000, httpStatus: 200 });

async function serve(t: { after(fn: () => void): void }, options: { token?: string; planner?: boolean } = {}) {
  const db = openDatabase(':memory:'); const documents = new DocumentStore(db); const frontier = new Frontier(db, { hostDelayMs: 0 });
  const planner = options.planner === false ? undefined : new DemandPlanner(db, frontier, documents, { templates: ['https://wiki.example/wiki/{title}'] });
  const server = createSearchServer({ documents, frontier, ...(planner ? { planner } : {}), ...(options.token ? { apiToken: options.token } : {}), version: '0.4.0-test', crawling: () => true });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, headers: Record<string, string> = {}) => { const res = await fetch(base + path, { headers }); return { status: res.status, headers: res.headers, body: await res.json() as Record<string, any> }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { documents, frontier, planner, get, base };
}

test('the response is structured JSON with ranked hits, relevance signals, index state and crawl state', async t => {
  const s = await serve(t);
  for (let i = 0; i < 4; i++) s.documents.upsert(doc(`https://h${i}.example/p`, 'Sourdough starter guide', `sourdough starter care, part ${i}`));
  const { status, body, headers } = await s.get('/search?q=sourdough%20starter');
  assert.equal(status, 200); assert.match(headers.get('content-type') ?? '', /application\/json/); assert.equal(headers.get('cache-control'), 'no-store');
  assert.deepEqual([body.apiVersion, body.query, body.total, body.offset, body.limit], [1, 'sourdough starter', 4, 0, 10]);
  assert.deepEqual(Object.keys(body.hits[0]).sort(), ['fetchedAt', 'host', 'lastChangedAt', 'score', 'signals', 'snippet', 'title', 'url']);
  assert.deepEqual(Object.keys(body.hits[0].signals).sort(), ['freshness', 'inboundHosts', 'matchedTerms', 'phraseMatch', 'relevance', 'titleMatch', 'totalTerms', 'urlMatch']);
  assert.deepEqual(body.index, { state: 'ready', documents: 4 }); assert.deepEqual(body.crawl, { triggered: false, state: 'none', candidates: 0 });
  assert.equal(JSON.stringify(body).includes('token'), false);
});

test('an empty index answers immediately and starts demand crawling; the second search is on cooldown', async t => {
  const s = await serve(t);
  const first = await s.get('/search?q=quantum%20widgets');
  assert.deepEqual([first.body.total, first.body.hits, first.body.index.state, first.body.crawl.triggered, first.body.crawl.state, first.body.crawl.candidates], [0, [], 'empty', true, 'scheduled', 1]);
  assert.equal(s.frontier.getByUrl('https://wiki.example/wiki/Quantum_widgets')?.queue, 'DEMAND');
  const second = await s.get('/search?q=Quantum%20Widgets');
  assert.deepEqual([second.body.crawl.triggered, second.body.crawl.state], [false, 'cooldown']); assert.ok(second.body.crawl.retryAfterSec > 0);
  assert.equal(s.frontier.stats().PENDING, 1);
});

test('partial coverage is reported as partial, and fills in once the pages arrive', async t => {
  const s = await serve(t);
  s.documents.upsert(doc('https://a.example/1', 'Alpine flowers', 'flowers of the Alps'));
  const partial = await s.get('/search?q=alpine%20hiking%20routes'); assert.deepEqual([partial.body.index.state, partial.body.crawl.state, partial.body.hits.length], ['partial', 'scheduled', 1]);
  for (let i = 0; i < 3; i++) s.documents.upsert(doc(`https://r${i}.example/1`, 'Alpine hiking routes', `routes for hiking in the Alps, ${i}`));
  const better = await s.get('/search?q=alpine%20hiking%20routes'); assert.equal(better.body.index.state, 'ready'); assert.equal(better.body.hits[0].signals.matchedTerms, 3);
});

test('pagination: limit and offset are bounded, pages tile the results, and later pages never start crawling', async t => {
  const s = await serve(t);
  for (let i = 0; i < 12; i++) s.documents.upsert(doc(`https://p${i}.example/1`, 'Mango dessert', `mango dessert recipe ${i}`));
  const a = await s.get('/search?q=mango&limit=5&offset=0'); const b = await s.get('/search?q=mango&limit=5&offset=5'); const c = await s.get('/search?q=mango&limit=5&offset=10');
  assert.deepEqual([a.body.total, a.body.hits.length, b.body.hits.length, c.body.hits.length], [12, 5, 5, 2]);
  assert.equal(new Set([...a.body.hits, ...b.body.hits, ...c.body.hits].map((h: { url: string }) => h.url)).size, 12);
  assert.equal((await s.get('/search?q=mango&limit=9999')).body.limit, 50); assert.equal((await s.get('/search?q=mango&limit=abc&offset=-3')).body.offset, 0);
  const deep = await s.get('/search?q=nothing%20indexed%20here&offset=10'); assert.deepEqual([deep.body.crawl.triggered, deep.body.crawl.state], [false, 'none']); assert.equal(s.frontier.stats().PENDING, 0);
});

test('without a planner the API still searches and says crawling is disabled', async t => {
  const s = await serve(t, { planner: false });
  const { body } = await s.get('/search?q=anything'); assert.deepEqual(body.crawl, { triggered: false, state: 'disabled', candidates: 0 });
});

test('input is bounded and the surface is small: GET only, bad queries refused, unknown paths 404', async t => {
  const s = await serve(t);
  assert.equal((await s.get('/search')).status, 400); assert.equal((await s.get('/search?q=' + 'x'.repeat(201))).status, 400); assert.equal((await s.get('/nope')).status, 404);
  assert.equal((await fetch(`${s.base}/search?q=x`, { method: 'POST' })).status, 405);
});

test('an API token protects /search and /status, compares in constant time, and leaves /health open', async t => {
  const token = 'a'.repeat(48); const s = await serve(t, { token });
  assert.equal((await s.get('/health')).status, 200);
  for (const path of ['/search?q=x', '/status']) {
    assert.equal((await s.get(path)).status, 401);
    assert.equal((await s.get(path, { authorization: 'Bearer wrong' })).status, 401); assert.equal((await s.get(path, { authorization: `Bearer ${'a'.repeat(47)}` })).status, 401);
    assert.equal((await s.get(path, { authorization: token })).status, 401); // the scheme is required
    assert.equal((await s.get(path, { authorization: `Bearer ${token}` })).status, 200);
  }
  const denied = await s.get('/search?q=x'); assert.equal(denied.headers.get('www-authenticate'), 'Bearer'); assert.deepEqual(denied.body, { error: 'UNAUTHORIZED' });
});

test('/status reports counters for operators and never URLs or queries; /health reports liveness', async t => {
  const s = await serve(t);
  s.documents.upsert(doc('https://a.example/secret-looking-path', 'T', 'text')); await s.get('/search?q=very%20secret%20query');
  const status = (await s.get('/status')).body;
  assert.deepEqual(Object.keys(status).sort(), ['apiVersion', 'crawling', 'demand', 'documents', 'frontier', 'generatedAtMs', 'uptimeSec']);
  assert.equal(status.demand.queries, 1); assert.equal(status.frontier.pendingDemand, 1); assert.equal(status.documents.documents, 1);
  const text = JSON.stringify(status); assert.equal(text.includes('secret'), false);
  const health = (await s.get('/health')).body; assert.deepEqual([health.status, health.version, health.crawling, health.documents], ['ok', '0.4.0-test', true, 1]);
});
