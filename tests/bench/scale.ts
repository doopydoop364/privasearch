import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyzeFrontier } from '../../src/analyze.js';
import { openDatabase } from '../../src/db.js';
import { Frontier } from '../../src/frontier.js';
import { pageResult } from '../../src/privanet/fake-transport.js';
import { prune } from '../../src/prune.js';

/**
 * `node dist/tests/bench/scale.js [pendingUrls ...]` times the frontier operations on a file database holding N pending URLs spread over many domains, one of them giant
 * (60% of all URLs, like a wiki). 98% are admitted as discovered URLs (so admission, budgets and traps run on every insert) and 2% are seeds; the budgets are lifted so
 * that the whole set is admitted and prune has real work to plan. Every number printed is measured on this machine in this run; nothing is estimated. The 10k size also runs, with generous limits, in
 * the test suite (tests/scale.test.ts).
 */
const sizes = process.argv.slice(2).map(Number).filter(n => n > 0); if (sizes.length === 0) sizes.push(10000, 100000);
const ms = (t: number) => Math.round(t * 100) / 100;
for (const n of sizes) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-bench-')); const path = join(dir, 'b.sqlite'); const out: Record<string, unknown> = { pending: n };
  try {
    const db = openDatabase(path); const frontier = new Frontier(db, { maxPendingPerDomain: 10_000_000, maxPendingPerFamily: 10_000_000, maxPendingTotal: 100_000_000 }); let now = 1_700_000_000_000;
    const domains = Math.max(50, Math.round(n / 40)); const hosts: string[] = [];
    for (let d = 0; d < domains; d++) hosts.push(`site${d}.example`);
    let t = performance.now(); db.exec('BEGIN');
    for (let i = 0; i < n; i++) { const wiki = i % 10 < 6; const host = wiki ? `l${i % 40}.wiki.example` : hosts[i % domains]!; frontier.add(`https://${host}/p/${i}`, { queue: 'PUBLIC', source: i % 50 === 0 ? 'seed' : 'discovered', depth: 1, priority: 10 }, now); }
    db.exec('COMMIT'); const insert = performance.now() - t; out.insertPerSec = Math.round(n / (insert / 1000)); out.insertAvgMs = ms(insert / n);
    // A steady crawl: lease a batch, complete it (as a fetch would), lease the next. The completions are timed separately.
    const times: number[] = []; const completes: number[] = []; let leasedTotal = 0;
    for (let i = 0; i < 300; i++) {
      now += 5000; const s = performance.now(); const batch = frontier.lease(now, 8); times.push(performance.now() - s); leasedTotal += batch.length;
      for (const l of batch) { const c = performance.now(); frontier.complete(l.urlKey, pageResult(l.url, now, { title: 't', text: 'x'.repeat(300) }), now); frontier.recordPage(l.urlKey, 'useful', now); completes.push(performance.now() - c); }
    }
    times.sort((a, b) => a - b); out.leaseMsP50 = ms(times[150]!); out.leaseMsP99 = ms(times[297]!); out.leaseMsMax = ms(times[299]!);
    out.completeAvgMs = ms(completes.reduce((x, y) => x + y, 0) / Math.max(1, completes.length)); out.leased = leasedTotal;
    t = performance.now(); frontier.stats(); frontier.detail(now + 60000); out.statsMs = ms(performance.now() - t);
    t = performance.now(); frontier.concentration(now + 120000); out.concentrationMs = ms(performance.now() - t);
    t = performance.now(); frontier.operationalHealth(now + 120000); out.operationalHealthMs = ms(performance.now() - t);
    t = performance.now(); frontier.operationalHealth(now + 120001); out.cachedOperationalHealthMs = ms(performance.now() - t);
    db.close();
    t = performance.now(); analyzeFrontier(path); out.analyzeMs = ms(performance.now() - t);
    t = performance.now(); const report = prune(path, { now: now + 40 * 86400000, apply: false, keepPerDomain: 20 }); out.pruneDryRunMs = ms(performance.now() - t); out.pruneCandidates = report.candidates;
    out.dbMB = Math.round(statSync(path).size / 1048576 * 10) / 10;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify(out));
}
