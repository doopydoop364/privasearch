import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { DocumentStore } from './documents.js';

/**
 * A deliberately small search API: JSON only, GET only, bounded input, no cookies, no logging of queries,
 * and no user identifiers. There is no UI yet. Hit text originates from untrusted pages, so consumers
 * must escape it before rendering it anywhere.
 */
const MAX_QUERY = 200;
export function createSearchServer(documents: DocumentStore): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') { send(405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    let url: URL; try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { send(400, { error: 'BAD_REQUEST' }); return; }
    if (url.pathname === '/health') { send(200, { status: 'ok', ...documents.count() }); return; }
    if (url.pathname !== '/search') { send(404, { error: 'NOT_FOUND' }); return; }
    const q = url.searchParams.get('q') ?? '';
    if (q.length === 0 || q.length > MAX_QUERY) { send(400, { error: 'BAD_QUERY' }); return; }
    const limit = Number(url.searchParams.get('limit') ?? 10);
    send(200, { query: q, hits: documents.search(q, Number.isInteger(limit) ? limit : 10) });
  });
}
