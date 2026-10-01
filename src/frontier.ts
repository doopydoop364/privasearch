import { DatabaseSync } from 'node:sqlite';
import type { FetchResult } from './privanet/contract.js';
import type { Queue } from './privanet/transport.js';
import { initSchema, inTransaction } from './db.js';
import { crawlTrap } from './policy.js';
import type { TrapReason } from './policy.js';
import { parseCrawlUrl, urlKey } from './url.js';
import type { UrlRejection } from './url.js';

/**
 * The URL frontier: what to crawl, in what order, how politely, and when to look again. This is PrivaSearch crawl policy and
 * lives here, not in PrivaNet. The node enforces its own limits as defence in depth, but the frontier is the primary limiter:
 * at most one in-flight request per host, a minimum delay between requests to a host (raised by robots Crawl-delay), exponential
 * backoff on errors and Retry-After, a per-host URL budget and a crawl-trap guard for discovered links.
 *
 * Recrawl is adaptive. Each URL carries its own interval: a page whose content hash changed is looked at again sooner (the interval
 * halves, down to `recrawlMinMs`), a page that did not change is looked at less often (the interval doubles, up to `recrawlMaxMs`, or
 * `importantRecrawlMaxMs` for a page many other hosts link to). Failed URLs back off, and a URL that kept failing is retried rarely
 * (`failedRecheckMs`) instead of never.
 */
export interface FrontierOptions {
  hostDelayMs?: number; maxAttempts?: number; backoffBaseMs?: number; maxBackoffMs?: number;
  /** The first recrawl interval after a URL is fetched for the first time. */
  recrawlMs?: number; recrawlMinMs?: number; recrawlMaxMs?: number; importantRecrawlMaxMs?: number;
  goneRecheckMs?: number; failedRecheckMs?: number; staleLeaseMs?: number; maxDepth?: number;
  /** Discovered URLs per host the frontier will hold; seeds, redirects and demand requests are not counted against it. */
  maxUrlsPerHost?: number;
  /** The share of each lease reserved for recrawls (when any are due), so endless discovery cannot starve refreshing and the reverse. */
  recrawlShare?: number;
}
export interface Leased { urlKey: string; url: string; host: string; queue: Queue; generation: number; depth: number; validators?: { etag?: string; lastModified?: string } }
export type AddResult = 'ADDED' | 'EXISTS' | UrlRejection | 'TOO_DEEP' | 'HOST_BUDGET' | `TRAP:${TrapReason}`;
export type State = 'PENDING' | 'IN_FLIGHT' | 'DONE' | 'BLOCKED' | 'FAILED';
export type Source = 'seed' | 'demand' | 'discovered' | 'redirect';
export interface UrlRow { url_key: string; url: string; host: string; queue: Queue; priority: number; state: State; generation: number; attempts: number; next_at: number; depth: number; last_outcome: string | null; last_http: number | null; etag: string | null; last_modified: string | null; content_sha256: string | null; fetched_at: number | null; leased_at: number | null; interval_ms: number | null; change_count: number; unchanged_streak: number; last_changed_at: number | null }

const DAY = 86400000;
const HOUR = 3600000;

export class Frontier {
  private readonly o: Required<FrontierOptions>;
  /** Single-slot leases alternate between new and recrawl work in a fixed pattern (one in four is a recrawl) so the share holds for limit 1 too. */
  private singleSlotTurn = 0;
  constructor(private readonly db: DatabaseSync, options: FrontierOptions = {}) {
    this.o = { hostDelayMs: 2000, maxAttempts: 5, backoffBaseMs: 60000, maxBackoffMs: 6 * HOUR, recrawlMs: 7 * DAY, recrawlMinMs: 6 * HOUR, recrawlMaxMs: 60 * DAY, importantRecrawlMaxMs: 14 * DAY,
      goneRecheckMs: 30 * DAY, failedRecheckMs: 30 * DAY, staleLeaseMs: 300000, maxDepth: 8, maxUrlsPerHost: 2000, recrawlShare: 0.25, ...options };
    initSchema(db);
  }
  private transaction<T>(work: () => T): T { return inTransaction(this.db, work); }
  /** Runs `work` (frontier and document changes on this database) as one unit: all of it or none of it. */
  atomically<T>(work: () => T): T { return inTransaction(this.db, work); }
  private backoff(attempts: number): number { return Math.min(this.o.maxBackoffMs, this.o.backoffBaseMs * 2 ** Math.max(0, attempts - 1)); }

