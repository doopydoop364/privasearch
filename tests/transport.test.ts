import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrivaNetTransport, translateError } from '../src/privanet/privanet-transport.js';
import { TransportError } from '../src/privanet/transport.js';
import { ApiError } from '@privanet/sdk';
import { outcomeResult } from '../src/privanet/fake-transport.js';

const DEMAND = 'd'.repeat(64); const PUBLIC = 'e'.repeat(64);
interface Seen { method: string; path: string; auth: string | undefined; body: unknown }

/** A stub Coordinator speaking just enough of the wire protocol; it is a test double for the SDK's peer, not for PrivaNet. */
async function stub(t: { after(fn: () => Promise<void>): void }, handler: (seen: Seen, respond: (status: number, body: unknown, extra?: { protocol?: string | null }) => void, count: number) => void) {
  const seen: Seen[] = []; let count = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry: Seen = { method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
      seen.push(entry);
      handler(entry, (status, body, extra) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (extra?.protocol !== null) headers['X-PrivaNet-Protocol'] = extra?.protocol ?? '1';
        res.writeHead(status, headers); res.end(JSON.stringify(body));
      }, count++);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, transport: (extra: { waitTimeoutMs?: number } = {}) => new PrivaNetTransport({ url, tokens: { DEMAND, PUBLIC }, allowInsecureLoopback: true, pollMs: 10, ...extra }) };
}
const job = (id: string, status: 'QUEUED' | 'COMPLETED' | 'FAILED', result: unknown = null, input: unknown = { url: 'https://a.example/' }) =>
  ({ id, type: 'web.fetch.v1', protocolVersion: 1, input, status, createdAt: 1, completedAt: status === 'QUEUED' ? null : 2, attempts: 1, result, error: status === 'FAILED' ? { code: 'HANDLER_FAILED' } : null });
const req = (queue: 'DEMAND' | 'PUBLIC' = 'PUBLIC', key = 'crawl:abc:0') => ({ input: { url: 'https://a.example/' }, idempotencyKey: key, queue });

test('the adapter submits web.fetch.v1 with the idempotency key and the credential of the chosen queue, then returns the untrusted result', async t => {
  const id = randomUUID(); const result = outcomeResult('HTTP_ERROR', 'https://a.example/', 5, { httpStatus: 500 });
  const s = await stub(t, (seen, respond) => seen.method === 'POST' ? respond(201, job(id, 'QUEUED')) : respond(200, job(id, 'COMPLETED', result)));
  assert.deepEqual(await s.transport().fetch(req('DEMAND')), result);
  await s.transport().fetch(req('PUBLIC', 'crawl:abc:1'));
  const posts = s.seen.filter(x => x.method === 'POST');
  assert.deepEqual(posts.map(p => p.auth), [`Bearer ${DEMAND}`, `Bearer ${PUBLIC}`]); // the queues never share a credential
  assert.deepEqual(posts[0]?.body, { type: 'web.fetch.v1', input: { url: 'https://a.example/' }, idempotencyKey: 'crawl:abc:0' });
});

test('the SDK rejects a result that violates the schema; a schema-valid but dishonest one is passed through for the driver to cross-check', async t => {
  const id = randomUUID();
  const broken = await stub(t, (seen, respond) => seen.method === 'POST' ? respond(201, job(id, 'QUEUED')) : respond(200, job(id, 'COMPLETED', { outcome: 'FETCHED', evil: '<script>' })));
  await assert.rejects(broken.transport().fetch(req()), (e: unknown) => e instanceof TransportError && e.code === 'INCOMPATIBLE' && !e.retryable);
  const hostile = outcomeResult('HTTP_ERROR', 'https://elsewhere.example/', 5, { httpStatus: 500 }); // wrong requestedUrl: only PrivaSearch knows what it asked for
  const s = await stub(t, (seen, respond) => seen.method === 'POST' ? respond(201, job(id, 'QUEUED')) : respond(200, job(id, 'COMPLETED', hostile)));
  assert.deepEqual(await s.transport().fetch(req()), hostile); // validation is the driver's job, see driver tests
});

