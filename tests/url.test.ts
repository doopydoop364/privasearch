import test from 'node:test';
import assert from 'node:assert/strict';
import { idempotencyKeyFor, parseCrawlUrl, sameOrigin, urlKey } from '../src/url.js';
import { isValidIdempotencyKey } from '../src/privanet/contract.js';

const ok = (raw: string, base?: string) => { const p = parseCrawlUrl(raw, base); assert.equal(p.ok, true, `${raw} should be accepted`); return p.ok ? p.url : ''; };
const bad = (raw: string, reason: string) => { const p = parseCrawlUrl(raw); assert.equal(p.ok, false, `${raw} should be rejected`); assert.equal(p.ok ? '' : p.reason, reason, raw); };

test('normalisation: case, default ports, fragments, dot segments, percent escapes, tracking parameters', () => {
  assert.equal(ok('HTTP://Example.COM:80/a/./b/../c?x=1#frag'), 'http://example.com/a/c?x=1');
  assert.equal(ok('https://example.com:443'), 'https://example.com/');
  assert.equal(ok('https://example.com/%7euser/%e2%82%ac'), 'https://example.com/~user/%E2%82%AC');
  assert.equal(ok('https://example.com/p?utm_source=x&id=7&fbclid=abc'), 'https://example.com/p?id=7');
  assert.equal(ok('https://example.com/p?utm_source=x'), 'https://example.com/p');
  assert.equal(ok('https://example.com./x'), 'https://example.com/x'); // trailing dot
  assert.equal(ok('https://bücher.example/x'), 'https://xn--bcher-kva.example/x'); // IDN to punycode
  assert.equal(ok('../up?q=1', 'https://example.com/a/b/c'), 'https://example.com/a/up?q=1'); // relative links resolve against the page
  assert.equal(ok('//other.example/x', 'https://example.com/a'), 'https://other.example/x');
  assert.equal(ok(' https://example.com/trim '), 'https://example.com/trim');
});

test('admission policy mirrors the node boundary: schemes, credentials, IP literals in every form, internal names, ports', () => {
  for (const scheme of ['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'gopher://example.com']) bad(scheme, 'SCHEME');
  bad('https://user:pass@example.com/', 'CREDENTIALS'); bad('https://user@example.com/', 'CREDENTIALS');
  for (const ip of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://192.168.1.1/', 'http://0x7f.0.0.1/', 'http://2130706433/', 'http://017700000001/', 'http://127.1/', 'http://8.8.8.8/']) bad(ip, 'IP_LITERAL');
  for (const ip of ['http://[::1]/', 'http://[fd00:ec2::254]/', 'http://[::ffff:127.0.0.1]/', 'http://[2001:db8::1]/']) bad(ip, 'IP_LITERAL');
  for (const host of ['http://localhost/', 'http://foo.localhost/', 'http://printer.local/', 'http://db.internal/', 'http://router.lan/', 'http://nas.home.arpa/', 'http://intranet/']) bad(host, 'INTERNAL_HOST');
  for (const port of ['http://example.com:8080/', 'https://example.com:8443/', 'http://example.com:22/', 'https://example.com:80/']) bad(port, 'PORT');
  bad('not a url', 'MALFORMED'); bad('', 'MALFORMED'); bad('http://', 'MALFORMED');
  bad(`https://example.com/${'a'.repeat(2100)}`, 'TOO_LONG'); bad('https://example.com/a\u0000b', 'CONTROL_CHARS'); bad('https://example.com\\@evil.example/', 'CONTROL_CHARS');
});

test('urlKey is stable, canonical urls collapse to one key, and the idempotency key follows the contract rule', () => {
  const a = ok('https://Example.com/a#x'); const b = ok('https://example.com:443/a');
  assert.equal(urlKey(a), urlKey(b));
  const key = idempotencyKeyFor(a, 3);
  assert.match(key, /^crawl:[a-f0-9]{32}:3$/); assert.equal(isValidIdempotencyKey(key), true); assert.ok(key.length <= 128);
  assert.notEqual(idempotencyKeyFor(a, 3), idempotencyKeyFor(a, 4));
  assert.equal(sameOrigin('https://example.com/a', 'https://example.com/b'), true); assert.equal(sameOrigin('https://example.com/', 'https://other.example/'), false);
});