  add(raw: string, options: { queue: Queue; priority?: number; depth?: number; source?: Source }, now: number): AddResult {
    const parsed = parseCrawlUrl(raw); if (!parsed.ok) return parsed.reason;
    const depth = options.depth ?? 0; if (depth > this.o.maxDepth) return 'TOO_DEEP';
    const key = urlKey(parsed.url); const priority = options.priority ?? 0;
    const known = this.db.prepare('SELECT queue, priority FROM urls WHERE url_key=?').get(key) as { queue: Queue; priority: number } | undefined;
    if (known) {
      // Demand promotes a URL already known as public work, so explicit user demand is never queued behind discovery; a better priority is kept.
      if (options.queue === 'DEMAND') {
        this.db.prepare(`UPDATE urls SET queue='DEMAND', priority=MAX(priority, ?) WHERE url_key=? AND state='PENDING'`).run(priority, key);
        // Due now, unless it is waiting out a failure backoff: demand never turns repeated searches into repeated hits on a failing URL.
        this.db.prepare(`UPDATE urls SET next_at=MIN(next_at, ?) WHERE url_key=? AND state='PENDING' AND attempts=0`).run(now, key);
      }
      else if (priority > known.priority) this.db.prepare(`UPDATE urls SET priority=? WHERE url_key=?`).run(priority, key);
      return 'EXISTS';
    }
    if (options.source === 'discovered') {
      const trap = crawlTrap(parsed.url); if (trap) return `TRAP:${trap}`;
      const held = Number((this.db.prepare('SELECT COUNT(*) AS n FROM urls WHERE host=?').get(parsed.host) as { n: number }).n);
      if (held >= this.o.maxUrlsPerHost) return 'HOST_BUDGET';
    }
    this.db.prepare(`INSERT OR IGNORE INTO urls (url_key, url, host, queue, priority, state, next_at, depth, discovered_at) VALUES (?,?,?,?,?, 'PENDING', ?, ?, ?)`)
      .run(key, parsed.url, parsed.host, options.queue, priority, now, depth, now);
    return 'ADDED';
  }

  /**
   * DONE means "fresh until next_at": a finished URL becomes due again for recrawl. Leases at most one due URL per host, and none for a host that
   * already has one in flight or is waiting out its delay or backoff. Order: explicit demand first; then a reserved share for due recrawls (most
   * overdue first) and the rest for new URLs (highest priority, then oldest); whatever either side cannot use goes to the other.
   */
  lease(now: number, limit: number): Leased[] {
    return this.transaction(() => {
      const want = Math.max(1, limit); const hosts = new Set<string>(); const out: Leased[] = [];
      const due = `u.next_at <= ? AND COALESCE(h.next_allowed_at,0) <= ? AND COALESCE(h.backoff_until,0) <= ? AND NOT EXISTS (SELECT 1 FROM urls x WHERE x.host = u.host AND x.state='IN_FLIGHT')`;
      const select = (where: string, order: string, cap: number) => this.db.prepare(`SELECT u.* FROM urls u LEFT JOIN hosts h ON h.host = u.host WHERE ${where} AND ${due} ORDER BY ${order} LIMIT ?`)
        .all(now, now, now, Math.max(1, cap) * 8) as unknown as UrlRow[];
      const take = (rows: UrlRow[], cap: number) => {
        let taken = 0;
        for (const row of rows) {
          if (taken >= cap || out.length >= want) break; if (hosts.has(row.host)) continue; hosts.add(row.host);
          this.db.prepare(`UPDATE urls SET state='IN_FLIGHT', leased_at=? WHERE url_key=?`).run(now, row.url_key);
          const validators = { ...(row.etag ? { etag: row.etag } : {}), ...(row.last_modified ? { lastModified: row.last_modified } : {}) };
          // A recrawl is background work whatever queue first brought the URL in; only a pending demand request uses the demand credential.
          const queue: Queue = row.state === 'PENDING' ? row.queue : 'PUBLIC';
          out.push({ urlKey: row.url_key, url: row.url, host: row.host, queue, generation: row.generation, depth: row.depth, ...(Object.keys(validators).length ? { validators } : {}) }); taken++;
        }
      };
      take(select(`u.state='PENDING' AND u.queue='DEMAND'`, 'u.priority DESC, u.next_at, u.url_key', want), want);
      const rest = want - out.length; if (rest <= 0) return out;
      const recrawlQuota = rest >= 2 ? Math.ceil(rest * this.o.recrawlShare) : (this.singleSlotTurn++ % 4 === 3 ? 1 : 0);
      const fresh = () => select(`u.state='PENDING' AND u.queue='PUBLIC'`, 'u.priority DESC, u.next_at, u.url_key', rest);
      const recrawl = () => select(`u.state IN ('DONE','FAILED')`, `CASE u.state WHEN 'DONE' THEN 0 ELSE 1 END, u.next_at, u.url_key`, rest);
      take(recrawl(), recrawlQuota);
      take(fresh(), rest);
      take(recrawl(), rest);
      return out;
    });
  }

