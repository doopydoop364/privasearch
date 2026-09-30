import { DatabaseSync } from 'node:sqlite';
import { Crawler } from '../src/driver.js';
import { DocumentStore } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import { PrivaNetTransport } from '../src/privanet/privanet-transport.js';
import { startCore } from './core-rig.js';

/**
 * The public-URL proof: `node dist/tests/live-url.js https://example.com/ [search term]` with PRIVANET_CORE_DIR set.
 * Runs a real Coordinator and PrivaNode with the node's default, unrelaxed SSRF policy (no unsafeLocal, no hostMap),
 * so the fetch really leaves through the guarded PrivaNode to the public internet. PrivaSearch itself makes no request.
 */
const core = process.env.PRIVANET_CORE_DIR; if (!core) throw new Error('PRIVANET_CORE_DIR must point at a built PrivaNet-Core checkout');
const url = process.argv[2] ?? 'https://example.com/'; const term = process.argv[3] ?? 'example';
const rig = await startCore(core, { minHostDelayMs: 1000 });
try {
  const db = new DatabaseSync(':memory:'); const now = Date.now();
  const frontier = new Frontier(db); const documents = new DocumentStore(db);
  const crawler = new Crawler({ frontier, documents, transport: new PrivaNetTransport({ url: rig.url, tokens: rig.tokens, allowInsecureLoopback: true, waitTimeoutMs: 90000 }), clock: Date.now });
  const added = frontier.add(url, { queue: 'DEMAND' }, now);
  const summary = await crawler.runOnce();
  const row = frontier.getByUrl(url); const hits = documents.search(term);
  console.log(JSON.stringify({ url, added, summary, lastOutcome: row?.last_outcome, httpStatus: row?.last_http, indexed: documents.count(), hits: hits.map(h => ({ url: h.url, title: h.title })), userAgent: `${rig.identity.product}/1.0 (+${rig.identity.infoUrl}; via PrivaNet)` }, null, 2));
  process.exitCode = summary.outcomes.FETCHED === 1 && hits.length > 0 ? 0 : 1;
} finally { await rig.stop(); }
