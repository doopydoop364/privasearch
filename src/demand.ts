import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { initSchema } from './db.js';
import { DocumentStore, queryTerms } from './documents.js';
import { discover, frontierSource, linkSource, templateSource } from './discovery.js';
import type { CandidateSource } from './discovery.js';
import { Frontier } from './frontier.js';
import { DEMAND_PRIORITY } from './policy.js';
import type { SearchResult } from './ranking.js';

/**
 * Demand crawling: when a search finds too little, schedule related crawling, at higher priority than background crawling, without blocking the
 * answer and without letting a repeated or abusive search become a crawl storm.
 *
 * THE "WEAK RESULTS" HEURISTIC. A result set is weak when fewer than `minStrong` (default 3) results are strong. A result is strong when it contains
 * every query term and scores at least STRONG_SCORE (25 of 100; see ranking.ts). So "no results", "only partial matches" and "a couple of marginal
 * pages" all trigger; three solid pages do not. Only the first page of a search counts (paging through results never triggers anything).
 *
 * WHAT HAPPENS WHEN IT IS WEAK, in this order, stopping at the first that applies:
 *   cooldown      this query (a salted hash of its normalised, order-insensitive terms) already scheduled crawling recently: do nothing. The cooldown
 *                 starts at 30 minutes and doubles for each round that did not fix the problem, up to 24 hours, so a query that stays weak is retried
 *                 with new candidates (the index has grown) but never hammered.
 *   busy          the demand queue already holds `maxPendingDemand` URLs: do nothing.
 *   rate_limited  `maxQueriesPerHour` distinct weak queries already scheduled crawling this hour: do nothing.
 *   no_candidates discovery named nothing new (a short cooldown applies so the lookup is not repeated on every search).
 *   scheduled     up to `maxCandidates` URLs are queued as DEMAND work (`triggered` is true when something new was queued, false when everything named
 *                 was already waiting as demand work: the crawl is in progress and nothing more is started).
 *
 * PRIVACY. A query is stored only as an HMAC-style salted hash with counters and timestamps (the `queries` table), never as text, and nothing about
 * who searched is known to this module. The terms exist in memory only while the request is handled.
 */
export type CrawlState = 'none' | 'scheduled' | 'cooldown' | 'busy' | 'rate_limited' | 'no_candidates' | 'disabled';
export interface CrawlInfo { triggered: boolean; state: CrawlState; candidates: number; retryAfterSec?: number }
export interface DemandOptions {
  clock?: () => number; minStrong?: number; cooldownMs?: number; maxCooldownMs?: number; maxCandidates?: number; maxPendingDemand?: number; maxQueriesPerHour?: number;
  priority?: number; templates?: string[]; sources?: CandidateSource[];
}
const HOUR = 3600000;

export class DemandPlanner {
  private readonly o: Required<Omit<DemandOptions, 'sources' | 'templates'>>; private readonly sources: CandidateSource[]; private readonly salt: string;
  constructor(private readonly db: DatabaseSync, private readonly frontier: Frontier, private readonly documents: DocumentStore, options: DemandOptions = {}) {
    initSchema(db);
    this.o = { clock: Date.now, minStrong: 3, cooldownMs: 30 * 60000, maxCooldownMs: 24 * HOUR, maxCandidates: 12, maxPendingDemand: 300, maxQueriesPerHour: 30, priority: DEMAND_PRIORITY, ...options } as Required<Omit<DemandOptions, 'sources' | 'templates'>>;
    this.sources = options.sources ?? [frontierSource, linkSource, templateSource(options.templates ?? [])];
    const stored = (db.prepare(`SELECT v FROM meta WHERE k='query_salt'`).get() as { v: string } | undefined)?.v;
    if (stored) this.salt = stored; else { this.salt = randomBytes(24).toString('hex'); db.prepare(`INSERT INTO meta (k,v) VALUES ('query_salt', ?)`).run(this.salt); }
  }

  /** How many strong results make a result set good enough (see the heuristic above). */
  get minStrong(): number { return this.o.minStrong; }

  /** The ledger key: order-insensitive, case- and diacritic-insensitive, salted per install. Never reversible to the query text without a guess. */
  queryKey(query: string): string {
    const terms = [...new Set(queryTerms(query).map(t => t.normalize('NFD').replace(/\p{M}/gu, '')))].sort();
    return createHash('sha256').update(this.salt).update('\0').update(terms.join(' ')).digest('hex');
  }

