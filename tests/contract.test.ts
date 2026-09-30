import test from 'node:test';
import assert from 'node:assert/strict';
import { FETCH_JOB_TYPE, FETCH_MAX_RESULT_BYTES, FETCH_OUTCOMES, FetchInputSchema, FetchResultSchema, isValidIdempotencyKey } from '../src/privanet/contract.js';
import { FakeTransport, outcomeResult, pageResult } from '../src/privanet/fake-transport.js';
import { TransportError } from '../src/privanet/transport.js';

test('the contract comes from @privanet/protocol, not a local copy, and the capability id is defined in one place', async () => {
  const protocol = await import('@privanet/protocol');
  assert.equal(FetchInputSchema, protocol.FetchInputSchema); assert.equal(FetchResultSchema, protocol.FetchOutputSchema);
  assert.equal(FETCH_JOB_TYPE, 'web.fetch.v1'); assert.equal(FETCH_OUTCOMES.length, 12); assert.equal(FETCH_MAX_RESULT_BYTES, 28000);
  assert.ok(Object.keys(protocol.JOB_TYPES).includes(FETCH_JOB_TYPE)); // the installed PrivaNet actually offers it
  assert.equal(isValidIdempotencyKey('crawl:abc:0'), true); assert.equal(isValidIdempotencyKey('has space'), false); assert.equal(isValidIdempotencyKey('x'.repeat(129)), false);
});

test('input is strict: no method, headers, cookies, proxy, port or ignore-robots knob can be expressed, and caps have hard bounds', () => {
  assert.deepEqual(FetchInputSchema.parse({ url: 'https://example.com/' }), { url: 'https://example.com/' }); // caps only ever lower the node's own defaults
  for (const extra of [{ method: 'POST' }, { headers: { Cookie: 'a=b' } }, { proxy: 'http://x' }, { port: 8080 }, { ignoreRobots: true }, { allowPrivate: true }, { followCrossOrigin: true }, { body: 'x' }, { userAgent: 'x' }])
    assert.equal(FetchInputSchema.safeParse({ url: 'https://example.com/', ...extra }).success, false, JSON.stringify(extra));
  for (const over of [{ maxRedirects: 4 }, { timeoutMs: 30001 }, { timeoutMs: 999 }, { maxBodyBytes: 1048577 }, { maxLinks: 101 }, { maxTextBytes: 10241 }, { mode: 'HEAD' }, { url: 'x' }])
    assert.equal(FetchInputSchema.safeParse({ url: 'https://example.com/', ...over }).success, false, JSON.stringify(over));
  assert.equal(FetchInputSchema.safeParse({ url: 'https://example.com/', validators: { etag: '"abc"', lastModified: 'Tue, 15 Nov 1994 08:12:31 GMT' } }).success, true);
  for (const evil of [{ etag: 'abc\r\nX-Injected: 1' }, { etag: '"a"\n' }, { lastModified: 'yesterday' }, { lastModified: 'Tue, 15 Nov 1994 08:12:31 GMT\r\nX: y' }, { etag: '"' + 'a'.repeat(210) + '"' }])
    assert.equal(FetchInputSchema.safeParse({ url: 'https://example.com/', validators: evil }).success, false, JSON.stringify(evil));
});

test('results are validated as untrusted: unknown fields, bad enums, oversize payloads and malformed hashes are refused', () => {
  const good = pageResult('https://example.com/', 5, { title: 'T', text: 'body', links: [{ url: 'https://example.com/a' }] });
  assert.equal(FetchResultSchema.safeParse(good).success, true);
  assert.equal(FetchResultSchema.safeParse({ ...good, secret: 'x' }).success, false);
  assert.equal(FetchResultSchema.safeParse({ ...good, outcome: 'FETCHED_MAYBE' }).success, false);
  assert.equal(FetchResultSchema.safeParse({ ...good, contentSha256: 'nothex' }).success, false);
  assert.equal(FetchResultSchema.safeParse({ ...good, httpStatus: 99 }).success, false);
  assert.equal(FetchResultSchema.safeParse({ ...good, page: { ...good.page, links: [], linksTruncated: false, evil: 1 } }).success, false);
  assert.equal(FetchResultSchema.safeParse({ ...good, page: { links: Array.from({ length: 101 }, (_, i) => ({ url: `https://example.com/${i}`, nofollow: false })), linksTruncated: false } }).success, false);
  const big = { ...good, page: { text: 'x'.repeat(10240), links: Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/${'p'.repeat(300)}${i}`, nofollow: false })), linksTruncated: false } };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > FETCH_MAX_RESULT_BYTES); assert.equal(FetchResultSchema.safeParse(big).success, false);
  assert.equal(FetchResultSchema.safeParse(null).success, false); assert.equal(FetchResultSchema.safeParse('FETCHED').success, false);
});

test('the fake transport never touches the network, enforces the input contract and replays a repeated idempotency key', async () => {
  let calls = 0;
  const fake = new FakeTransport(input => { calls++; return outcomeResult('HTTP_ERROR', input.url, 1, { httpStatus: 500 }); });
  assert.equal(fake.type, 'web.fetch.v1');
  const first = await fake.fetch({ input: { url: 'https://example.com/' }, idempotencyKey: 'crawl:abc:0', queue: 'PUBLIC' });
  const again = await fake.fetch({ input: { url: 'https://example.com/' }, idempotencyKey: 'crawl:abc:0', queue: 'PUBLIC' });
  assert.equal(calls, 1); assert.deepEqual(again, first); // same key, same job, same result
  await fake.fetch({ input: { url: 'https://example.com/' }, idempotencyKey: 'crawl:abc:1', queue: 'PUBLIC' }); assert.equal(calls, 2); // a new generation is a new job
  await assert.rejects(fake.fetch({ input: { url: 'https://example.com/', method: 'POST' } as never, idempotencyKey: 'k', queue: 'DEMAND' })); // strict input
  await assert.rejects(fake.fetch({ input: { url: 'https://example.com/' }, idempotencyKey: 'has space', queue: 'DEMAND' }), (error: unknown) => error instanceof TransportError && error.code === 'FORBIDDEN');
});
