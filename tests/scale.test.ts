import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { openDatabase } from '../src/db.js';
import { Frontier } from '../src/frontier.js';
import { pageResult } from '../src/privanet/fake-transport.js';

// A smoke check that the hot paths stay index-driven: with 10 000 pending URLs (one giant domain with 40 hosts, many small ones) a lease of 8 must not scan the table.
// The limits are generous (ten times what the benchmark in tests/bench/scale.ts measures) so a slow CI machine does not make this flaky, but a return to a full scan
// (tens of milliseconds per lease at this size, seconds at 100k) still fails it. tests/bench/scale.ts prints the real numbers.
test('leasing and completing stay fast with 10 000 pending URLs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-scale-')); const db = openDatabase(join(dir, 'f.sqlite'));
  try {
    const frontier = new Frontier(db, {}); let now = 1_700_000_000_000; const n = 10000; const domains = 250;
    db.exec('BEGIN'); for (let i = 0; i < n; i++) { const host = i % 10 < 6 ? `l${i % 40}.wiki.example` : `site${i % domains}.example`; frontier.add(`https://${host}/p/${i}`, { queue: 'PUBLIC', source: 'seed', priority: 10 }, now); } db.exec('COMMIT');
    const times: number[] = []; let leased = 0; const domainsSeen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      now += 5000; const t = performance.now(); const batch = frontier.lease(now, 8); times.push(performance.now() - t); leased += batch.length;
      for (const l of batch) { domainsSeen.add(new URL(l.url).hostname.split('.').slice(-2).join('.')); frontier.complete(l.urlKey, pageResult(l.url, now, { title: 't', text: 'x'.repeat(200) }), now); }
    }
    assert.ok(leased >= 600, `leased ${leased}`); assert.ok(domainsSeen.size > 1, 'more than one registrable domain was served');
    times.sort((a, b) => a - b); assert.ok(times[50]! < 100, `median lease ${times[50]}ms`); assert.ok(times[98]! < 500, `p98 lease ${times[98]}ms`);
    const counts = frontier.stats(); assert.equal(counts.PENDING + counts.DONE + counts.IN_FLIGHT + counts.FAILED + counts.BLOCKED, n);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