test('idempotent retry: after a lost response the same key is resubmitted, so PrivaNet returns the same job', async t => {
  const id = randomUUID(); let posts = 0;
  const s = await stub(t, (seen, respond) => {
    if (seen.method === 'POST') { posts++; respond(201, job(id, 'QUEUED')); }
    else respond(200, job(id, 'COMPLETED', outcomeResult('HTTP_ERROR', 'https://a.example/', 1, { httpStatus: 500 })));
  });
  const transport = s.transport();
  await transport.fetch(req()); await transport.fetch(req());
  assert.equal(posts, 2); assert.equal(new Set(s.seen.filter(x => x.method === 'POST').map(x => JSON.stringify(x.body))).size, 1); // identical submissions
});

test('errors are translated into retry-aware transport errors', async t => {
  const failure = (status: number, code: string, protocol?: string | null) => stub(t, (_seen, respond) => respond(status, { error: { code, message: code } }, protocol === undefined ? {} : { protocol }));
  const expect = async (status: number, code: string, want: string, retryable: boolean) => {
    const s = await failure(status, code);
    await assert.rejects(s.transport().fetch(req()), (e: unknown) => e instanceof TransportError && e.code === want && e.retryable === retryable, `${status} ${code}`);
  };
  await expect(429, 'QUEUE_LIMIT', 'QUEUE_FULL', true);
  await expect(403, 'FETCH_IDENTITY_REQUIRED', 'FORBIDDEN', false);
  await expect(403, 'JOB_TYPE_FORBIDDEN', 'FORBIDDEN', false);
  await expect(401, 'UNAUTHORIZED', 'FORBIDDEN', false);
  await expect(426, 'PROTOCOL_MISMATCH', 'INCOMPATIBLE', false);
  await expect(400, 'INVALID_REQUEST', 'FORBIDDEN', false);
  await expect(500, 'INTERNAL_ERROR', 'UNAVAILABLE', true);
});

test('a failed job, a job that never finishes and an unreachable Coordinator are distinguished', async t => {
  const id = randomUUID();
  const failed = await stub(t, (seen, respond) => seen.method === 'POST' ? respond(201, job(id, 'QUEUED')) : respond(200, job(id, 'FAILED')));
  await assert.rejects(failed.transport().fetch(req()), (e: unknown) => e instanceof TransportError && e.code === 'JOB_FAILED');
  const stuck = await stub(t, (seen, respond) => respond(seen.method === 'POST' ? 201 : 200, job(id, 'QUEUED')));
  await assert.rejects(stuck.transport({ waitTimeoutMs: 150 }).fetch(req()), (e: unknown) => e instanceof TransportError && e.code === 'TIMEOUT' && e.retryable);
  const down = new PrivaNetTransport({ url: 'http://127.0.0.1:1', tokens: { DEMAND, PUBLIC }, allowInsecureLoopback: true });
  await assert.rejects(down.fetch(req()), (e: unknown) => e instanceof TransportError && e.code === 'UNAVAILABLE' && e.retryable);
  const noVersion = await stub(t, (_s, respond) => respond(200, { protocolVersion: 1, serviceVersion: '0.3.0', coordinatorId: id, status: 'ok' }, { protocol: null }));
  await assert.rejects(noVersion.transport().fetch(req()), (e: unknown) => e instanceof TransportError); // an answer without the protocol header is never trusted
});

test('an invalid idempotency key never leaves the process, and translateError is total', async t => {
  const s = await stub(t, (_seen, respond) => respond(500, {}));
  await assert.rejects(s.transport().fetch(req('PUBLIC', 'has space')), (e: unknown) => e instanceof TransportError && e.code === 'FORBIDDEN');
  assert.equal(s.seen.length, 0);
  assert.equal(translateError(new ApiError(418, 'X', 'x')).code, 'FORBIDDEN');
  assert.equal(translateError(new Error('boom')).code, 'UNAVAILABLE');
  assert.equal(translateError('weird').code, 'UNAVAILABLE');
});