  /** Returns leases that were never completed (a crash, a lost result) to the queue without counting an attempt. */
  requeueStale(now: number): number {
    return Number(this.db.prepare(`UPDATE urls SET state='PENDING', leased_at=NULL WHERE state='IN_FLIGHT' AND leased_at <= ?`).run(now - this.o.staleLeaseMs).changes);
  }
  /** At service start: nothing can still be in flight in a process that just began, so every lease the previous process held is returned (the idempotency key makes a resubmission safe). */
  requeueAll(): number { return Number(this.db.prepare(`UPDATE urls SET state='PENDING', leased_at=NULL WHERE state='IN_FLIGHT'`).run().changes); }

  /** The submission got no result (Coordinator unreachable, queue full): try again later, same generation so the job is deduplicated. */
  release(key: string, now: number, delayMs: number): void {
    this.db.prepare(`UPDATE urls SET state='PENDING', leased_at=NULL, next_at=? WHERE url_key=? AND state='IN_FLIGHT'`).run(now + delayMs, key);
  }

  /** The result was unusable (failed validation, wrong URL): counts as a failed attempt with backoff and a new generation. */
  fail(key: string, now: number, reason: string): void { this.retryLater(key, now, reason, null, null); }

  private settle(key: string, now: number, outcome: string, http: number | null, next: number, state: State = 'DONE', extra: { etag?: string | null; lastModified?: string | null; sha?: string | null; fetched?: boolean; interval?: number | null; changed?: boolean | null } = {}): void {
    const changed = extra.changed === undefined || extra.changed === null ? -1 : extra.changed ? 1 : 0;
    this.db.prepare(`UPDATE urls SET state=?, next_at=?, attempts=0, generation=generation+1, last_outcome=?, last_http=?, leased_at=NULL,
      queue=CASE WHEN ?='DONE' THEN 'PUBLIC' ELSE queue END,
      etag=COALESCE(?, etag), last_modified=COALESCE(?, last_modified), content_sha256=COALESCE(?, content_sha256), fetched_at=CASE WHEN ? THEN ? ELSE fetched_at END,
      interval_ms=COALESCE(?, interval_ms), change_count=change_count + CASE WHEN ?=1 THEN 1 ELSE 0 END,
      unchanged_streak=CASE WHEN ?=1 THEN 0 WHEN ?=0 THEN unchanged_streak+1 ELSE unchanged_streak END,
      last_changed_at=CASE WHEN ?=1 THEN ? ELSE last_changed_at END WHERE url_key=?`)
      .run(state, next, outcome, http, state, extra.etag ?? null, extra.lastModified ?? null, extra.sha ?? null, extra.fetched ? 1 : 0, now, extra.interval ?? null, changed, changed, changed, changed, now, key);
  }
  private retryLater(key: string, now: number, outcome: string, http: number | null, retryAfterMs: number | null): void {
    const row = this.db.prepare('SELECT attempts, host FROM urls WHERE url_key=?').get(key) as { attempts: number; host: string } | undefined; if (!row) return;
    const attempts = row.attempts + 1; const wait = Math.max(this.backoff(attempts), retryAfterMs ?? 0);
    if (attempts >= this.o.maxAttempts) {
      // Out of attempts: not forgotten, but looked at only rarely and after everything else (the lease order puts FAILED last).
      this.db.prepare(`UPDATE urls SET state='FAILED', attempts=?, generation=generation+1, last_outcome=?, last_http=?, leased_at=NULL, next_at=? WHERE url_key=?`).run(attempts, outcome, http, now + this.o.failedRecheckMs, key);
    } else {
      this.db.prepare(`UPDATE urls SET state='PENDING', attempts=?, generation=generation+1, last_outcome=?, last_http=?, leased_at=NULL, next_at=? WHERE url_key=?`).run(attempts, outcome, http, now + wait, key);
    }
    this.db.prepare(`INSERT INTO hosts (host, backoff_until, failures) VALUES (?,?,1) ON CONFLICT(host) DO UPDATE SET backoff_until=MAX(backoff_until, excluded.backoff_until), failures=failures+1`).run(row.host, now + wait);
  }

