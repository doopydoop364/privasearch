import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './db.js';
import { languagePreferred, lowValueUrl, urlLanguageHint } from './language.js';
import { crawlTrap } from './policy.js';
import { resolvePolicy } from './policy-options.js';
import type { CrawlPolicyOptions, ResolvedCrawlPolicy } from './policy-options.js';

/**
 * Safe frontier pruning. A large frontier full of low-value pending URLs costs disk and slows maintenance; pruning removes URLs that were never fetched and that
 * the current rules would not admit today, that have waited too long, or that exceed a budget, lowest priority first.
 *
 * WHAT IS NEVER REMOVED: explicit demand (queue DEMAND or source demand), seeds, redirect targets, anything that is not PENDING (done, failed, in flight, blocked:
 * the recrawl and failure history), anything ever fetched, anything at or above `protectPriority` (default 60: seeds, strong external discoveries), and every
 * document, link and full-text row (pruning touches `urls` only). A pruned URL is simply forgotten: if a page links to it again it is re-admitted under the current rules.
 *
 * REASONS, applied in this order (a URL is counted once, under the first that applies):
 *   EXPIRED          waited longer than `expireMs` (default 30 days) below `protectPriority`
 *   NOW_LOW_VALUE    a media/binary file, an edit/history/diff view, a login or cart page (the admission rule of today)
 *   NOW_TRAP         a calendar, session, filter or deep-pagination URL (the admission rule of today)
 *   NOW_LANGUAGE     language hint outside the preferred languages, when languageMode is 'filter'
 *   DOMAIN_OVER_CAP  beyond `keepPerDomain` pending URLs for its domain (lowest priority first)
 *   GLOBAL_OVER_CAP  beyond `maxTotal` pending URLs overall (lowest priority first)
 *
 * `dry-run` and `apply` run the same plan; apply deletes in short transactions of `batch` rows, so the service is never blocked for long, and stops cleanly between
 * batches when `signal` aborts. Take a backup first (`frontier-cli backup`).
 */
export type PruneReason = 'EXPIRED' | 'NOW_LOW_VALUE' | 'NOW_TRAP' | 'NOW_LANGUAGE' | 'DOMAIN_OVER_CAP' | 'GLOBAL_OVER_CAP';
export interface PruneOptions {
  now: number; expireMs?: number; protectPriority?: number; keepPerDomain?: number; maxTotal?: number; batch?: number; apply: boolean; signal?: AbortSignal; policy?: CrawlPolicyOptions;
}
export interface PruneReport {
  applied: boolean; interrupted: boolean; pendingBefore: number; pendingAfter: number; candidates: number; removed: number;
  byReason: Record<PruneReason, number>; topDomains: Array<{ domain: string; removed: number; pendingBefore: number }>; protectedPending: number;
}
const ELIGIBLE = `state='PENDING' AND queue='PUBLIC' AND source='discovered' AND attempts=0 AND fetched_at IS NULL`;

