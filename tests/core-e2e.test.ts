import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Crawler } from '../src/driver.js';
import { DocumentStore } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { PrivaNetTransport } from '../src/privanet/privanet-transport.js';
import { realPathSkip, startCore, startSite } from './core-rig.js';

/**
 * The real path, end to end: PrivaSearch → @privanet/sdk → Coordinator → authenticated PrivaNode → web.fetch.v1 →
 * validated result → store and index → search hit. Needs a built PrivaNet-Core checkout (PRIVANET_CORE_DIR) and
 * permission to listen on 127.0.0.1:80 (PrivaSearch only crawls default ports); otherwise it is skipped, loudly.
 */
const core = process.env.PRIVANET_CORE_DIR;
const skip = await realPathSkip();

const HOST = 'site.example';
const page = (title: string, body: string, links: string[] = [], head = '') => ({ body: `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><p>${body}</p>${links.map(l => `<a href="${l}">l</a>`).join('')}</body></html>` });

test('one real crawl end to end through PrivaNet, then search, dedup, noindex and robots', { skip, timeout: 120000 }, async t => {
  const site = await startSite((host, path) => {
    if (host !== HOST) return undefined;
    switch (path) {
      case '/robots.txt': return { type: 'text/plain', body: 'User-agent: PrivaSearchBot\nDisallow: /private\n\nUser-agent: *\nDisallow: /\n' };
      case '/': return page('Alpine hiking guide', 'Trails huts and passes in the Alps.', ['/routes', '/copy', '/hidden', '/private', '/gone']);
      case '/routes': return page('Ridge routes', 'Ridge routes above the treeline.');
      case '/copy': return page('Ridge routes', 'Ridge routes above the treeline.'); // byte-identical body: a duplicate
      case '/hidden': return page('Hidden page', 'Secret quokka content.', [], '<meta name="robots" content="noindex">');
      case '/private': return page('Private', 'Should never be fetched.');
      default: return undefined;
    }
  });
  const rig = await startCore(core as string, { hostMap: { [HOST]: '127.0.0.1' } });
  t.after(async () => { await rig.stop(); await site.close(); });
  const db = new DatabaseSync(':memory:'); let now = Date.now();
  const frontier = new Frontier(db, { hostDelayMs: 0, backoffBaseMs: 100 }); const documents = new DocumentStore(db);
  const crawler = new Crawler({ frontier, documents, transport: new PrivaNetTransport({ url: rig.url, tokens: rig.tokens, allowInsecureLoopback: true, pollMs: 25 }), clock: () => now });

  assert.equal(frontier.add(`http://${HOST}/`, { queue: 'DEMAND' }, now), 'ADDED');
  const first = await crawler.runOnce();
  assert.deepEqual([first.submitted, first.outcomes.FETCHED, first.indexed, first.invalidResults, first.transportErrors], [1, 1, 1, 0, 0]);
  assert.deepEqual(documents.search('alps').map(h => h.url), [`http://${HOST}/`]); // the search hit
  for (let i = 0; i < 6; i++) { now += 1000; await crawler.runOnce(); }

  const ridge = documents.search('ridge routes').map(h => h.url); // byte-identical pages: whichever was fetched first is indexed, the other is kept as a duplicate
  assert.equal(ridge.length, 1); assert.ok([`http://${HOST}/routes`, `http://${HOST}/copy`].includes(ridge[0] ?? '')); assert.equal(documents.count().duplicates, 1);
  assert.deepEqual(documents.search('quokka'), []); // noindex: never in the index
  const seen = site.requests.filter(r => r.path !== '/robots.txt').map(r => r.path);
  assert.equal(seen.includes('/private'), false, 'robots.txt was enforced by the node at fetch time');
  assert.equal(frontier.getByUrl(`http://${HOST}/private`)?.last_outcome, 'ROBOTS_DISALLOWED');
  assert.equal(frontier.getByUrl(`http://${HOST}/gone`)?.last_http, 404);
  // The application identity came from the Coordinator's registry: every request carries the registered product and info URL.
  assert.ok(site.requests.length > 0);
  for (const request of site.requests) assert.equal(request.ua, `${rig.identity.product}/1.0 (+${rig.identity.infoUrl}; via PrivaNet)`);
});

