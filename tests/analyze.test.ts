import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeFrontier, formatAnalysis } from '../src/analyze.js';
import { openDatabase } from '../src/db.js';
import { Frontier } from '../src/frontier.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'privasearch-analyze-')); const path = join(dir, 'p.sqlite'); const db = openDatabase(path); const f = new Frontier(db, { maxUrlsPerHost: 100000 });
  for (const lang of ['en', 'de', 'fr', 'ja']) for (let i = 0; i < 50; i++) f.add(`https://${lang}.wikipedia.org/wiki/A${i}`, { queue: 'PUBLIC', priority: 44, depth: 1, source: 'discovered' }, 1);
  f.add('https://example.org/', { queue: 'PUBLIC', priority: 60, source: 'seed' }, 1); f.add('https://news.example.net/a', { queue: 'DEMAND', priority: 100, source: 'demand' }, 1);
  db.prepare('INSERT INTO links (src_key, dst_key, dst_url, src_host, dst_host) VALUES (?,?,?,?,?)').run('a', 'b', 'https://de.wikipedia.org/x', 'en.wikipedia.org', 'de.wikipedia.org');
  db.prepare('INSERT INTO links (src_key, dst_key, dst_url, src_host, dst_host) VALUES (?,?,?,?,?)').run('a', 'c', 'https://example.org/x', 'en.wikipedia.org', 'example.org');
  db.close(); return { dir, path };
}

test('analyze reports concentration by registrable domain, not by host', () => {
  const { dir, path } = fixture();
  try {
    const a = analyzeFrontier(path);
    assert.equal(a.pending.total, 202); assert.equal(a.hosts, 6); assert.equal(a.domains, 3);
    assert.equal(a.pending.topDomains[0]?.key, 'wikipedia.org'); assert.equal(a.pending.topDomains[0]?.count, 200);
    assert.ok(a.pending.top1DomainShare > 0.98); assert.ok(a.pending.herfindahlDomains > 0.9);
    assert.equal(a.pending.topHosts[0]?.count, 50); // per host the same data looks balanced: exactly the blind spot a host-only view has
    assert.equal(a.links?.total, 2); assert.equal(a.links?.internalDomain, 1); assert.equal(a.links?.distinctExternalDomainsLinkedTo, 1);
    assert.equal(a.queues.DEMAND, 1); assert.ok(a.warnings.some(w => w.includes('wikipedia.org')));
    assert.match(formatAnalysis(a), /wikipedia\.org/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyze never writes: file, schema version and modification time are unchanged', () => {
  const { dir, path } = fixture();
  try {
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs };
    analyzeFrontier(path); analyzeFrontier(path, { top: 3 });
    assert.deepEqual(readFileSync(path), before.bytes); assert.equal(statSync(path).mtimeMs, before.mtime);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('analyze fails on a missing database instead of creating one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privasearch-analyze-'));
  try { assert.throws(() => analyzeFrontier(join(dir, 'none.sqlite'))); } finally { rmSync(dir, { recursive: true, force: true }); }
});
