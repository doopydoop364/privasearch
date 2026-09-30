import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// Everything else stands on SQLite with FTS5 and bm25 under Node's built-in driver; check it on every CI platform.
test('node:sqlite provides FTS5 with bm25 ranking and snippets on this platform', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(title, body, tokenize='unicode61 remove_diacritics 2')");
  db.prepare('INSERT INTO t VALUES (?, ?)').run('Cats', 'the quick brown fox jumps over the lazy cat');
  db.prepare('INSERT INTO t VALUES (?, ?)').run('Dogs', 'a dog chases a ball across the garden');
  const hits = db.prepare("SELECT title, bm25(t, 5.0, 1.0) AS score, snippet(t, 1, '', '', '…', 8) AS s FROM t WHERE t MATCH ? ORDER BY score").all('"fox"') as Array<{ title: string; s: string }>;
  assert.equal(hits.length, 1); assert.equal(hits[0]?.title, 'Cats'); assert.match(hits[0]?.s ?? '', /fox/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t WHERE t MATCH ?').get('"cafe"')?.n, 0);
  db.prepare('INSERT INTO t VALUES (?, ?)').run('Café', 'diacritics fold');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t WHERE t MATCH ?').get('"cafe"')?.n, 1);
  db.close();
});

import { parseCrawlConfig } from '../src/crawl-config.js';
test('crawl configuration fails closed: credentials are validated and distinct, numbers are bounded, seeds come from arguments and a file', () => {
  const good = { PRIVANET_COORDINATOR_URL: 'https://coordinator.example', PRIVANET_DEMAND_TOKEN: 'a'.repeat(64), PRIVANET_PUBLIC_TOKEN: 'b'.repeat(64) };
  const ok = parseCrawlConfig(good, ['https://x.example/', '--flag'], '# comment\nhttps://y.example/\n\n  https://z.example/  \n');
  assert.deepEqual(ok.seeds, ['https://x.example/', 'https://y.example/', 'https://z.example/']); assert.equal(ok.concurrency, 32); assert.equal(ok.seedQueue, 'PUBLIC'); assert.equal(ok.allowInsecureLoopback, false);
  for (const bad of [{ ...good, PRIVANET_COORDINATOR_URL: undefined }, { ...good, PRIVANET_DEMAND_TOKEN: 'short' }, { ...good, PRIVANET_PUBLIC_TOKEN: undefined }, { ...good, PRIVANET_PUBLIC_TOKEN: good.PRIVANET_DEMAND_TOKEN },
    { ...good, PRIVASEARCH_CONCURRENCY: '0' }, { ...good, PRIVASEARCH_CONCURRENCY: '100000' }, { ...good, PRIVASEARCH_CONCURRENCY: 'many' }, { ...good, PRIVASEARCH_SEED_QUEUE: 'OTHER' }])
    assert.throws(() => parseCrawlConfig(bad, []), JSON.stringify(bad));
  assert.equal(parseCrawlConfig({ ...good, PRIVASEARCH_ALLOW_INSECURE_LOOPBACK: 'true', PRIVASEARCH_SEED_QUEUE: 'DEMAND', PRIVASEARCH_CONCURRENCY: '8' }, []).concurrency, 8);
});
