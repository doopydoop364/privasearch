import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { DocumentStore } from './documents.js';
import { SCHEMA_VERSION } from './db.js';
import type { DemandPlanner, CrawlInfo } from './demand.js';
import type { Frontier } from './frontier.js';
import { Searcher } from './ranking.js';

/**
 * The search API (documented in docs/search-api.md). JSON only, GET only, bounded input, no cookies, no logging of queries and no user identifiers.
 * Page text originates from untrusted sites, so consumers must escape it before rendering it anywhere.
 *
 *   GET /health   no authentication; liveness and index size
 *   GET /search   ?q=<text, at most 200 characters>&limit=<1..50, default 10>&offset=<0..300, default 0>
 *   GET /status   crawl and index counters for operators; never URLs or queries
 *
 * When an API token is configured, /search and /status need `Authorization: Bearer <token>`; /health stays open for monitoring. A search for page one
 * (offset 0) may start demand crawling; later pages never do. Nothing in a response is a credential: the PrivaNet tokens never leave the process.
 */
export interface ServerDeps {
  documents: DocumentStore; searcher?: Searcher; planner?: DemandPlanner; frontier?: Frontier;
  /** When set, /search and /status require this bearer token. */
  apiToken?: string; version?: string; clock?: () => number;
  /** Whether a crawler is running in this process (reported by /health and /status). */
  crawling?: () => boolean;
}
const MAX_QUERY = 200;
export const API_VERSION = 1;

export function createSearchServer(arg: DocumentStore | ServerDeps): Server {
  const deps: ServerDeps = arg instanceof DocumentStore ? { documents: arg } : arg;
  const clock = deps.clock ?? Date.now; const searcher = deps.searcher ?? new Searcher(deps.documents, clock); const started = clock();
  const token = deps.apiToken ? Buffer.from(deps.apiToken) : undefined;
  const authorized = (header: string | undefined): boolean => {
    if (!token) return true;
    const match = /^Bearer (.+)$/.exec(header ?? ''); if (!match?.[1]) return false;
    const supplied = Buffer.from(match[1]); return supplied.length === token.length && timingSafeEqual(supplied, token);
  };
  return createServer((req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') { send(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    let url: URL; try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { send(400, { error: 'BAD_REQUEST' }); return; }
    if (url.pathname === '/health') { send(200, { status: 'ok', apiVersion: API_VERSION, ...(deps.version ? { version: deps.version } : {}), schemaVersion: SCHEMA_VERSION, ...deps.documents.count(), crawling: deps.crawling?.() ?? false }); return; }
    if (url.pathname !== '/search' && url.pathname !== '/status') { send(404, { error: 'NOT_FOUND' }); return; }
    if (!authorized(req.headers.authorization)) { send(401, { error: 'UNAUTHORIZED' }, { 'www-authenticate': 'Bearer' }); return; }
    if (url.pathname === '/status') {
      const now = clock();
      send(200, { apiVersion: API_VERSION, generatedAtMs: now, ...(deps.version ? { version: deps.version } : {}), schemaVersion: SCHEMA_VERSION, uptimeSec: Math.round((now - started) / 1000), crawling: deps.crawling?.() ?? false, documents: { ...deps.documents.count(), links: deps.documents.linkCount() },
        ...(deps.frontier ? { frontier: { ...deps.frontier.stats(), ...deps.frontier.detail(now), concentration: deps.frontier.concentration(now), admission: deps.frontier.admission, operational: deps.frontier.operationalHealth(now) } } : {}), ...(deps.planner ? { demand: deps.planner.stats() } : {}) });
      return;
    }
    const q = url.searchParams.get('q') ?? '';
    if (q.length === 0 || q.length > MAX_QUERY) { send(400, { error: 'BAD_QUERY' }); return; }
    const int = (name: string, fallback: number) => { const raw = url.searchParams.get(name); if (raw === null || raw === '') return fallback; const n = Number(raw); return Number.isInteger(n) ? n : fallback; };
    const limit = int('limit', 10); const offset = int('offset', 0);
    const result = searcher.search(q, { limit, offset });
    // Only the first page can start crawling; paging through an old query never does.
    const crawl: CrawlInfo = !deps.planner ? { triggered: false, state: 'disabled', candidates: 0 } : result.offset === 0 ? deps.planner.consider(q, result) : { triggered: false, state: 'none', candidates: 0 };
    const minStrong = deps.planner?.minStrong ?? 3;
    const state = result.total === 0 ? 'empty' : result.strong >= minStrong ? 'ready' : 'partial';
    send(200, { apiVersion: API_VERSION, query: q, total: result.total, offset: result.offset, limit: result.limit, hits: result.hits, index: { state, documents: deps.documents.indexedCount() }, crawl });
  });
}
