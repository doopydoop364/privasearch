import { DemandPlanner } from '../../src/demand.js';
import { Searcher } from '../../src/ranking.js';
import { SEED_PRIORITY } from '../../src/policy.js';
import { rig } from '../helpers.js';
import { INDEPENDENT, siteOf, syntheticWeb } from './web.js';

export interface SimOptions { fetches: number; seeds?: string[]; query?: string; demandAfter?: number }
export interface SimMetrics {
  fetches: number; sites: number; independentSites: number; topSite: string; topSiteShare: number; wikiLanguageHosts: number;
  firstIndependentFetch: number | null; pendingByTopSite: number; pendingTotal: number; pendingWikiShare: number; indexed: number; hostCounts: Record<string, number>;
}

/**
 * Runs the real Crawler, Frontier, DemandPlanner and Searcher against the synthetic web on a fake clock. A search for the query is made once
 * `demandAfter` pages are indexed (the weak-result path then schedules demand crawling), exactly as a user's search would.
 */
export async function simulate(options: SimOptions): Promise<SimMetrics> {
  const web = syntheticWeb();
  const r = rig(web.respond as never, { hostDelayMs: 1000, maxUrlsPerHost: 2000 });
  const planner = new DemandPlanner(r.db, r.frontier, r.documents, { clock: () => r.time.now, templates: ['https://en.wiki.test/wiki/{title}'] });
  const searcher = new Searcher(r.documents, () => r.time.now);
  for (const seed of options.seeds ?? ['https://en.wiki.test/wiki/Main_Page']) r.frontier.add(seed, { queue: 'PUBLIC', priority: SEED_PRIORITY, source: 'seed' }, r.time.now);
  let searched = false; let firstIndependent: number | null = null; let done = 0;
  while (done < options.fetches) {
    if (!searched && options.query && done >= (options.demandAfter ?? 0)) { searched = true; planner.consider(options.query, searcher.search(options.query)); }
    const before = web.fetched.length;
    await r.crawler.runOnce();
    const got = web.fetched.length - before;
    if (got === 0) r.advance(1000); else { done += got; r.advance(1000); }
    if (firstIndependent === null) { const i = web.fetched.findIndex(h => INDEPENDENT.includes(siteOf(h))); if (i >= 0) firstIndependent = i + 1; }
    if (got === 0 && done === 0) break;
  }
  const hostCounts: Record<string, number> = {}; for (const h of web.fetched) hostCounts[h] = (hostCounts[h] ?? 0) + 1;
  const siteCounts = new Map<string, number>(); for (const h of web.fetched) siteCounts.set(siteOf(h), (siteCounts.get(siteOf(h)) ?? 0) + 1);
  const top = [...siteCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const pending = r.db.prepare(`SELECT host, COUNT(*) AS n FROM urls WHERE state='PENDING' GROUP BY host`).all() as unknown as Array<{ host: string; n: number }>;
  const pendingTotal = pending.reduce((a, p) => a + Number(p.n), 0); const pendingWiki = pending.filter(p => siteOf(p.host) === 'wiki.test').reduce((a, p) => a + Number(p.n), 0);
  const indexed = Number((r.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n);
  return {
    fetches: web.fetched.length, sites: siteCounts.size, independentSites: [...siteCounts.keys()].filter(s => INDEPENDENT.includes(s)).length, topSite: String(top[0]), topSiteShare: Number(top[1]) / Math.max(1, web.fetched.length),
    wikiLanguageHosts: Object.keys(hostCounts).filter(h => siteOf(h) === 'wiki.test').length, firstIndependentFetch: firstIndependent, pendingByTopSite: pendingWiki, pendingTotal,
    pendingWikiShare: pendingTotal === 0 ? 0 : pendingWiki / pendingTotal, indexed, hostCounts,
  };
}