test('an identity-less application cannot submit web.fetch.v1 and a dead Coordinator is a retryable infrastructure error', { skip, timeout: 60000 }, async t => {
  const rig = await startCore(core as string); t.after(() => rig.stop());
  const dead = new PrivaNetTransport({ url: 'http://127.0.0.1:9', tokens: rig.tokens, allowInsecureLoopback: true });
  await assert.rejects(dead.fetch({ input: { url: 'https://a.example/' }, idempotencyKey: 'crawl:x:0', queue: 'PUBLIC' }), (e: unknown) => (e as { code?: string }).code === 'UNAVAILABLE');
  const wrong = new PrivaNetTransport({ url: rig.url, tokens: { DEMAND: 'a'.repeat(64), PUBLIC: 'b'.repeat(64) }, allowInsecureLoopback: true });
  await assert.rejects(wrong.fetch({ input: { url: 'https://a.example/' }, idempotencyKey: 'crawl:x:1', queue: 'PUBLIC' }), (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN');
});

test('the crawl command: real process, real PrivaNet, seeds in, pages indexed, clean SIGTERM stop, and no credential or URL in its logs', { skip, timeout: 90000 }, async t => {
  const site = await startSite((host, path) => host !== HOST ? undefined
    : path === '/robots.txt' ? { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' }
    : path === '/' ? page('Lighthouse index', 'Coastal lighthouses of the north.', ['/a', '/b'])
    : path === '/a' ? page('Fresnel lens', 'A Fresnel lens focuses lighthouse light.') : path === '/b' ? page('Foghorn', 'A foghorn warns ships.') : undefined);
  const rig = await startCore(core as string, { hostMap: { [HOST]: '127.0.0.1' } });
  const dir = await mkdtemp(join(tmpdir(), 'privasearch-crawl-')); const dbPath = join(dir, 'crawl.sqlite');
  t.after(async () => { await rig.stop(); await site.close(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });
  const script = fileURLToPath(new URL('../src/crawl.js', import.meta.url)); const logs: string[] = [];
  const child = spawn(process.execPath, [script, `http://${HOST}/`], { env: { ...process.env, PRIVANET_COORDINATOR_URL: rig.url, PRIVANET_DEMAND_TOKEN: rig.tokens.DEMAND, PRIVANET_PUBLIC_TOKEN: rig.tokens.PUBLIC,
    PRIVASEARCH_ALLOW_INSECURE_LOOPBACK: 'true', PRIVASEARCH_DB: dbPath, PRIVASEARCH_CONCURRENCY: '4', PRIVASEARCH_POLL_MS: '20' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c: Buffer) => logs.push(c.toString())); child.stderr.on('data', (c: Buffer) => logs.push(c.toString()));
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  const deadline = Date.now() + 30000; let indexed = 0;
  while (Date.now() < deadline && indexed < 3) {
    await new Promise(resolve => setTimeout(resolve, 200));
    try { const db = new DatabaseSync(dbPath, { readOnly: true }); indexed = new DocumentStore(db).count().indexed; db.close(); } catch { /* the crawler has not created the database yet, or holds a write lock: retry */ }
  }
  child.kill('SIGTERM'); assert.equal(await exited, 0, 'stops cleanly on SIGTERM'); assert.equal(indexed, 3, 'the seed and both linked pages were indexed');
  const db = new DatabaseSync(dbPath); t.after(() => db.close());
  assert.deepEqual(new DocumentStore(db).search('fresnel').map(hit => hit.url), [`http://${HOST}/a`]);
  const text = logs.join(''); assert.match(text, /"event":"crawl.started"/); assert.match(text, /"event":"crawl.stopped"/);
  for (const secret of [rig.tokens.DEMAND, rig.tokens.PUBLIC, HOST]) assert.equal(text.includes(secret), false, 'neither credentials nor crawled URLs are logged');
});
