import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.js';
import type { Service } from '../src/service.js';
import type { ServiceConfig } from '../src/service-config.js';
import { realPathSkip, startCore, startSite } from './core-rig.js';

/**
 * The complete loop against the real thing: PrivaSearch service -> @privanet/sdk -> a real Coordinator -> a real, enrolled PrivaNode -> web.fetch.v1 ->
 * parse, index, link graph -> search. The pages come from a local site (the node owner's hostMap lets the node reach it; SSRF protection is not
 * weakened for anything else). It needs a built PrivaNet-Core checkout (PRIVANET_CORE_DIR) and permission to listen on 127.0.0.1:80.
 */
const core = process.env.PRIVANET_CORE_DIR;
const skip = await realPathSkip();

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value !== undefined && value !== false) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
}
const page = (title: string, body: string, links: string[] = []) => ({ body: `<!doctype html><html lang="en"><head><title>${title}</title></head><body><p>${body}</p>${links.map(l => `<a href="${l}">link</a>`).join('')}</body></html>` });

test('PrivaProxy-shaped search -> demand crawl -> real node -> index -> better results; background crawl; recrawl; restart', { skip, timeout: 180000 }, async t => {
  let weather = 'sunny skies and light winds'; // the one page that changes while the service runs
  const site = await startSite((host, path) => {
    if (host === 'crawl.example') switch (path) {
      case '/wiki/Alpine_hiking': return page('Alpine hiking', 'Alpine hiking routes cross the Alps, with huts and passes. More in the guides.', ['/routes', '/huts', 'http://trails.example/boots']);
      case '/routes': return page('Alpine hiking routes in the Alps', 'The best alpine hiking routes: ridge walks, passes and glacier trails.', ['/huts']);
      case '/huts': return page('Alpine hiking huts', 'Mountain huts for alpine hiking: booking, prices and seasons.');
      case '/seed': return page('Seed page', 'A seed page the operator configured, linking onward.', ['/discovered', '/weather']);
      case '/discovered': return page('Discovered page', 'Found by following a link, with nobody searching for it.');
      case '/weather': return page('Weather report', weather);
    }
    if (host === 'trails.example' && path === '/boots') return page('Hiking boots', 'How to pick boots for alpine hiking: the fit and the sole.');
    return undefined;
  });
  const rig = await startCore(core as string, { hostMap: { 'crawl.example': '127.0.0.1', 'trails.example': '127.0.0.1' } });
  const dir = await mkdtemp(join(tmpdir(), 'privasearch-e2e-')); t.after(async () => { await rig.stop(); await site.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined); });
  const config = (over: Partial<ServiceConfig> = {}): ServiceConfig => ({
    dbPath: join(dir, 'privasearch.sqlite'), host: '127.0.0.1', port: 0, concurrency: 4,
    privanet: { coordinatorUrl: rig.url, tokens: rig.tokens, allowInsecureLoopback: true, waitTimeoutMs: 30000, pollMs: 25 },
    seeds: [], templates: ['http://crawl.example/wiki/{title}'], frontier: { hostDelayMs: 50, backoffBaseMs: 200 },
    demand: { enabled: true, minStrong: 3, cooldownMs: 30 * 60000, maxCandidates: 12, maxPendingDemand: 300, maxQueriesPerHour: 30 }, shutdownMs: 5000, progressMs: 3600000, ...over });
  const search = async (s: Service, q: string) => (await (await fetch(`http://127.0.0.1:${s.port}/search?q=${encodeURIComponent(q)}`)).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const nodeJobs = () => rig.logs.join('').split('"event":"job.completed"').length - 1;
  const paths = () => site.requests.filter(r => r.path !== '/robots.txt').map(r => `${r.host}${r.path}`);
  const measured: Record<string, number> = {};

  // 1. A user searches an empty index: the answer is immediate, and demand crawling reaches the real node.
  const one = await startService(config({ seeds: ['http://crawl.example/seed'], frontier: { hostDelayMs: 50, backoffBaseMs: 200, recrawlMs: 2500, recrawlMinMs: 1000, recrawlMaxMs: 20000 } }), { log: () => undefined });
  const started = Date.now(); const first = await search(one, 'alpine hiking'); measured.firstAnswerMs = Date.now() - started;
  assert.deepEqual([first.total, first.index.state, first.crawl.triggered, first.crawl.state], [0, 'empty', true, 'scheduled']);
  await until('the first demand-crawled result', async () => (await search(one, 'alpine hiking')).total > 0); measured.firstResultMs = Date.now() - started;
  const ready = await until('strong results after discovery', async () => { const r = await search(one, 'alpine hiking'); return r.index.state === 'ready' ? r : undefined; }); measured.readyMs = Date.now() - started;
  assert.ok(ready.total >= 3 && ready.hits.every((h: { signals: { matchedTerms: number } }) => h.signals.matchedTerms === 2));
  assert.ok(paths().includes('crawl.example/wiki/Alpine_hiking')); assert.ok(nodeJobs() >= 3, `the real node completed ${nodeJobs()} fetch jobs`);

  // 2. Without anyone searching, the background crawler follows the seed and its links.
  await until('background pages', () => one.documents.count().indexed >= 7); assert.ok(paths().includes('crawl.example/discovered'));
  assert.deepEqual((await search(one, 'discovered link')).hits.map((h: { url: string }) => h.url)[0], 'http://crawl.example/discovered');
  // Every request the site saw carried the registered crawler identity, stamped by the Coordinator (nothing hard-coded in PrivaSearch).
  for (const r of site.requests) assert.equal(r.ua, `${rig.identity.product}/1.0 (+${rig.identity.infoUrl}; via PrivaNet)`);

  // 3. A page changes: it is refreshed on its interval and the index follows.
  assert.equal((await search(one, 'sunny')).total, 1); weather = 'storm clouds gathering over the ridge';
  await until('the changed page to be re-indexed', async () => (await search(one, 'storm clouds')).total === 1, 40000); measured.recrawlMs = Date.now() - started;
  assert.equal((await search(one, 'sunny')).total, 0); assert.ok((one.documents.get((await import('../src/url.js')).urlKey('http://crawl.example/weather'))?.changeCount ?? 0) >= 1);

  // 4. Restart: the index and the frontier survive; nothing fresh is fetched again.
  const docs = one.documents.count().indexed; await one.stop();
  const two = await startService(config({ frontier: { hostDelayMs: 50, backoffBaseMs: 200 } }), { log: () => undefined }); t.after(() => two.stop());
  assert.equal(two.documents.count().indexed, docs);
  const after = (await search(two, 'alpine hiking')); assert.equal(after.index.state, 'ready'); assert.equal(after.crawl.triggered, false);
  // Only URLs that are due within the window (the recrawl step above put every page on a short interval) may be fetched after the restart; nothing else is.
  const dueAtRestart = two.frontier.detail(Date.now() + 1600).recrawlDue + two.frontier.stats().PENDING + two.frontier.stats().IN_FLIGHT; const before = paths().length; await sleep(1500);
  assert.ok(paths().length - before <= dueAtRestart, `${paths().length - before} pages fetched after the restart, at most ${dueAtRestart} were due`);
  console.log(JSON.stringify({ event: 'e2e.measured', ...measured, nodeJobs: nodeJobs(), pagesIndexed: two.documents.count().indexed, siteRequests: site.requests.length }));
});
