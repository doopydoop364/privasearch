import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Crawler } from '../src/driver.js';
import { DocumentStore } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { PrivaNetTransport } from '../src/privanet/privanet-transport.js';
import type { FetchRequest, FetchTransport } from '../src/privanet/transport.js';
import { startCore, startSite } from './core-rig.js';

/**
 * Measured crawl milestone: `node dist/tests/scale-crawl.js <pages> [hosts]` with PRIVANET_CORE_DIR set.
 * Crawls a synthetic local site (H virtual hosts, pages linked in a chain and a fan-out) through the whole
 * real path and prints one JSON report of what was measured. It never reaches the public internet; the public
 * one-URL proof is the `live-url` script.
 */
const core = process.env.PRIVANET_CORE_DIR; if (!core) throw new Error('PRIVANET_CORE_DIR must point at a built PrivaNet-Core checkout');
const pages = Number(process.argv[2] ?? 10); const hosts = Math.max(1, Number(process.argv[3] ?? Math.min(50, Math.ceil(pages / 10))));
const perHost = Math.ceil(pages / hosts);
const hostName = (h: number) => `s${h}.site.example`;
const hostMap = Object.fromEntries(Array.from({ length: hosts }, (_, h) => [hostName(h), '127.0.0.1']));
const words = ['alpine', 'harbour', 'lantern', 'meadow', 'quartz', 'saffron', 'tundra', 'velvet', 'willow', 'zephyr'];
const body = (h: number, i: number) => `Page ${i} of ${hostName(h)} discusses ${words[i % words.length]} and ${words[(i * 7 + h) % words.length]} with unique marker m${h}x${i}. ${'Lorem ipsum dolor sit amet. '.repeat(20)}`;

function rss(pid: number): number { try { return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024; } catch { return 0; } }
function cpuSeconds(pid: number): number { try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? []; return (Number(f[11]) + Number(f[12])) / 100; } catch { return 0; } }
const pct = (xs: number[], p: number) => xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

