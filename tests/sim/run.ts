import { simulate } from './simulate.js';
import type { SimOptions } from './simulate.js';

/**
 * `node dist/tests/sim/run.js [fetches]` prints the crawl-quality metrics for the synthetic web (the numbers in docs/crawl-quality.md come from this).
 * The same harness runs on the parent commit (it only needs Frontier.add, Crawler, DemandPlanner and Searcher), which is how the "before" numbers were taken.
 */
const fetches = Number(process.argv[2] ?? 600);
const wikiSeed = ['https://en.wiki.test/wiki/Main_Page']; const both = [...wikiSeed, 'https://mega.test/item/1'];
const scenarios: Array<[string, SimOptions]> = [
  ['A. one wiki seed, background only', { fetches, seeds: wikiSeed }],
  ['B. one wiki seed + a search for "chatgpt" after 2 pages', { fetches, seeds: wikiSeed, query: 'chatgpt', demandAfter: 2 }],
  ['C. wiki + giant single-language site, all languages allowed', { fetches, seeds: both, frontier: { preferredLanguages: ['*'] } }],
  ['D. as C but pipelined like the service: 8 in flight, 2 s per fetch, a lease attempt every 25 ms', { fetches, seeds: both, frontier: { preferredLanguages: ['*'] }, tickMs: 25, latencyMs: 2000, concurrency: 8 }],
];
for (const [name, options] of scenarios) {
  const m = await simulate(options); const { hostCounts, siteCounts, independentFirstSeen, ...summary } = m; void hostCounts;
  console.log(JSON.stringify({ scenario: name, ...summary, independentFirstSeen, siteCounts }));
}
