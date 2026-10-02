import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { openDatabase, rebuildCounters } from '../src/db.js';
import { explainUrl, formatExplanation } from '../src/explain.js';
import { Frontier } from '../src/frontier.js';
import { formatPrune, prune } from '../src/prune.js';

const NOW = 1_800_000_000_000; const DAY = 86400000;
const CLI = join(process.cwd(), 'dist', 'src', 'frontier-cli.js');
const cliEnv = { ...process.env, NODE_NO_WARNINGS: '1' };

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'privasearch-tools-')); const path = join(dir, 'p.sqlite'); const db = openDatabase(path);
  const f = new Frontier(db, { hostDelayMs: 0, maxUrlsPerHost: 1e6, maxPendingPerDomain: 1e6, maxPendingPerFamily: 1e6, preferredLanguages: ['*'] });
  f.add('https://seed.example/', { queue: 'PUBLIC', source: 'seed' }, NOW); f.add('https://asked.example/q', { queue: 'DEMAND', source: 'demand' }, NOW); f.add('https://moved.example/new', { queue: 'PUBLIC', source: 'redirect', depth: 1 }, NOW);
  for (let i = 0; i < 100; i++) f.add(`https://en.big.org/wiki/P${i}`, { queue: 'PUBLIC', priority: 20 + (i % 40), depth: 2, source: 'discovered' }, NOW - (i < 10 ? 60 * DAY : 0));
  for (let i = 0; i < 30; i++) f.add(`https://small${i}.net/page`, { queue: 'PUBLIC', depth: 1, source: 'discovered', external: true }, NOW);
  // rows the current rules would refuse today, inserted as an older version would have admitted them
  for (const [i, url] of ['https://big.org/logo.png', 'https://big.org/w?action=edit', 'https://big.org/calendar/2020/05/01', 'https://big.org/files/a.pdf'].entries()) db.prepare(`INSERT INTO urls (url_key, url, host, domain, queue, priority, state, next_at, depth, discovered_at, source) VALUES (?,?,?,?,?,?, 'PENDING', ?, 1, ?, 'discovered')`).run(`old${i}`, url, 'big.org', 'big.org', 'PUBLIC', 30, NOW, NOW);
  const lease = f.lease(NOW + 1000, 3); const flight = lease[0]; assert.ok(flight);
  db.prepare(`UPDATE urls SET state='DONE', fetched_at=? WHERE url_key=?`).run(NOW, lease[1]!.urlKey); db.prepare(`UPDATE urls SET state='FAILED', attempts=5 WHERE url_key=?`).run(lease[2]!.urlKey);
  db.close(); return { dir, path };
}
const snapshot = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); const rows = db.prepare(`SELECT state, queue, source, COUNT(*) AS n FROM urls GROUP BY state, queue, source ORDER BY 1,2,3`).all(); db.close(); return rows; };

