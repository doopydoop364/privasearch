import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { Frontier } from '../src/frontier.js';
import { prune } from '../src/prune.js';
import { backupDatabase } from '../src/backup.js';

const now = 1_800_000_000_000;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'priva-audit-maintenance-')); const path = join(dir, 'source.sqlite');
  const db = openDatabase(path); const f = new Frontier(db);
  f.add('https://a.example/', { queue: 'PUBLIC', source: 'seed' }, now);
  for (let i = 0; i < 10; i++) f.add(`https://a.example/image${i}.png`, { queue: 'PUBLIC', source: 'seed', priority: 10 }, now);
  db.exec("UPDATE urls SET source='discovered' WHERE url LIKE '%.png'"); db.close();
  return { dir, path };
}

test('prune dry-run does not count already rejected URLs again toward domain caps', () => {
  const { dir, path } = fixture();
  try {
    const options = { now, keepPerDomain: 0, maxTotal: 1000 };
    const dry = prune(path, { ...options, apply: false });
    const applied = prune(path, { ...options, apply: true });
    assert.equal(dry.candidates, 10); assert.equal(applied.removed, 10);
    assert.equal(dry.pendingAfter, 1); assert.equal(applied.pendingAfter, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prune preserves a URL promoted to demand between selection and deletion', t => {
  const { dir, path } = fixture(); const prepare = DatabaseSync.prototype.prepare; let promoted = false;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith('SELECT url_key, url, domain, priority, discovered_at')) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...args: SQLInputValue[]) => {
        const rows = all(...args);
        if (!promoted && rows.length > 0) {
          promoted = true;
          const service = new DatabaseSync(path);
          try { service.exec("UPDATE urls SET queue='DEMAND', priority=100 WHERE url LIKE '%.png'"); }
          finally { service.close(); }
        }
        return rows;
      });
    }
    return statement;
  });
  try {
    const report = prune(path, { now, apply: true });
    assert.equal(promoted, true); assert.equal(report.removed, 0); assert.equal(report.candidates, 0);
    assert.equal(report.pendingAfter, 11);
  } finally { t.mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
});

test('backup is private before SQLite writes and refuses existing files; failed backups are removed', t => {
  const { dir, path } = fixture(); const destination = join(dir, 'backup.sqlite');
  const prepare = DatabaseSync.prototype.prepare; let checked = false;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    if (sql === 'VACUUM INTO ?') {
      checked = true; assert.equal(statSync(destination).size, 0);
      if (process.platform !== 'win32') assert.equal(statSync(destination).mode & 0o077, 0);
    }
    return prepare.call(this, sql);
  });
  try {
    backupDatabase(path, destination); assert.equal(checked, true);
    const bytes = readFileSync(destination);
    assert.throws(() => backupDatabase(path, destination)); assert.deepEqual(readFileSync(destination), bytes);
    t.mock.restoreAll();
    const invalid = join(dir, 'invalid.sqlite'); const failed = join(dir, 'failed.sqlite');
    writeFileSync(invalid, 'not a database');
    assert.throws(() => backupDatabase(invalid, failed)); assert.equal(existsSync(failed), false);
  } finally { t.mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
});

test('discovery cancels rejected status and content-type bodies', async () => {
  const { HttpDiscoveryProvider } = await import('../src/provider.js');
  for (const [status, type] of [[503, 'application/json'], [200, 'text/html']] as const) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { 'content-type': type } });
    const provider = new HttpDiscoveryProvider({ endpoint: 'http://127.0.0.1/provider', fetchImpl: async () => response });
    await assert.rejects(provider.discover('example', 5));
    assert.equal(cancelled, true);
  }
});

test('CLI pruning delivers cancellation between transactions and reports only committed removals', async t => {
  const { pruneAsync } = await import('../src/prune.js');
  for (const phase of ['rules', 'domain', 'global']) {
    const { dir, path } = fixture(); const abort = new AbortController(); let scheduled = false;
    if (phase !== 'rules') {
      const db = new DatabaseSync(path);
      try { db.exec("UPDATE urls SET url=replace(url,'.png','.html') WHERE source='discovered'"); } finally { db.close(); }
    }
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith('DELETE FROM urls')) {
        const run = statement.run.bind(statement);
        t.mock.method(statement, 'run', (...args: SQLInputValue[]) => {
          const result = run(...args);
          if (Number(result.changes) > 0 && !scheduled) { scheduled = true; setImmediate(() => abort.abort()); }
          return result;
        });
      }
      return statement;
    });
    try {
      const report = await pruneAsync(path, { now, apply: true, batch: 1, signal: abort.signal,
        keepPerDomain: phase === 'domain' ? 0 : 100, maxTotal: phase === 'global' ? 0 : 100 });
      assert.equal(scheduled, true, phase); assert.equal(report.interrupted, true, phase);
      assert.equal(report.removed, 1, phase); assert.equal(report.candidates, 1, phase);
      assert.equal(report.pendingAfter, 10, phase);
      assert.equal(Object.values(report.byReason).reduce((a, b) => a + b, 0), 1, phase);
    } finally { t.mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
  }
});