const site = await startSite((host, path) => {
  const m = /^s(\d+)\.site\.example$/.exec(host); if (!m) return undefined; const h = Number(m[1]);
  if (path === '/robots.txt') return { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' };
  const i = path === '/' ? 0 : Number(/^\/p(\d+)$/.exec(path)?.[1] ?? -1); if (i < 0 || i >= perHost) return undefined;
  const links = [i + 1, i * 2 + 1, i * 2 + 2].filter(n => n < perHost).map(n => `<a href="/p${n}">next</a>`).join('');
  return { body: `<!doctype html><html lang="en"><head><title>${words[i % words.length]} ${hostName(h)} ${i}</title><meta name="description" content="Synthetic page ${i}"></head><body><p>${body(h, i)}</p>${links}</body></html>` };
}, Number(process.env.SCALE_SITE_DELAY_MS ?? 0)); // per-request latency, to imitate a real network
const rig = await startCore(core, { hostMap, minHostDelayMs: Number(process.env.SCALE_HOST_DELAY_MS ?? 100), nodes: Number(process.env.SCALE_NODES ?? 1) });
const latencies: number[] = []; let payloadBytes = 0; let submitted = 0; let inFlightMax = 0; let inFlight = 0;
const inner = new PrivaNetTransport({ url: rig.url, tokens: rig.tokens, allowInsecureLoopback: true, pollMs: Number(process.env.SCALE_POLL_MS ?? 25) });
const transport: FetchTransport = { async fetch(request: FetchRequest) {
  const t0 = performance.now(); submitted++; inFlight++; inFlightMax = Math.max(inFlightMax, inFlight);
  try { const result = await inner.fetch(request); payloadBytes += Buffer.byteLength(JSON.stringify(result)); return result; }
  finally { inFlight--; latencies.push(performance.now() - t0); }
} };
const db = new DatabaseSync(':memory:'); const clock = () => Date.now();
const frontier = new Frontier(db, { hostDelayMs: Number(process.env.SCALE_HOST_DELAY_MS ?? 100), backoffBaseMs: 500 }); const documents = new DocumentStore(db);
const crawler = new Crawler({ frontier, documents, transport, clock, batch: Number(process.env.SCALE_BATCH ?? 32) });
for (let h = 0; h < hosts; h++) frontier.add(`http://${hostName(h)}/`, { queue: 'PUBLIC' }, clock());

const started = performance.now(); const cpu0 = { node: rig.pids.nodes.reduce((sum, pid) => sum + cpuSeconds(pid), 0), coordinator: cpuSeconds(rig.pids.coordinator) };
const totals = { outcomes: {} as Record<string, number>, indexed: 0, duplicates: 0, invalidResults: 0, transportErrors: 0 };
let peakNodeRss = 0; let peakCoordRss = 0;
const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), Number(process.env.SCALE_TIMEOUT_MS ?? 20 * 60000));
const sampler = setInterval(() => { peakNodeRss = Math.max(peakNodeRss, rig.pids.nodes.reduce((sum, pid) => sum + rss(pid), 0)); peakCoordRss = Math.max(peakCoordRss, rss(rig.pids.coordinator)); }, 250);
const mode = process.env.SCALE_MODE ?? 'pipeline'; // pipeline: continuous refill (Crawler.run); batch: one batch at a time (Crawler.runOnce)
if (mode === 'pipeline') {
  const s = await crawler.run({ concurrency: Number(process.env.SCALE_BATCH ?? 32), signal: deadline.signal, until: () => documents.count().documents >= pages });
  for (const [k, v] of Object.entries(s.outcomes)) totals.outcomes[k] = (totals.outcomes[k] ?? 0) + (v ?? 0);
  totals.indexed = s.indexed; totals.duplicates = s.duplicates; totals.invalidResults = s.invalidResults; totals.transportErrors = s.transportErrors;
} else {
  let idlePasses = 0;
  while (!deadline.signal.aborted && documents.count().documents < pages) {
    const s = await crawler.runOnce();
    for (const [k, v] of Object.entries(s.outcomes)) totals.outcomes[k] = (totals.outcomes[k] ?? 0) + (v ?? 0);
    totals.indexed += s.indexed; totals.duplicates += s.duplicates; totals.invalidResults += s.invalidResults; totals.transportErrors += s.transportErrors;
    if (s.submitted === 0) { idlePasses++; await new Promise(r => setTimeout(r, 25)); if (idlePasses > 4000) break; } else idlePasses = 0;
  }
}
clearTimeout(timer); clearInterval(sampler);
const seconds = (performance.now() - started) / 1000;
const count = documents.count(); const hit = documents.search('alpine').length;
const bytes = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
const report = {
  target: pages, hosts, perHost, mode, nodes: Number(process.env.SCALE_NODES ?? 1), slots: Number(process.env.SCALE_SLOTS ?? 1), siteDelayMs: Number(process.env.SCALE_SITE_DELAY_MS ?? 0), pollMs: Number(process.env.SCALE_POLL_MS ?? 25), batch: Number(process.env.SCALE_BATCH ?? 32), seconds: Math.round(seconds * 10) / 10, pagesPerMinute: Math.round(count.documents / seconds * 60),
  fetchesSubmitted: submitted, maxInFlight: inFlightMax, outcomes: totals.outcomes, documents: count, invalidResults: totals.invalidResults, transportErrors: totals.transportErrors,
  latencyMs: { p50: Math.round(pct(latencies, 0.5)), p95: Math.round(pct(latencies, 0.95)), max: Math.round(Math.max(0, ...latencies)) },
  avgResultBytes: submitted ? Math.round(payloadBytes / submitted) : 0, searchHitsForAlpine: hit,
  node: { cpuSeconds: Math.round((rig.pids.nodes.reduce((sum, pid) => sum + cpuSeconds(pid), 0) - cpu0.node) * 100) / 100, peakRssMiB: Math.round(peakNodeRss / 1048576) },
  coordinator: { cpuSeconds: Math.round((cpuSeconds(rig.pids.coordinator) - cpu0.coordinator) * 100) / 100, peakRssMiB: Math.round(peakCoordRss / 1048576), dbBytes: bytes(join(rig.dataDir, 'coordinator', 'coordinator.sqlite')) },
  siteRequests: site.requests.length, siteBytesServedApprox: site.requests.length * 1900,
  nodeLogEvents: Object.fromEntries(Object.entries(rig.logs.join('').split('\n').reduce<Record<string, number>>((a, l) => { const m = /"event":"([^"]+)"/.exec(l); if (m?.[1]) a[m[1]] = (a[m[1]] ?? 0) + 1; return a; }, {})).slice(0, 25)),
};
console.log(JSON.stringify(report, null, 2));
await rig.stop(); await site.close();
process.exit(count.documents >= pages && totals.invalidResults === 0 ? 0 : 1);
