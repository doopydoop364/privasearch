import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseCrawlConfig } from './crawl-config.js';
import { Crawler } from './driver.js';
import { DocumentStore } from './documents.js';
import { Frontier } from './frontier.js';
import { PrivaNetTransport } from './privanet/privanet-transport.js';

// Crawls through PrivaNet until stopped (SIGINT or SIGTERM): frontier -> Crawler.run -> PrivaNetTransport -> @privanet/sdk.
// PrivaSearch never fetches a page itself. Seeds come from arguments and PRIVASEARCH_SEEDS (a file, one URL per line).
// Logs aggregate counts only: no URL, query or credential is ever written to the log.
const seedFile = process.env.PRIVASEARCH_SEEDS;
let config;
try { config = parseCrawlConfig(process.env, process.argv.slice(2), seedFile ? readFileSync(seedFile, 'utf8') : undefined); }
catch (error) { console.error(JSON.stringify({ event: 'crawl.config_invalid', reason: error instanceof Error ? error.message : 'invalid' })); process.exit(2); }

mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(config.dbPath); const frontier = new Frontier(db); const documents = new DocumentStore(db);
let added = 0; let rejected = 0;
for (const seed of config.seeds) { const result = frontier.add(seed, { queue: config.seedQueue }, Date.now()); if (result === 'ADDED') added++; else if (result !== 'EXISTS') rejected++; }
const transport = new PrivaNetTransport({ url: config.coordinatorUrl, tokens: config.tokens, allowInsecureLoopback: config.allowInsecureLoopback, waitTimeoutMs: config.waitTimeoutMs, pollMs: config.pollMs });
const crawler = new Crawler({ frontier, documents, transport, batch: config.concurrency });
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { console.log(JSON.stringify({ event: 'crawl.stopping' })); abort.abort(); });
console.log(JSON.stringify({ event: 'crawl.started', seedsAdded: added, seedsRejected: rejected, concurrency: config.concurrency }));
const report = setInterval(() => console.log(JSON.stringify({ event: 'crawl.progress', frontier: frontier.stats(), documents: documents.count() })), 10000); report.unref();
const summary = await crawler.run({ concurrency: config.concurrency, signal: abort.signal });
clearInterval(report);
console.log(JSON.stringify({ event: 'crawl.stopped', ...summary, documents: documents.count() }));
db.close();