test('prune dry-run changes nothing and is exactly what apply then does; protected rows survive; apply is idempotent and keeps counters exact', () => {
  const { dir, path } = build();
  try {
    const bytes = readFileSync(path); const mtime = statSync(path).mtimeMs;
    const dry = prune(path, { now: NOW, apply: false, expireMs: 30 * DAY, keepPerDomain: 50, maxTotal: 100000 });
    assert.deepEqual(readFileSync(path), bytes); assert.equal(statSync(path).mtimeMs, mtime);
    assert.equal(dry.byReason.EXPIRED, 10); assert.equal(dry.byReason.NOW_LOW_VALUE, 3); assert.equal(dry.byReason.NOW_TRAP, 1); assert.ok(dry.byReason.DOMAIN_OVER_CAP > 0); assert.match(formatPrune(dry), /DRY RUN/);
    const protectedBefore = new DatabaseSync(path, { readOnly: true }); const keep = (db: DatabaseSync) => db.prepare(`SELECT url_key FROM urls WHERE queue='DEMAND' OR source IN ('seed','demand','redirect') OR state<>'PENDING' ORDER BY 1`).all(); const before = keep(protectedBefore); protectedBefore.close();
    const applied = prune(path, { now: NOW, apply: true, expireMs: 30 * DAY, keepPerDomain: 50, maxTotal: 100000, batch: 7 });
    assert.equal(applied.removed, dry.candidates); assert.deepEqual(applied.byReason, dry.byReason); assert.equal(applied.pendingAfter, dry.pendingAfter);
    const check = new DatabaseSync(path); assert.deepEqual(keep(check), before, 'demand, seeds, redirects, done, failed and in-flight rows are untouched');
    const wiki = Number((check.prepare(`SELECT pending AS n FROM domains WHERE domain='big.org'`).get() as { n: number }).n); assert.ok(wiki <= 50 + 0); // capped (eligible rows only; none protected here)
    const kept = check.prepare(`SELECT MIN(priority) AS p FROM urls WHERE domain='big.org' AND state='PENDING'`).get() as { p: number }; assert.ok(Number(kept.p) >= 20 + 0);
    const live = [check.prepare('SELECT domain, pending, urls FROM domains ORDER BY 1').all(), check.prepare('SELECT state, n FROM states ORDER BY 1').all()]; rebuildCounters(check);
    assert.deepEqual([check.prepare('SELECT domain, pending, urls FROM domains ORDER BY 1').all(), check.prepare('SELECT state, n FROM states ORDER BY 1').all()], live); check.close();
    const again = prune(path, { now: NOW, apply: true, expireMs: 30 * DAY, keepPerDomain: 50, maxTotal: 100000 }); assert.equal(again.removed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prune: the global budget removes the lowest priorities first and never a protected row; an aborted run stops cleanly', () => {
  const { dir, path } = build();
  try {
    const before = snapshot(path); const pendingDiscovered = Number(before.filter(r => r.state === 'PENDING' && r.source === 'discovered').reduce((a, r) => a + Number(r.n), 0));
    const dry = prune(path, { now: NOW, apply: false, expireMs: 3650 * DAY, keepPerDomain: 1e6, maxTotal: 60 });
    assert.ok(dry.pendingAfter <= 60 && dry.byReason.GLOBAL_OVER_CAP > 0);
    const aborted = new AbortController(); aborted.abort(); const stopped = prune(path, { now: NOW, apply: true, keepPerDomain: 1, signal: aborted.signal }); assert.equal(stopped.interrupted, true); assert.equal(stopped.removed, 0);
    const probe = new DatabaseSync(path, { readOnly: true });
    const protectedRows = Number((probe.prepare(`SELECT COUNT(*) AS n FROM urls WHERE state='PENDING' AND NOT (queue='PUBLIC' AND source='discovered' AND attempts=0 AND fetched_at IS NULL AND priority < 41)`).get() as { n: number }).n); probe.close();
    const applied = prune(path, { now: NOW, apply: true, expireMs: 3650 * DAY, keepPerDomain: 1e6, maxTotal: 60, protectPriority: 41 });
    assert.equal(applied.pendingAfter, Math.max(60, protectedRows)); // exactly the budget, or everything that is protected if that is more
    const db = new DatabaseSync(path, { readOnly: true }); const lowest = db.prepare(`SELECT MIN(priority) AS p FROM urls WHERE state='PENDING' AND source='discovered'`).get() as { p: number };
    assert.ok(Number(lowest.p) >= 20, 'the lowest priorities went first'); assert.ok(pendingDiscovered > 100);
    assert.ok(Number((db.prepare(`SELECT COUNT(*) AS n FROM urls WHERE source='seed' OR queue='DEMAND'`).get() as { n: number }).n) >= 2); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explain: a known URL shows its priority parts, its domain schedule and what blocks it; an unknown URL shows the admission verdict; nothing is written', () => {
  const { dir, path } = build();
  try {
    const bytes = readFileSync(path);
    const known = explainUrl(path, 'https://small3.net/page', NOW + 5000); assert.equal(known.found, true);
    assert.equal(known.priority?.stored, 50 - 6 + 12); assert.equal(known.priority?.recomputed.external, 12); assert.equal(known.priority?.unexplained, 0);
    assert.equal(known.domain?.name, 'small3.net'); assert.ok((known.domain?.scheduleRank ?? 0) >= 1); assert.ok(known.blockers.some(b => b.includes('nothing blocks')));
    const text = formatExplanation(known, NOW + 5000); assert.match(text, /Priority 56 = base 44 \+ external 12/); assert.match(text, /weight/);
    const unknown = explainUrl(path, 'https://never.example/seen?x=1', NOW); assert.equal(unknown.found, false); assert.equal(unknown.admission?.verdict, 'WOULD_ADD'); assert.equal(unknown.admission?.priority.query, -6);
    assert.equal(explainUrl(path, 'https://never.example/logo.png', NOW).admission?.verdict, 'LOW_VALUE'); assert.equal(explainUrl(path, 'http://127.0.0.1/', NOW).admission?.verdict, 'IP_LITERAL');
    const flight = explainUrl(path, 'https://seed.example/', NOW); assert.ok(flight.row); assert.deepEqual(readFileSync(path), bytes);
    const done = new DatabaseSync(path, { readOnly: true }); const doneUrl = (done.prepare(`SELECT url FROM urls WHERE state='DONE'`).get() as { url: string }).url; done.close();
    assert.ok(explainUrl(path, doneUrl, NOW).blockers.some(b => b.includes('DONE')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explain refuses a schema 3 database with an instruction instead of guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privasearch-v3x-')); const path = join(dir, 'p.sqlite');
  try { writeFileSync(path, gunzipSync(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'privasearch-0.4.1-schema3.sqlite.gz')))); assert.throws(() => explainUrl(path, 'https://en.wiki.test/wiki/ChatGPT', NOW), /older than schema 4/); assert.throws(() => prune(path, { now: NOW, apply: false }), /older than schema 4/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concentration: one domain holding most of the frontier is a warning with numbers, a balanced frontier is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privasearch-conc-')); const path = join(dir, 'p.sqlite');
  try {
    const db = openDatabase(path); const f = new Frontier(db, { maxUrlsPerHost: 1e6, maxPendingPerDomain: 1e6, maxPendingPerFamily: 1e6, preferredLanguages: ['*'] });
    for (let i = 0; i < 300; i++) f.add(`https://big.org/p${i}`, { queue: 'PUBLIC', priority: 10, depth: 1, source: 'discovered' }, NOW);
    for (let i = 0; i < 20; i++) f.add(`https://s${i}.net/`, { queue: 'PUBLIC', priority: 10, depth: 1, source: 'discovered' }, NOW);
    const c = f.concentration(NOW); assert.equal(c.pending.topDomain, 'big.org'); assert.ok(c.pending.top1 > 0.9); assert.ok(c.pending.herfindahl > 0.8); assert.ok(c.pending.effectiveDomains < 1.3); assert.equal(c.warnings.length, 2);
    assert.strictEqual(f.concentration(NOW + 1000), c); // cached for 15 s
    db.exec(`DELETE FROM urls WHERE domain='big.org'`); const balanced = f.concentration(NOW + 20000); assert.equal(balanced.warnings.length, 0); assert.ok(balanced.pending.effectiveDomains > 19); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the command line: analyze --json, explain, prune dry-run then apply, backup; bad input exits 2 and nothing is written to a missing database', () => {
  const { dir, path } = build();
  try {
    const run = (...a: string[]) => execFileSync(process.execPath, [CLI, ...a, '--db', path], { env: cliEnv, encoding: 'utf8' });
    const report = JSON.parse(run('analyze', '--json')) as { pending: { total: number } }; assert.ok(report.pending.total > 100);
    assert.match(run('explain', 'https://small1.net/page'), /Domain small1\.net/);
    const dry = run('prune', '--dry-run', '--keep-per-domain', '20'); assert.match(dry, /DRY RUN/);
    const bytes = readFileSync(path); run('prune', '--dry-run'); assert.deepEqual(readFileSync(path), bytes);
    assert.match(run('prune', '--apply', '--keep-per-domain', '20'), /APPLIED/);
    const out = join(dir, 'backup.sqlite'); assert.match(run('backup', '--out', out), /backup written/); assert.ok(existsSync(out)); const copy = new DatabaseSync(out, { readOnly: true }); assert.ok(Number((copy.prepare('SELECT COUNT(*) AS n FROM urls').get() as { n: number }).n) > 0); copy.close();
    const again = spawnSync(process.execPath, [CLI, 'backup', '--out', out, '--db', path], { env: cliEnv, encoding: 'utf8' }); assert.equal(again.status, 2); assert.match(again.stderr, /refusing to overwrite/);
    assert.equal(spawnSync(process.execPath, [CLI, 'frobnicate'], { env: cliEnv, encoding: 'utf8' }).status, 2);
    const missing = join(dir, 'nothing.sqlite'); assert.equal(spawnSync(process.execPath, [CLI, 'analyze', '--db', missing], { env: cliEnv, encoding: 'utf8' }).status, 2); assert.equal(existsSync(missing), false);
    assert.equal(spawnSync(process.execPath, [CLI, 'prune', '--apply', '--dry-run', '--db', path], { env: cliEnv, encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [CLI, 'analyze', '--db', path], { env: { ...cliEnv, PRIVASEARCH_EXPLORE_SHARES: '50/20/10' }, encoding: 'utf8' }).status, 78); // the service's own validation
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seeds: classes come from the seed file, health from what actually happened, and the view is read-only', async () => {
  const { parseServiceConfig, ConfigError } = await import('../src/service-config.js');
  const config = parseServiceConfig({}, '# comment\nhttps://seed.example/ class=official\nhttps://other.example/docs\n');
  assert.deepEqual(config.seeds, ['https://seed.example/', 'https://other.example/docs']); assert.deepEqual(config.seedClasses, { 'https://seed.example/': 'official' });
  assert.throws(() => parseServiceConfig({}, 'https://a.example/ klass=docs'), ConfigError);
  const { seedHealth, formatSeeds, domainDetail, formatDomain } = await import('../src/inspect.js');
  const { dir, path } = build();
  try {
    const db = openDatabase(path); const f = new Frontier(db, {}); f.markSeedClass('https://seed.example/', 'official');
    db.prepare(`UPDATE urls SET state='DONE', last_outcome='FETCHED', last_http=200, fetched_at=? WHERE url='https://seed.example/'`).run(NOW);
    f.add('https://dead.example/', { queue: 'PUBLIC', source: 'seed' }, NOW); db.prepare(`UPDATE urls SET state='DONE', last_outcome='HTTP_ERROR', last_http=404 WHERE url='https://dead.example/'`).run();
    f.add('https://moved.example/start', { queue: 'PUBLIC', source: 'seed' }, NOW); db.prepare(`UPDATE urls SET state='DONE', last_outcome='REDIRECT' WHERE url='https://moved.example/start'`).run(); db.close();
    const bytes = readFileSync(path); const health = seedHealth(path, NOW + 1000);
    const verdict = (url: string) => health.find(h => h.url === url)?.verdict;
    assert.equal(verdict('https://seed.example/'), 'HEALTHY'); assert.equal(verdict('https://dead.example/'), 'DEGRADED'); assert.equal(verdict('https://moved.example/start'), 'REDIRECTED');
    assert.equal(health.find(h => h.url === 'https://seed.example/')?.seedClass, 'official'); assert.match(formatSeeds(health), /DEGRADED.*dead\.example/);
    const detail = domainDetail(path, 'big.org', NOW); assert.ok(detail); assert.ok(detail.pending > 100); assert.ok(detail.topPending.length === 10 && detail.topPending[0]!.priority >= detail.topPending[9]!.priority); assert.match(formatDomain(detail), /Domain big\.org/);
    assert.equal(domainDetail(path, 'nonexistent.example', NOW), undefined); assert.deepEqual(readFileSync(path), bytes);
    const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a, '--db', path], { env: cliEnv, encoding: 'utf8' });
    assert.match(cli('seeds').stdout, /3 seed\(s\)|seed\(s\)/); assert.match(cli('domain', 'big.org').stdout, /Top pending/); assert.equal(cli('domain', 'nope.example').status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