  /** Looks at one finished search (first page) and, if it was weak, schedules demand crawling. Cheap and synchronous: a few indexed queries. */
  consider(query: string, result: SearchResult): CrawlInfo {
    if (result.terms === 0) return { triggered: false, state: 'none', candidates: 0 };
    const now = this.o.clock(); const key = this.queryKey(query);
    const row = this.db.prepare('SELECT last_crawl_at, crawl_rounds FROM queries WHERE qkey=?').get(key) as { last_crawl_at: number | null; crawl_rounds: number } | undefined;
    this.db.prepare(`INSERT INTO queries (qkey, first_seen, last_seen, times_seen, last_total, last_strong) VALUES (?,?,?,1,?,?)
      ON CONFLICT(qkey) DO UPDATE SET last_seen=excluded.last_seen, times_seen=times_seen+1, last_total=excluded.last_total, last_strong=excluded.last_strong`).run(key, now, now, result.total, result.strong);
    if (result.strong >= this.o.minStrong) return { triggered: false, state: 'none', candidates: 0 };

    const rounds = row?.crawl_rounds ?? 0; const cooldown = Math.min(this.o.maxCooldownMs, this.o.cooldownMs * 2 ** Math.min(Math.max(0, rounds - 1), 16));
    if (row?.last_crawl_at != null && now - row.last_crawl_at < cooldown) return { triggered: false, state: 'cooldown', candidates: 0, retryAfterSec: Math.ceil((cooldown - (now - row.last_crawl_at)) / 1000) };
    if (this.frontier.pendingDemand() >= this.o.maxPendingDemand) return { triggered: false, state: 'busy', candidates: 0 };
    const recent = Number((this.db.prepare('SELECT COUNT(*) AS n FROM queries WHERE last_crawl_at > ?').get(now - HOUR) as { n: number }).n);
    if (recent >= this.o.maxQueriesPerHour) return { triggered: false, state: 'rate_limited', candidates: 0, retryAfterSec: 60 };

    const terms = [...new Set(queryTerms(query).map(t => t.normalize('NFD').replace(/\p{M}/gu, '')))];
    // Ask for more names than will be queued: URLs already waiting as demand work are in progress, and the cap applies to NEW work so a query that stays weak moves on.
    const urls = discover(this.sources, { db: this.db, documents: this.documents, terms, hits: result.hits, limit: this.o.maxCandidates * 3 });
    let fresh = 0; let pending = 0;
    for (const url of urls) {
      const before = this.frontier.getByUrl(url);
      const isNew = !before || (before.state === 'PENDING' && before.queue === 'PUBLIC');
      if (isNew && fresh >= this.o.maxCandidates) continue;
      this.frontier.add(url, { queue: 'DEMAND', priority: this.o.priority, source: 'demand' }, now);
      const after = this.frontier.getByUrl(url);
      if (after?.state === 'PENDING' && after.queue === 'DEMAND') { pending++; if (isNew) fresh++; }
    }
    if (pending === 0) { this.db.prepare('UPDATE queries SET last_crawl_at=? WHERE qkey=?').run(now, key); return { triggered: false, state: 'no_candidates', candidates: 0 }; }
    // Everything named is already queued as demand work: crawling is in progress, nothing new was started, and the round does not count against the query.
    if (fresh === 0) { this.db.prepare('UPDATE queries SET last_crawl_at=? WHERE qkey=?').run(now, key); return { triggered: false, state: 'scheduled', candidates: pending }; }
    this.db.prepare('UPDATE queries SET last_crawl_at=?, crawl_rounds=crawl_rounds+1 WHERE qkey=?').run(now, key);
    return { triggered: true, state: 'scheduled', candidates: pending };
  }

  /**
   * Bounds the ledger: forgets queries not seen for `maxAgeMs` (default 90 days) and, if more than `maxRows` remain (default 500,000), the least recently seen
   * beyond that. Without this every distinct search ever made stays in the database for good. Forgetting a query only means it is treated as new next time.
   */
  prune(options: { maxAgeMs?: number; maxRows?: number } = {}): number {
    const now = this.o.clock(); const maxAge = options.maxAgeMs ?? 90 * 86400000; const maxRows = options.maxRows ?? 500000;
    let removed = Number(this.db.prepare('DELETE FROM queries WHERE last_seen < ?').run(now - maxAge).changes);
    const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM queries').get() as { n: number }).n);
    if (count > maxRows) removed += Number(this.db.prepare('DELETE FROM queries WHERE qkey IN (SELECT qkey FROM queries ORDER BY last_seen LIMIT ?)').run(count - maxRows).changes);
    return removed;
  }

  stats(): { queries: number; explored: number } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return { queries: n('SELECT COUNT(*) AS n FROM queries'), explored: n('SELECT COUNT(*) AS n FROM queries WHERE crawl_rounds > 0') };
  }
}
