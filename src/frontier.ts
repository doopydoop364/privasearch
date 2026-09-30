import { DatabaseSync } from 'node:sqlite';
import type { FetchResult } from './privanet/fetch-contract.js';
import type { Queue } from './privanet/transport.js';
import { parseCrawlUrl, urlKey } from './url.js';
import type { UrlRejection } from './url.js';

/**
 * The URL frontier: what to crawl, in what order, and how politely. This is PrivaSearch crawl policy and
 * lives here, not in PrivaNet. The node enforces its own limits as defence in depth, but the frontier is
 * the primary limiter: at most one in-flight request per host, a minimum delay between requests to a
 * host (raised by robots Crawl-delay), and exponential backoff on errors and Retry-After.
 */
export interface FrontierOptions {
  hostDelayMs?: number; maxAttempts?: number; backoffBaseMs?: number; maxBackoffMs?: number;
  recrawlMs?: number; goneRecheckMs?: number; staleLeaseMs?: number; maxDepth?: number;
}
export interface Leased { urlKey: string; url: string; host: string; queue: Queue; generation: number; depth: number; validators?: { etag?: string; lastModified?: string } }
export type AddResult = 'ADDED' | 'EXISTS' | UrlRejection | 'TOO_DEEP';
export type State = 'PENDING' | 'IN_FLIGHT' | 'DONE' | 'BLOCKED' | 'FAILED';
export interface UrlRow { url_key: string; url: string; host: string; queue: Queue; priority: number; state: State; generation: number; attempts: number; next_at: number; depth: number; last_outcome: string | null; last_http: number | null; etag: string | null; last_modified: string | null; content_sha256: string | null; fetched_at: number | null; leased_at: number | null }

const DAY = 86400000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS urls (
  url_key TEXT PRIMARY KEY, url TEXT NOT NULL, host TEXT NOT NULL,
  queue TEXT NOT NULL CHECK (queue IN ('DEMAND','PUBLIC')), priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('PENDING','IN_FLIGHT','DONE','BLOCKED','FAILED')),
  generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0, discovered_at INTEGER NOT NULL,
  last_outcome TEXT, last_http INTEGER, etag TEXT, last_modified TEXT, content_sha256 TEXT, fetched_at INTEGER, leased_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS urls_due ON urls(state, next_at);
