import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Crawler } from '../src/driver.js';
import { DocumentStore } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { PrivaNetTransport } from '../src/privanet/privanet-transport.js';
import { canBindPort80, startCore, startSite } from './core-rig.js';

/**
 * The real path, end to end: PrivaSearch → @privanet/sdk → Coordinator → authenticated PrivaNode → web.fetch.v1 →
 * validated result → store and index → search hit. Needs a built PrivaNet-Core checkout (PRIVANET_CORE_DIR) and
 * permission to listen on 127.0.0.1:80 (PrivaSearch only crawls default ports); otherwise it is skipped, loudly.
 */
const core = process.env.PRIVANET_CORE_DIR;
const skip = !core ? 'set PRIVANET_CORE_DIR to a built PrivaNet-Core checkout' : (await canBindPort80()) ? false : 'cannot listen on 127.0.0.1:80';

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