  /**
   * The next recrawl interval for a URL that was just looked at. `changed` is true when the content hash differs from the previous fetch,
   * false when it is the same (or the server said 304), and null on a first fetch or when nothing can be told (a probe).
   */
  private nextInterval(key: string, previous: number | null, changed: boolean | null): number {
    const current = previous ?? this.o.recrawlMs;
    if (changed === null) return current;
    if (changed) return Math.max(this.o.recrawlMinMs, Math.round(current / 2));
    const inbound = Number((this.db.prepare('SELECT COUNT(DISTINCT src_host) AS n FROM links WHERE dst_key=? AND src_host<>dst_host').get(key) as { n: number }).n);
    return Math.min(inbound >= 5 ? Math.min(this.o.recrawlMaxMs, this.o.importantRecrawlMaxMs) : this.o.recrawlMaxMs, current * 2);
  }

  /** Applies one validated fetch result. Every one of the twelve outcomes has an explicit policy here. */
  complete(key: string, result: FetchResult, now: number): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT host, queue, priority, depth, content_sha256, interval_ms FROM urls WHERE url_key=?').get(key) as { host: string; queue: Queue; priority: number; depth: number; content_sha256: string | null; interval_ms: number | null } | undefined; if (!row) return;
      const delay = Math.max(this.o.hostDelayMs, (result.robots.crawlDelaySec ?? 0) * 1000);
      // Requesting a host, whatever came back, spends its politeness budget; a success clears its failure streak.
      this.db.prepare(`INSERT INTO hosts (host, next_allowed_at) VALUES (?,?) ON CONFLICT(host) DO UPDATE SET next_allowed_at=MAX(next_allowed_at, excluded.next_allowed_at)`).run(row.host, now + delay);
      const http = result.httpStatus ?? null; const gone = now + this.o.goneRecheckMs;
      switch (result.outcome) {
        case 'FETCHED': {
          const changed = row.content_sha256 === null || result.contentSha256 === undefined ? null : row.content_sha256 !== result.contentSha256;
          const interval = this.nextInterval(key, row.interval_ms, changed);
          this.settle(key, now, 'FETCHED', http, now + interval, 'DONE', { etag: result.etag ?? null, lastModified: result.lastModified ?? null, sha: result.contentSha256 ?? null, fetched: true, interval, changed });
          this.db.prepare('UPDATE hosts SET failures=0 WHERE host=?').run(row.host); break; }
        case 'NOT_MODIFIED': { // the server confirmed nothing changed: the same signal as an identical hash
          const interval = this.nextInterval(key, row.interval_ms, false);
          this.settle(key, now, 'NOT_MODIFIED', http, now + interval, 'DONE', { fetched: true, interval, changed: false }); this.db.prepare('UPDATE hosts SET failures=0 WHERE host=?').run(row.host); break; }
        case 'PROBED': this.settle(key, now, 'PROBED', http, now + (row.interval_ms ?? this.o.recrawlMs), 'DONE', { etag: result.etag ?? null, lastModified: result.lastModified ?? null, fetched: true }); break;
        case 'REDIRECT': // done for this URL; the target is a new URL that goes through normal admission, robots and host policy
          this.settle(key, now, 'REDIRECT', http, gone, 'DONE');
          if (result.redirectTarget) this.add(result.redirectTarget, { queue: row.queue, priority: row.priority, depth: row.depth, source: 'redirect' }, now); break;
        case 'ROBOTS_DISALLOWED': this.settle(key, now, 'ROBOTS_DISALLOWED', null, now + DAY, 'PENDING'); break; // recheck: robots.txt changes
        case 'ROBOTS_UNAVAILABLE': this.retryLater(key, now, 'ROBOTS_UNAVAILABLE', null, null); break;
        case 'BLOCKED_TARGET': this.settle(key, now, 'BLOCKED_TARGET', null, gone, 'BLOCKED'); break; // the node refused it; never retry blindly
        case 'RATE_LIMITED': { // not a failure of the URL: wait as told, do not count an attempt
          const wait = Math.max(delay, (result.retryAfterSec ?? 0) * 1000);
          this.db.prepare(`UPDATE urls SET state='PENDING', generation=generation+1, last_outcome='RATE_LIMITED', leased_at=NULL, next_at=? WHERE url_key=?`).run(now + wait, key);
          this.db.prepare(`UPDATE hosts SET next_allowed_at=MAX(next_allowed_at, ?) WHERE host=?`).run(now + wait, row.host); break; }
        case 'UNSUPPORTED_CONTENT_TYPE': this.settle(key, now, 'UNSUPPORTED_CONTENT_TYPE', http, gone, 'DONE'); break;
        case 'TOO_LARGE': this.settle(key, now, 'TOO_LARGE', http, gone, 'DONE'); break;
        case 'HTTP_ERROR': {
          const status = result.httpStatus ?? 0; const after = result.retryAfterSec === undefined ? null : result.retryAfterSec * 1000;
          if (status === 404 || status === 410) this.settle(key, now, 'HTTP_ERROR', status, gone, 'DONE');
          else if (status === 429 || status >= 500) this.retryLater(key, now, 'HTTP_ERROR', status, after);
          else this.settle(key, now, 'HTTP_ERROR', status, now + 14 * DAY, 'DONE');
          break; }
        case 'FETCH_FAILED':
          if (result.error?.retryable === false) this.settle(key, now, 'FETCH_FAILED', null, now + this.o.failedRecheckMs, 'FAILED');
          else this.retryLater(key, now, 'FETCH_FAILED', null, null);
          break;
      }
    });
  }

  get(key: string): UrlRow | undefined { return this.db.prepare('SELECT * FROM urls WHERE url_key=?').get(key) as unknown as UrlRow | undefined; }
  getByUrl(raw: string): UrlRow | undefined { const parsed = parseCrawlUrl(raw); return parsed.ok ? this.get(urlKey(parsed.url)) : undefined; }
  stats(): Record<State, number> {
    const out: Record<State, number> = { PENDING: 0, IN_FLIGHT: 0, DONE: 0, BLOCKED: 0, FAILED: 0 };
    for (const row of this.db.prepare('SELECT state, COUNT(*) AS n FROM urls GROUP BY state').all() as unknown as Array<{ state: State; n: number }>) out[row.state] = Number(row.n);
    return out;
  }
  /** The demand backlog alone (the planner asks on every weak search; `detail` also counts hosts and due recrawls, which scans the whole frontier). */
  pendingDemand(): number { return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM urls INDEXED BY urls_pending_demand WHERE state='PENDING' AND queue='DEMAND'`).get() as { n: number }).n); }
  /** Counts for operators: the demand backlog, background backlog, and recrawls that are due now. */
  detail(now: number): { pendingDemand: number; pendingPublic: number; recrawlDue: number; hosts: number } {
    const n = (sql: string, ...args: number[]) => Number((this.db.prepare(sql).get(...args) as { n: number }).n);
    return {
      pendingDemand: n(`SELECT COUNT(*) AS n FROM urls WHERE state='PENDING' AND queue='DEMAND'`), pendingPublic: n(`SELECT COUNT(*) AS n FROM urls WHERE state='PENDING' AND queue='PUBLIC'`),
      recrawlDue: n(`SELECT COUNT(*) AS n FROM urls WHERE state IN ('DONE','FAILED') AND next_at <= ?`, now), hosts: n('SELECT COUNT(DISTINCT host) AS n FROM urls'),
    };
  }
}