export function prune(dbPath: string, options: PruneOptions): PruneReport {
  const steps = pruneSteps(dbPath, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Event-loop-aware entry point for the CLI: signals are delivered between transactions. */
export async function pruneAsync(dbPath: string, options: PruneOptions): Promise<PruneReport> {
  const steps = pruneSteps(dbPath, options);
  for (;;) { const step = steps.next(); if (step.done) return step.value; await yieldToEvents(); }
}

function* pruneSteps(dbPath: string, options: PruneOptions): Generator<void, PruneReport> {
  const db = new DatabaseSync(dbPath, options.apply ? {} : { readOnly: true });
  try {
    if (!options.apply) db.exec('PRAGMA query_only=ON;'); else db.exec('PRAGMA busy_timeout=5000;');
    if (Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) < 4) throw new Error('this database is older than schema 4: start PrivaSearch once (it migrates the database) before pruning');
    return yield* run(db, options, resolvePolicy(options.policy));
  } finally { db.close(); }
}

function* run(db: DatabaseSync, o: PruneOptions, policy: ResolvedCrawlPolicy): Generator<void, PruneReport> {
  const expireMs = o.expireMs ?? 30 * 86400000; const protect = o.protectPriority ?? 60; const keep = o.keepPerDomain ?? policy.maxPendingPerDomain; const maxTotal = o.maxTotal ?? policy.maxPendingTotal; const batch = Math.max(1, o.batch ?? 1000);
  const n = (sql: string, ...a: Array<number | string>) => Number((db.prepare(sql).get(...a) as { n: number }).n);
  const report: PruneReport = { applied: o.apply, interrupted: false, pendingBefore: n(`SELECT n FROM states WHERE state='PENDING'`), pendingAfter: 0, candidates: 0, removed: 0,
    byReason: { EXPIRED: 0, NOW_LOW_VALUE: 0, NOW_TRAP: 0, NOW_LANGUAGE: 0, DOMAIN_OVER_CAP: 0, GLOBAL_OVER_CAP: 0 }, topDomains: [], protectedPending: 0 };
  const removedBy = new Map<string, number>(); const note = (domain: string, reason: PruneReason, count: number) => { report.byReason[reason] += count; report.candidates += count; removedBy.set(domain, (removedBy.get(domain) ?? 0) + count); };
  const stop = () => { if (o.signal?.aborted) { report.interrupted = true; return true; } return false; };
  // The service can promote or lease a row after it was selected here. Recheck
  // all protection predicates in the write transaction before removing it.
  const del = db.prepare(`DELETE FROM urls WHERE url_key = ? AND ${ELIGIBLE} AND priority < ?`);

  // Pass A: row-by-row rules, streamed in primary-key order in chunks so memory stays flat on a frontier of any size.
  let after = ''; const chunk = db.prepare(`SELECT url_key, url, domain, priority, discovered_at FROM urls WHERE ${ELIGIBLE} AND priority < ? AND url_key > ? ORDER BY url_key LIMIT ?`);
  for (;;) {
    if (stop()) break;
    const rows = chunk.all(protect, after, batch) as unknown as Array<{ url_key: string; url: string; domain: string; priority: number; discovered_at: number }>; if (rows.length === 0) break;
    after = rows[rows.length - 1]!.url_key; const doomed: Array<{ key: string; domain: string; reason: PruneReason }> = [];
    for (const r of rows) {
      const reason: PruneReason | undefined = o.now - r.discovered_at > expireMs ? 'EXPIRED' : lowValueUrl(r.url) ? 'NOW_LOW_VALUE' : crawlTrap(r.url) ? 'NOW_TRAP'
        : policy.languageMode === 'filter' && !languagePreferred(urlLanguageHint(r.url), policy.preferredLanguages) ? 'NOW_LANGUAGE' : undefined;
      if (reason) doomed.push({ key: r.url_key, domain: r.domain, reason });
    }
    if (o.apply && doomed.length > 0) inTransaction(db, () => {
      for (const d of doomed) if (Number(del.run(d.key, protect).changes) > 0) { note(d.domain, d.reason, 1); report.removed++; }
    });
    else if (!o.apply) for (const d of doomed) note(d.domain, d.reason, 1);
    yield;
  }

  // Pass B: domains over their pending cap lose their lowest-priority eligible URLs. Dry-run subtracts what pass A would already have removed.
  if (!report.interrupted) {
    const over = db.prepare('SELECT domain, pending FROM domains WHERE pending > ? ORDER BY pending DESC, domain').all(keep) as unknown as Array<{ domain: string; pending: number }>;
    for (const d of over) {
      if (stop()) break;
      const pendingNow = o.apply ? n('SELECT pending AS n FROM domains WHERE domain=?', d.domain) : d.pending - (removedBy.get(d.domain) ?? 0);
      const eligible = n(`SELECT COUNT(*) AS n FROM urls WHERE domain=? AND ${ELIGIBLE} AND priority < ?`, d.domain, protect) - (o.apply ? 0 : removedBy.get(d.domain) ?? 0);
      const extra = Math.min(eligible, Math.max(0, pendingNow - keep)); if (extra === 0) continue;
      const count = o.apply ? yield* removeLowest(db, `domain=? AND ${ELIGIBLE} AND priority < ?`, [d.domain, protect], extra, batch, o.signal) : extra;
      if (o.apply) report.removed += count;
      note(d.domain, 'DOMAIN_OVER_CAP', count);
      if (stop()) break;
      yield;
    }
  }
  // Pass C: the global budget, lowest priority first across the whole frontier.
  if (!report.interrupted) {
    const planned = o.apply ? 0 : report.candidates; const total = report.pendingBefore - (o.apply ? report.removed : planned); const extra = Math.max(0, total - maxTotal);
    if (extra > 0) {
      const eligible = n(`SELECT COUNT(*) AS n FROM urls WHERE ${ELIGIBLE} AND priority < ?`, protect) - (o.apply ? 0 : planned); const take = Math.min(extra, Math.max(0, eligible));
      if (take > 0) {
        const count = o.apply ? yield* removeLowest(db, `${ELIGIBLE} AND priority < ?`, [protect], take, batch, o.signal) : take;
        if (o.apply) report.removed += count;
        note('(all domains)', 'GLOBAL_OVER_CAP', count); stop();
      }
    }
  }
  report.pendingAfter = o.apply ? n(`SELECT n FROM states WHERE state='PENDING'`) : report.pendingBefore - report.candidates;
  report.protectedPending = n(`SELECT COUNT(*) AS n FROM urls WHERE state='PENDING' AND NOT (${ELIGIBLE} AND priority < ${Math.trunc(protect)})`);
  report.topDomains = [...removedBy.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([domain, removed]) => ({ domain, removed, pendingBefore: domain === '(all domains)' ? report.pendingBefore : n('SELECT COALESCE((SELECT pending FROM domains WHERE domain=?),0) AS n', domain) + (o.apply ? removed : 0) }));
  return report;
}

/** Deletes up to `count` matching rows, lowest priority first (newest first on a tie), `batch` per transaction. */
function* removeLowest(db: DatabaseSync, where: string, args: Array<number | string>, count: number, batch: number, signal?: AbortSignal): Generator<void, number> {
  let removed = 0;
  while (removed < count && !signal?.aborted) {
    const take = Math.min(batch, count - removed);
    const changes = inTransaction(db, () => Number(db.prepare(`DELETE FROM urls WHERE url_key IN (SELECT url_key FROM urls WHERE ${where} ORDER BY priority ASC, discovered_at DESC, url_key LIMIT ?)`).run(...args, take).changes));
    if (changes === 0) break; removed += changes;
    yield;
  }
  return removed;
}

export function formatPrune(r: PruneReport): string {
  const lines = [`${r.applied ? 'APPLIED' : 'DRY RUN (nothing was changed)'}: pending ${r.pendingBefore} -> ${r.pendingAfter}; ${r.applied ? `removed ${r.removed}` : `would remove ${r.candidates}`}${r.interrupted ? ' (interrupted between batches)' : ''}`,
    `By reason: ${Object.entries(r.byReason).map(([k, v]) => `${k}=${v}`).join(' ')}`, `Protected pending URLs (demand, seeds, redirects, high priority, retried): ${r.protectedPending}`, 'Most affected domains:'];
  for (const d of r.topDomains) lines.push(`  ${String(d.removed).padStart(9)}  of ${String(d.pendingBefore).padStart(9)}  ${d.domain}`);
  if (!r.applied) lines.push('To apply: take a backup first (frontier-cli backup --db PATH --out FILE), then run the same command with --apply.');
  return lines.join('\n');
}
