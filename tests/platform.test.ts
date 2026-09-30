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
