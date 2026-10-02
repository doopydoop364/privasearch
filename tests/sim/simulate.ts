import { DemandPlanner } from '../../src/demand.js';
import { Searcher } from '../../src/ranking.js';
import { SEED_PRIORITY } from '../../src/policy.js';
import type { FrontierOptions } from '../../src/frontier.js';
import { rig } from '../helpers.js';
import { GIANT, INDEPENDENT, siteOf, syntheticWeb } from './web.js';

export interface SimOptions {
  fetches: number; seeds?: string[]; query?: string; demandAfter?: number;
  /** Frontier options (policy knobs, host delay). */
  frontier?: FrontierOptions;
  /** Milliseconds of fake time between lease attempts (the service re-leases about every 25 ms; the default 1000 matches the host delay). */
  tickMs?: number;
  /** Pipelined mode: every fetch stays in flight for this many fake milliseconds and up to `concurrency` run at once (the real service), instead of one synchronous pass per tick. */
  latencyMs?: number; concurrency?: number;
}
export interface SimMetrics {
  fetches: number; sites: number; independentSites: number; topSite: string; topSiteShare: number; giantShareFirst100: number; topSiteShareFirst100: number;
  wikiLanguageHosts: number; firstIndependentFetch: number | null; independentFirstSeen: Record<string, number>; pendingByTopSite: number; pendingTotal: number; pendingTopShare: number;
  indexed: number; hostCounts: Record<string, number>; siteCounts: Record<string, number>;
}

/**
 * Runs the real Crawler, Frontier, DemandPlanner and Searcher against the synthetic web on a fake clock. A search for the query is made once
 * `demandAfter` pages are indexed (the weak-result path then schedules demand crawling), exactly as a user's search would.
 */
export async function simulate(options: SimOptions): Promise<SimMetrics> {
  const web = syntheticWeb(); const tick = options.tickMs ?? 1000;
  const gates: Array<{ at: number; open: () => void }> = []; let clockNow = () => 0;
  const respond = options.latencyMs === undefined ? web.respond : (input: { url: string }) => new Promise(resolve => { gates.push({ at: clockNow() + (options.latencyMs ?? 0), open: () => resolve(web.respond(input)) }); });
  const r = rig(respond as never, { hostDelayMs: 1000, maxUrlsPerHost: 2000, ...options.frontier });
  const planner = new DemandPlanner(r.db, r.frontier, r.documents, { clock: () => r.time.now, templates: ['https://en.wiki.test/wiki/{title}'] });
  const searcher = new Searcher(r.documents, () => r.time.now);
  for (const seed of options.seeds ?? ['https://en.wiki.test/wiki/Main_Page']) r.frontier.add(seed, { queue: 'PUBLIC', priority: SEED_PRIORITY, source: 'seed' }, r.time.now);
  clockNow = () => r.time.now; let searched = false;
  const summary = { submitted: 0, outcomes: {}, indexed: 0, duplicates: 0, discovered: 0, invalidResults: 0, transportErrors: 0, trapped: 0, changed: 0 };
  const crawl = (r.crawler as unknown as { crawl(item: unknown, summary: unknown): Promise<void> }).crawl.bind(r.crawler);
  const active = new Set<Promise<void>>(); const concurrency = options.concurrency ?? 8; const answered = () => web.fetched.length;
  for (let guard = 0; answered() < options.fetches && guard < 200000; guard++) {
    if (!searched && options.query && answered() >= (options.demandAfter ?? 0)) { searched = true; planner.consider(options.query, searcher.search(options.query)); }
    if (options.latencyMs === undefined) await r.crawler.runOnce();
    else {
      for (const item of r.frontier.lease(r.time.now, concurrency - active.size)) { const task: Promise<void> = crawl(item, summary).finally(() => active.delete(task)); active.add(task); }
      for (const gate of gates.splice(0).filter(g => { if (g.at > r.time.now) { gates.push(g); return false; } return true; })) gate.open();
      await new Promise(resolve => setImmediate(resolve));
    }
    r.advance(tick);
  }
  while (active.size > 0) { for (const gate of gates.splice(0)) gate.open(); await new Promise(resolve => setImmediate(resolve)); } // let the fetches still in flight finish
  const hostCounts: Record<string, number> = {}; for (const h of web.fetched) hostCounts[h] = (hostCounts[h] ?? 0) + 1;
  const siteCounts: Record<string, number> = {}; for (const h of web.fetched) siteCounts[siteOf(h)] = (siteCounts[siteOf(h)] ?? 0) + 1;
  const first = web.fetched.slice(0, 100); const shareOf = (sites: string[]) => first.filter(h => sites.includes(siteOf(h))).length / Math.max(1, first.length);
  const top = Object.entries(siteCounts).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const independentFirstSeen: Record<string, number> = {};
  web.fetched.forEach((h, i) => { const s = siteOf(h); if (INDEPENDENT.includes(s) && independentFirstSeen[s] === undefined) independentFirstSeen[s] = i + 1; });
  // Counted from `urls` by host, so the same harness runs against the parent commit (which has no domain tables).
  const pendingBySite: Record<string, number> = {}; for (const p of r.db.prepare(`SELECT host, COUNT(*) AS n FROM urls WHERE state='PENDING' GROUP BY host`).all() as unknown as Array<{ host: string; n: number }>) pendingBySite[siteOf(p.host)] = (pendingBySite[siteOf(p.host)] ?? 0) + Number(p.n);
  const pendingTotal = Object.values(pendingBySite).reduce((a, b) => a + b, 0); const pendingTop = Math.max(0, ...Object.values(pendingBySite)); const pendingWiki = pendingBySite['wiki.test'] ?? 0;
  const indexed = Number((r.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n);
  return {
    fetches: web.fetched.length, sites: Object.keys(siteCounts).length, independentSites: Object.keys(siteCounts).filter(s => INDEPENDENT.includes(s)).length, topSite: String(top[0]), topSiteShare: Number(top[1]) / Math.max(1, web.fetched.length),
    giantShareFirst100: shareOf(GIANT), topSiteShareFirst100: Math.max(0, ...Object.keys(siteCounts).map(s => shareOf([s]))),
    wikiLanguageHosts: Object.keys(hostCounts).filter(h => siteOf(h) === 'wiki.test').length,
    firstIndependentFetch: Math.min(...Object.values(independentFirstSeen), Infinity) === Infinity ? null : Math.min(...Object.values(independentFirstSeen)), independentFirstSeen,
    pendingByTopSite: pendingWiki, pendingTotal, pendingTopShare: pendingTotal === 0 ? 0 : pendingTop / pendingTotal, indexed, hostCounts, siteCounts,
  };
}
