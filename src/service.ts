import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DemandPlanner } from './demand.js';
import { openDatabase } from './db.js';
import { Crawler } from './driver.js';
import { DocumentStore } from './documents.js';
import { Frontier } from './frontier.js';
import { SEED_PRIORITY } from './policy.js';
import { PrivaNetTransport } from './privanet/privanet-transport.js';
import type { FetchTransport } from './privanet/transport.js';
import { Searcher } from './ranking.js';
import { createSearchServer } from './server.js';
import type { ServiceConfig } from './service-config.js';

/**
 * The long-running PrivaSearch service: one process that serves the search API, runs the background crawler, and (when a search is weak)
 * schedules demand crawling, all over one SQLite database. It is the only thing an operator needs to keep running.
 *
 *   search API --(weak results)--> demand planner --> frontier <--(seeds, discovered links, recrawls)-- background crawler
 *                                                        |
 *                       crawler --> PrivaNetTransport --> @privanet/sdk --> Coordinator --> PrivaNode (web.fetch.v1)
 *                          |
 *                          +--> parse, normalise, index, link graph --> back into the frontier
 *
 * Every fetch, for a user's search and for the background crawl alike, goes through PrivaNet. There is no local fast path, even when the only
 * node is on this machine. The service survives restarts (frontier, index and the demand ledger are in the database; leases held by the previous
 * process are returned at start), Coordinator restarts and node reconnects (the crawler's pipeline backoff and idempotency keys), and shuts down
 * gracefully: it stops accepting searches, lets submitted fetches finish for up to `shutdownMs`, then gives up on the rest and returns their URLs to
 * the frontier.
 *
 * Logs are JSON lines with event names and aggregate counts only: never a URL, a query or a credential.
 */
export interface ServiceDeps { transport?: FetchTransport; clock?: () => number; log?: (event: Record<string, unknown>) => void; version?: string }
export interface Service {
  readonly port: number; readonly host: string;
  readonly documents: DocumentStore; readonly frontier: Frontier; readonly planner: DemandPlanner | undefined; readonly crawler: Crawler | undefined;
  readonly searcher: Searcher;
  /** Resolves when the HTTP server and the crawler have stopped and the database is closed. Safe to call more than once. */
  stop(): Promise<void>;
}

/** The version from package.json: two levels up in a checkout (dist/src/), one level up in a release archive (dist/). */
function packageVersion(): string | undefined {
  for (const path of ['../../package.json', '../package.json']) {
    try { const parsed = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { name?: string; version?: string }; if (parsed.name === 'privasearch') return parsed.version; } catch { /* try the next place */ }
  }
  return undefined;
}

export async function startService(config: ServiceConfig, deps: ServiceDeps = {}): Promise<Service> {
  const clock = deps.clock ?? Date.now; const log = deps.log ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event)));
  const version = deps.version ?? packageVersion();
  const db = openDatabase(config.dbPath);
  const documents = new DocumentStore(db); const frontier = new Frontier(db, config.frontier); const searcher = new Searcher(documents, clock);
  const transport = deps.transport ?? (config.privanet ? new PrivaNetTransport({ url: config.privanet.coordinatorUrl, tokens: config.privanet.tokens, allowInsecureLoopback: config.privanet.allowInsecureLoopback,
    waitTimeoutMs: config.privanet.waitTimeoutMs, pollMs: config.privanet.pollMs }) : undefined);

  // Nothing can still be in flight in a process that just started: take back the leases the previous process held.
  const reclaimed = frontier.requeueAll();
  let seedsAdded = 0; let seedsRejected = 0;
  for (const seed of config.seeds) { const result = frontier.add(seed, { queue: 'PUBLIC', priority: SEED_PRIORITY, source: 'seed' }, clock()); if (result === 'ADDED') seedsAdded++; else if (result !== 'EXISTS') seedsRejected++; }

  const planner = transport && config.demand.enabled
    ? new DemandPlanner(db, frontier, documents, { clock, templates: config.templates, minStrong: config.demand.minStrong, cooldownMs: config.demand.cooldownMs, maxCandidates: config.demand.maxCandidates,
      maxPendingDemand: config.demand.maxPendingDemand, maxQueriesPerHour: config.demand.maxQueriesPerHour }) : undefined;
  // The query ledger holds one row per distinct search; forget old ones at start and then once a day, so it cannot grow without bound.
  const prune = () => { try { const removed = planner?.prune() ?? 0; if (removed > 0) log({ event: 'service.ledger_pruned', removed }); } catch { log({ event: 'service.ledger_prune_failed' }); } };
  prune(); const pruning = setInterval(prune, 24 * 3600000); pruning.unref();
  const hardStop = new AbortController(); const softStop = new AbortController();
  const crawler = transport ? new Crawler({ frontier, documents, transport, clock, batch: config.concurrency, hardStop: hardStop.signal }) : undefined;

  let crawling = false;
  const server: Server = createSearchServer({ documents, searcher, frontier, ...(planner ? { planner } : {}), ...(config.apiToken ? { apiToken: config.apiToken } : {}), ...(version ? { version } : {}), clock, crawling: () => crawling });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  const address = server.address() as AddressInfo;

  // The crawl loop is supervised: a bug or a transient failure inside it must never take the search API down with it.
  let loop: Promise<void> = Promise.resolve();
  if (crawler) {
    crawling = true;
    loop = (async () => {
      while (!softStop.signal.aborted) {
        try { await crawler.run({ concurrency: config.concurrency, signal: softStop.signal }); }
        catch { log({ event: 'service.crawl_error' }); await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); softStop.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }); }
      }
      crawling = false;
    })();
  }
  const progress = setInterval(() => log({ event: 'service.progress', frontier: { ...frontier.stats(), ...frontier.detail(clock()), concentration: logConcentration(frontier, clock()), admission: frontier.admission }, documents: documents.count(), links: documents.linkCount(), ...(planner ? { demand: planner.stats() } : {}) }), config.progressMs);
  progress.unref();
  log({ event: 'service.started', ...(version ? { version } : {}), host: config.host, port: address.port, crawling: crawler !== undefined, demand: planner !== undefined, authRequired: config.apiToken !== undefined,
    seedsAdded, seedsRejected, reclaimedLeases: reclaimed, documents: documents.count().indexed });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    log({ event: 'service.stopping' });
    clearInterval(progress); clearInterval(pruning); softStop.abort();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); setTimeout(() => server.closeAllConnections(), 2000).unref(); });
    // Let fetches that are already submitted finish; past the deadline, give up on them (their URLs go back to the frontier and are resubmitted under the same key).
    const deadline = setTimeout(() => { hardStop.abort(); }, config.shutdownMs);
    await loop; clearTimeout(deadline);
    frontier.requeueAll();
    db.close();
    log({ event: 'service.stopped' });
  })();
  return { port: address.port, host: config.host, documents, frontier, planner, crawler, searcher, stop };
}

/** The concentration figures for the log: numbers only. Domain names appear in the authenticated /status response, never in the log. */
function logConcentration(frontier: Frontier, now: number): Record<string, unknown> {
  const c = frontier.concentration(now); const strip = ({ topDomain, ...numbers }: typeof c.pending) => { void topDomain; return numbers; };
  return { pending: strip(c.pending), crawled: strip(c.crawled), warnings: c.warnings.length };
}