CREATE INDEX IF NOT EXISTS urls_host ON urls(host, state);
CREATE TABLE IF NOT EXISTS hosts (host TEXT PRIMARY KEY, next_allowed_at INTEGER NOT NULL DEFAULT 0, backoff_until INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0) STRICT;
`;

export class Frontier {
  private readonly o: Required<FrontierOptions>;
  constructor(private readonly db: DatabaseSync, options: FrontierOptions = {}) {
    this.o = { hostDelayMs: 2000, maxAttempts: 5, backoffBaseMs: 60000, maxBackoffMs: 6 * 3600000, recrawlMs: 7 * DAY, goneRecheckMs: 30 * DAY, staleLeaseMs: 300000, maxDepth: 8, ...options };
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;'); db.exec(SCHEMA);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private backoff(attempts: number): number { return Math.min(this.o.maxBackoffMs, this.o.backoffBaseMs * 2 ** Math.max(0, attempts - 1)); }

  add(raw: string, options: { queue: Queue; priority?: number; depth?: number }, now: number): AddResult {
    const parsed = parseCrawlUrl(raw); if (!parsed.ok) return parsed.reason;
    const depth = options.depth ?? 0; if (depth > this.o.maxDepth) return 'TOO_DEEP';
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO urls (url_key, url, host, queue, priority, state, next_at, depth, discovered_at) VALUES (?,?,?,?,?, 'PENDING', ?, ?, ?)`)
      .run(urlKey(parsed.url), parsed.url, parsed.host, options.queue, options.priority ?? 0, now, depth, now);
    if (Number(inserted.changes) === 1) return 'ADDED';
    // A demand request promotes a URL already known as public work, so explicit user demand is never queued behind discovery.
    if (options.queue === 'DEMAND') this.db.prepare(`UPDATE urls SET queue='DEMAND', priority=MAX(priority, ?) WHERE url_key=? AND queue='PUBLIC'`).run(options.priority ?? 0, urlKey(parsed.url));
    return 'EXISTS';
  }

  /** DONE means "fresh until next_at": a finished URL becomes due again for recrawl. Leases at most one due URL per host, and none for a host that already has one in flight or is waiting out its delay or backoff. */
  lease(now: number, limit: number): Leased[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT u.* FROM urls u LEFT JOIN hosts h ON h.host = u.host
        WHERE u.state IN ('PENDING','DONE') AND u.next_at <= ? AND COALESCE(h.next_allowed_at,0) <= ? AND COALESCE(h.backoff_until,0) <= ?
          AND NOT EXISTS (SELECT 1 FROM urls x WHERE x.host = u.host AND x.state='IN_FLIGHT')
        ORDER BY CASE u.queue WHEN 'DEMAND' THEN 0 ELSE 1 END, u.priority DESC, u.next_at, u.url_key LIMIT ?`).all(now, now, now, Math.max(1, limit) * 8) as unknown as UrlRow[];
      const hosts = new Set<string>(); const out: Leased[] = [];
      for (const row of rows) {
        if (out.length >= limit) break; if (hosts.has(row.host)) continue; hosts.add(row.host);
        this.db.prepare(`UPDATE urls SET state='IN_FLIGHT', leased_at=? WHERE url_key=?`).run(now, row.url_key);
        const validators = { ...(row.etag ? { etag: row.etag } : {}), ...(row.last_modified ? { lastModified: row.last_modified } : {}) };
        out.push({ urlKey: row.url_key, url: row.url, host: row.host, queue: row.queue, generation: row.generation, depth: row.depth, ...(Object.keys(validators).length ? { validators } : {}) });
      }
      return out;
    });
  }

  /** Returns leases that were never completed (a crash, a lost result) to the queue without counting an attempt. */
  requeueStale(now: number): number {
    return Number(this.db.prepare(`UPDATE urls SET state='PENDING', leased_at=NULL WHERE state='IN_FLIGHT' AND leased_at <= ?`).run(now - this.o.staleLeaseMs).changes);
  }

  /** The submission got no result (Coordinator unreachable, queue full): try again later, same generation so the job is deduplicated. */
  release(key: string, now: number, delayMs: number): void {
    this.db.prepare(`UPDATE urls SET state='PENDING', leased_at=NULL, next_at=? WHERE url_key=? AND state='IN_FLIGHT'`).run(now + delayMs, key);
  }

  /** The result was unusable (failed validation, wrong URL): counts as a failed attempt with backoff and a new generation. */
  fail(key: string, now: number, reason: string): void { this.retryLater(key, now, reason, null, null); }

  private settle(key: string, now: number, outcome: string, http: number | null, next: number, state: State = 'DONE', extra: { etag?: string | null; lastModified?: string | null; sha?: string | null; fetched?: boolean } = {}): void {
    this.db.prepare(`UPDATE urls SET state=?, next_at=?, attempts=0, generation=generation+1, last_outcome=?, last_http=?, leased_at=NULL,
      etag=COALESCE(?, etag), last_modified=COALESCE(?, last_modified), content_sha256=COALESCE(?, content_sha256), fetched_at=CASE WHEN ? THEN ? ELSE fetched_at END WHERE url_key=?`)
      .run(state, next, outcome, http, extra.etag ?? null, extra.lastModified ?? null, extra.sha ?? null, extra.fetched ? 1 : 0, now, key);
  }
  private retryLater(key: string, now: number, outcome: string, http: number | null, retryAfterMs: number | null): void {
    const row = this.db.prepare('SELECT attempts, host FROM urls WHERE url_key=?').get(key) as { attempts: number; host: string } | undefined; if (!row) return;
    const attempts = row.attempts + 1; const wait = Math.max(this.backoff(attempts), retryAfterMs ?? 0);
    if (attempts >= this.o.maxAttempts) {
      this.db.prepare(`UPDATE urls SET state='FAILED', attempts=?, generation=generation+1, last_outcome=?, last_http=?, leased_at=NULL, next_at=? WHERE url_key=?`).run(attempts, outcome, http, now + this.o.recrawlMs, key);
    } else {
      this.db.prepare(`UPDATE urls SET state='PENDING', attempts=?, generation=generation+1, last_outcome=?, last_http=?, leased_at=NULL, next_at=? WHERE url_key=?`).run(attempts, outcome, http, now + wait, key);
    }
    this.db.prepare(`INSERT INTO hosts (host, backoff_until, failures) VALUES (?,?,1) ON CONFLICT(host) DO UPDATE SET backoff_until=MAX(backoff_until, excluded.backoff_until), failures=failures+1`).run(row.host, now + wait);
  }

  /** Applies one validated fetch result. Every one of the twelve outcomes has an explicit policy here. */
  complete(key: string, result: FetchResult, now: number): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT host, queue, priority, depth FROM urls WHERE url_key=?').get(key) as { host: string; queue: Queue; priority: number; depth: number } | undefined; if (!row) return;
      const delay = Math.max(this.o.hostDelayMs, (result.robots.crawlDelaySec ?? 0) * 1000);
      // Requesting a host, whatever came back, spends its politeness budget; a success clears its failure streak.
      this.db.prepare(`INSERT INTO hosts (host, next_allowed_at) VALUES (?,?) ON CONFLICT(host) DO UPDATE SET next_allowed_at=MAX(next_allowed_at, excluded.next_allowed_at)`).run(row.host, now + delay);
      const http = result.httpStatus ?? null; const recrawl = now + this.o.recrawlMs; const gone = now + this.o.goneRecheckMs;
      switch (result.outcome) {
        case 'FETCHED':
          this.settle(key, now, 'FETCHED', http, recrawl, 'DONE', { etag: result.etag ?? null, lastModified: result.lastModified ?? null, sha: result.contentSha256 ?? null, fetched: true });
          this.db.prepare('UPDATE hosts SET failures=0 WHERE host=?').run(row.host); break;
        case 'NOT_MODIFIED': this.settle(key, now, 'NOT_MODIFIED', http, recrawl, 'DONE', { fetched: true }); this.db.prepare('UPDATE hosts SET failures=0 WHERE host=?').run(row.host); break;
        case 'PROBED': this.settle(key, now, 'PROBED', http, recrawl, 'DONE', { etag: result.etag ?? null, lastModified: result.lastModified ?? null, fetched: true }); break;
        case 'REDIRECT': // done for this URL; the target is a new URL that goes through normal admission, robots and host policy
          this.settle(key, now, 'REDIRECT', http, gone, 'DONE');
          if (result.redirectTarget) this.add(result.redirectTarget, { queue: row.queue, priority: row.priority, depth: row.depth }, now); break;
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
          if (result.error?.retryable === false) this.settle(key, now, 'FETCH_FAILED', null, now + 7 * DAY, 'FAILED');
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
}
