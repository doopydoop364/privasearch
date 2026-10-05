import { rig } from '../helpers.js';
import { createHash } from 'node:crypto';
import { Crawler } from '../../src/driver.js';
import { outcomeResult, pageResult } from '../../src/privanet/fake-transport.js';

/** Fixed one-hour workload, actual frontier/driver, no network or wall-clock dependence. */
export async function zeroYieldSimulation(badDomains: number, outcome: 'ROBOTS_DISALLOWED' | 'ROBOTS_UNAVAILABLE') {
  const r = rig(({ url }) => new URL(url).hostname.startsWith('bad')
    ? outcomeResult(outcome, url, r.time.now, { robots: { verdict: outcome === 'ROBOTS_UNAVAILABLE' ? 'UNAVAILABLE' : 'DISALLOWED' } })
    : pageResult(url, r.time.now, { title: 'Useful independent documentation', text: (`Independent documentation for ${url}. `).repeat(20) }, { contentSha256: createHash('sha256').update(url).digest('hex') }),
  { hostDelayMs: 2000, backoffBaseMs: 60000, maxUrlsPerHost: 10000 });
  for (let d = 0; d < badDomains + 2; d++) {
    const host = d < badDomains ? `bad${d}.test` : `healthy${d}.test`;
    for (let i = 0; i < 3000; i++) r.frontier.add(`https://${host}/article/${i}`, { queue: 'PUBLIC', source: 'discovered' }, r.time.now);
  }
  const crawler = new Crawler({ frontier: r.frontier, documents: r.documents, transport: r.transport, clock: () => r.time.now, batch: 1 });
  for (let i = 0; i < 1800; i++) { await crawler.runOnce(); r.advance(2000); }
  const calls = r.transport.calls; const wasted = calls.filter(c => new URL(c.input.url).hostname.startsWith('bad')).length;
  const result = { badDomains, outcome, hours: 1, attempts: calls.length, wasted, useful: r.documents.count().indexed, pending: r.frontier.stats().PENDING };
  r.db.close(); return result;
}
if (process.argv[1]?.endsWith('/zero-yield.js')) for (const domains of [1, 8]) for (const outcome of ['ROBOTS_DISALLOWED', 'ROBOTS_UNAVAILABLE'] as const) console.log(JSON.stringify(await zeroYieldSimulation(domains, outcome)));
