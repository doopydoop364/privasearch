import { simulate } from './simulate.js';

/** `node dist/tests/sim/run.js [fetches]` prints the crawl-quality metrics for the synthetic web (the numbers quoted in the changelog come from this). */
const fetches = Number(process.argv[2] ?? 600);
for (const [name, options] of [
  ['background only (one wiki seed)', { fetches }],
  ['wiki seed + search "chatgpt" after 2 pages', { fetches, query: 'chatgpt', demandAfter: 2 }],
] as const) {
  const m = await simulate(options); const { hostCounts, ...summary } = m; void hostCounts;
  console.log(JSON.stringify({ scenario: name, ...summary }));
}
