import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.js';
import type { ServiceConfig } from '../src/service-config.js';
import { canBindPort80, startCore, startSite } from './core-rig.js';

/**
 * The real Coordinator is killed without warning (SIGKILL) in the middle of a crawl and started again. PrivaSearch must lose nothing: every page is
 * eventually indexed, no URL ends up failed because of the outage, and the crawler does not hammer a Coordinator that is down. Needs a built PrivaNet-Core
 * checkout (PRIVANET_CORE_DIR) and permission to listen on 127.0.0.1:80.
 */
const core = process.env.PRIVANET_CORE_DIR;
const skip = !core ? 'set PRIVANET_CORE_DIR to a built PrivaNet-Core checkout' : (await canBindPort80()) ? false : 'cannot listen on 127.0.0.1:80';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, ms = 60000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value !== undefined && value !== false) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
}
const PAGES = 40;
const html = (i: number) => `<!doctype html><html lang="en"><head><title>Outage page ${i}</title></head><body><p>outage test page number ${i} with some words</p>${[1, 2, 5].map(d => `<a href="/p${(i + d) % PAGES}">next</a>`).join('')}</body></html>`;

test('a Coordinator crash and restart in the middle of a crawl loses nothing: every page is indexed and no URL is marked failed', { skip, timeout: 240000 }, async t => {
  const site = await startSite((host, path) => host === 'crawl.example' && /^\/p\d+$/.test(path) && Number(path.slice(2)) < PAGES ? { body: html(Number(path.slice(2))) } : undefined, 40);
  const rig = await startCore(core as string, { hostMap: { 'crawl.example': '127.0.0.1' } });
  const dir = await mkdtemp(join(tmpdir(), 'privasearch-outage-')); t.after(async () => { await rig.stop(); await site.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined); });
  const config: ServiceConfig = {
    dbPath: join(dir, 'privasearch.sqlite'), host: '127.0.0.1', port: 0, concurrency: 6,
    privanet: { coordinatorUrl: rig.url, tokens: rig.tokens, allowInsecureLoopback: true, waitTimeoutMs: 30000, pollMs: 25 },
    seeds: ['http://crawl.example/p0'], templates: [], frontier: { hostDelayMs: 20, backoffBaseMs: 200, maxDepth: 60 },
    demand: { enabled: false, minStrong: 3, cooldownMs: 60000, maxCandidates: 12, maxPendingDemand: 300, maxQueriesPerHour: 30 }, shutdownMs: 5000, progressMs: 3600000 };
  const service = await startService(config, { log: () => undefined }); t.after(() => service.stop());
  await until('some pages indexed before the crash', () => service.documents.count().indexed >= 5);
  const before = service.documents.count().indexed;
  await rig.restartCoordinator(2500); // killed mid-crawl, down for 2.5 s, back with the same state
  await until('every page to be indexed after the restart', () => service.documents.count().indexed >= PAGES, 120000);
  await until('the frontier to settle', () => { const s = service.frontier.stats(); return s.PENDING === 0 && s.IN_FLIGHT === 0; });
  const stats = service.frontier.stats();
  assert.ok(before < PAGES, 'the crash really came in the middle of the crawl');
  assert.deepEqual([stats.FAILED, stats.BLOCKED, stats.DONE], [0, 0, PAGES], `nothing failed because of the outage: ${JSON.stringify(stats)}`);
  const fetched = site.requests.filter(r => r.path !== '/robots.txt').map(r => r.path);
  assert.equal(new Set(fetched).size, PAGES, 'every page was fetched');
  assert.ok(fetched.length <= PAGES + 6, `no page fetched more than a handful of extra times after the crash (${fetched.length} fetches for ${PAGES} pages)`);
});
