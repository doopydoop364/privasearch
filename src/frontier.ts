import { DatabaseSync } from 'node:sqlite';
import type { FetchResult } from './privanet/contract.js';
import type { Queue } from './privanet/transport.js';
import { initSchema, inTransaction } from './db.js';
import { DomainModel } from './domain.js';
import { languagePreferred, lowValueUrl, urlLanguageHint } from './language.js';
import { crawlTrap } from './policy.js';
import type { TrapReason } from './policy.js';
import { resolvePolicy } from './policy-options.js';
import type { CrawlPolicyOptions, ResolvedCrawlPolicy } from './policy-options.js';
import { domainWeight, priorityOf } from './scoring.js';
import type { DomainCounters, PriorityBreakdown, UrlSource } from './scoring.js';
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
export interface FrontierOptions extends CrawlPolicyOptions {
  /** Operator-defined groups of related registrable domains (family name -> domains). Never guessed. */
  families?: Record<string, string[]>;
  /** Read-only inspection (explain, analysis): the schema is neither created nor migrated and nothing is written. Use only with a database opened read-only. */
  readOnly?: boolean;
  hostDelayMs?: number; maxAttempts?: number; backoffBaseMs?: number; maxBackoffMs?: number;
  /** The first recrawl interval after a URL is fetched for the first time. */
  recrawlMs?: number; recrawlMinMs?: number; recrawlMaxMs?: number; importantRecrawlMaxMs?: number;
  goneRecheckMs?: number; failedRecheckMs?: number; staleLeaseMs?: number; maxDepth?: number;
  /** Discovered URLs per host the frontier will hold; seeds, redirects and demand requests are not counted against it. */
  maxUrlsPerHost?: number;
  /** The share of each lease reserved for recrawls (when any are due), so endless discovery cannot starve refreshing and the reverse. */
  recrawlShare?: number;
}
export interface Leased { urlKey: string; url: string; host: string; queue: Queue; generation: number; depth: number; source: Source; validators?: { etag?: string; lastModified?: string } }
export type AddResult = 'ADDED' | 'EXISTS' | UrlRejection | 'TOO_DEEP' | 'HOST_BUDGET' | 'DOMAIN_BUDGET' | 'FAMILY_BUDGET' | 'GLOBAL_BUDGET' | 'LOW_VALUE' | 'LANGUAGE_FILTERED' | `TRAP:${TrapReason}`;
/** Why a discovered link was or was not admitted, as counted since process start (`Frontier.admission`). */
export type AdmissionReason = 'ADDED' | 'EXISTS' | 'REJECTED_URL' | 'TOO_DEEP' | 'HOST_BUDGET' | 'DOMAIN_BUDGET' | 'FAMILY_BUDGET' | 'GLOBAL_BUDGET' | 'LOW_VALUE' | 'LANGUAGE_FILTERED' | 'TRAP';
export interface Concentration {
  /** Share of the PENDING frontier (and of everything already crawled) held by the largest domain, the five largest, and the Herfindahl index (1 = one domain; 1/n = n equal domains). */
  pending: { total: number; top1: number; top5: number; herfindahl: number; effectiveDomains: number; topDomain: string | null };
  crawled: { total: number; top1: number; top5: number; herfindahl: number; effectiveDomains: number; topDomain: string | null };
  warnings: string[];
}
export interface AddOptions { queue: Queue; priority?: number; depth?: number; source?: Source; external?: boolean; relevant?: boolean }
export interface Evaluation {
  verdict: AddResult | 'WOULD_ADD'; parsed?: { url: string; host: string; origin: string }; source: Source; priority: PriorityBreakdown; domain: string; languageHint: string | undefined; knownPriority?: number;
}
export type State = 'PENDING' | 'IN_FLIGHT' | 'DONE' | 'BLOCKED' | 'FAILED';
export type Source = UrlSource;
export interface UrlRow { url_key: string; url: string; host: string; queue: Queue; priority: number; state: State; generation: number; attempts: number; next_at: number; depth: number; last_outcome: string | null; last_http: number | null; etag: string | null; last_modified: string | null; content_sha256: string | null; fetched_at: number | null; leased_at: number | null; interval_ms: number | null; change_count: number; unchanged_streak: number; last_changed_at: number | null; domain: string | null; source: Source; external: number }

const DAY = 86400000;
const HOUR = 3600000;

export class Frontier {
  private readonly o: Required<Omit<FrontierOptions, keyof CrawlPolicyOptions | 'families' | 'readOnly'>>;
  readonly policy: ResolvedCrawlPolicy; readonly model: DomainModel;
  /** Admission outcomes since this process started (the persistent record is the frontier itself). */
  readonly admission: Record<AdmissionReason, number> = { ADDED: 0, EXISTS: 0, REJECTED_URL: 0, TOO_DEEP: 0, HOST_BUDGET: 0, DOMAIN_BUDGET: 0, FAMILY_BUDGET: 0, GLOBAL_BUDGET: 0, LOW_VALUE: 0, LANGUAGE_FILTERED: 0, TRAP: 0 };
  /** Position in the 100-slot exploit/explore/wildcard cycle, and the golden-ratio sequence that spreads wildcard picks over the fair-share order. */
  private classTurn = 0; private wildcardTurn = 0; private detailCache: { at: number; recrawlDue: number; hosts: number; domains: number } | undefined; private concentrationCache: { at: number; value: Concentration } | undefined;
  /** Single-slot leases alternate between new and recrawl work in a fixed pattern (one in four is a recrawl) so the share holds for limit 1 too. */
  private singleSlotTurn = 0;
  constructor(private readonly db: DatabaseSync, options: FrontierOptions = {}) {
    const { families, domainModel, readOnly, ...rest } = options as FrontierOptions & { domainModel?: DomainModel };
    this.policy = resolvePolicy(rest); this.model = domainModel ?? new DomainModel(families ?? {});
    this.o = { hostDelayMs: 2000, maxAttempts: 5, backoffBaseMs: 60000, maxBackoffMs: 6 * HOUR, recrawlMs: 7 * DAY, recrawlMinMs: 6 * HOUR, recrawlMaxMs: 60 * DAY, importantRecrawlMaxMs: 14 * DAY,
      goneRecheckMs: 30 * DAY, failedRecheckMs: 30 * DAY, staleLeaseMs: 300000, maxDepth: 8, maxUrlsPerHost: 2000, recrawlShare: 0.25, ...Object.fromEntries(Object.entries(rest).filter(([k, v]) => v !== undefined && !(k in this.policy))) };
    if (!readOnly) { initSchema(db); this.syncFamilies(families ?? {}); }
  }
  /** Makes the stored family of every domain match the configuration (a domain not listed is its own family), so adding or removing a group takes effect at the next start. */
  private syncFamilies(groups: Record<string, string[]>): void {
    this.transaction(() => {
      const listed = new Map<string, string>(); for (const [family, domains] of Object.entries(groups)) for (const d of domains) listed.set(d.toLowerCase(), family);
      this.db.prepare('UPDATE domains SET family = domain WHERE family <> domain').run();
      for (const [domain, family] of listed) this.db.prepare('UPDATE domains SET family = ? WHERE domain = ?').run(family, domain);
    });
  }
  private transaction<T>(work: () => T): T { return inTransaction(this.db, work); }
  /** Runs `work` (frontier and document changes on this database) as one unit: all of it or none of it. */
  atomically<T>(work: () => T): T { return inTransaction(this.db, work); }
  private backoff(attempts: number): number { return Math.min(this.o.maxBackoffMs, this.o.backoffBaseMs * 2 ** Math.max(0, attempts - 1)); }

  private count(reason: AdmissionReason): void { this.admission[reason]++; }
  /** The domain row exists (with its family and a fair-share start) before any URL of it is inserted. A new domain joins the schedule at the current front, not behind the backlog. */
  private ensureDomain(domain: string, priority: number, now: number): void {
    // The start is the current round (the front of the schedule, rounded down) plus a tiny, priority-ordered offset (far below one scheduling step), so brand-new domains are tried most promising first.
    this.db.prepare(`INSERT OR IGNORE INTO domains (domain, family, first_seen, vtime) VALUES (?,?,?, CAST(COALESCE((SELECT MIN(vtime) FROM domains WHERE pending > 0), 0) AS INTEGER) + ? / 1000.0)`)
      .run(domain, this.model.familyOfDomain(domain), now, Math.max(0, 100 - priority));
  }

  add(raw: string, options: AddOptions, now: number): AddResult {
    const result = this.admit(raw, options, now);
    this.count(result === 'ADDED' || result === 'EXISTS' || result === 'TOO_DEEP' || result === 'HOST_BUDGET' || result === 'DOMAIN_BUDGET' || result === 'FAMILY_BUDGET' || result === 'GLOBAL_BUDGET' || result === 'LOW_VALUE' || result === 'LANGUAGE_FILTERED' ? result : result.startsWith('TRAP:') ? 'TRAP' : 'REJECTED_URL');
    return result;
  }

  /**
   * Admission BEFORE insertion. Order, cheapest first; a URL stops at the first refusal and nothing is written for it:
   *   1 URL policy  2 depth  3 already known (priority/demand promotion only)  4 non-content URL (LOW_VALUE)  5 language hint (LANGUAGE_FILTERED)
   *   6 crawl trap  7 host budget  8 domain pending budget  9 family pending budget  10 global pending budget
   * Steps 4-10 apply to DISCOVERED links only: a seed, a redirect target, a sitemap/provider candidate or an explicit demand request is never judged by them.
   * Counts come from trigger-maintained counters, never from scanning `urls`.
   */
  private admit(raw: string, options: AddOptions, now: number): AddResult {
    const e = this.evaluate(raw, options);
    if (e.verdict === 'EXISTS' && e.parsed) {
      const key = urlKey(e.parsed.url); const source = e.source;
      // Demand promotes a URL already known as public work, so explicit user demand is never queued behind discovery; a better priority is kept.
      if (options.queue === 'DEMAND') {
        this.db.prepare(`UPDATE urls SET queue='DEMAND', source='demand', priority=MAX(priority, ?) WHERE url_key=? AND state='PENDING'`).run(e.priority.total, key);
        // Due now, unless it is waiting out a failure backoff: demand never turns repeated searches into repeated hits on a failing URL.
        this.db.prepare(`UPDATE urls SET next_at=MIN(next_at, ?) WHERE url_key=? AND state='PENDING' AND attempts=0`).run(now, key);
        // A page someone asks about again is worth refreshing: a finished URL not fetched for `recrawlMinMs` becomes due now. The same floor is the cooldown, so repeating a search never turns into repeated fetches.
        this.db.prepare(`UPDATE urls SET next_at=MIN(next_at, ?) WHERE url_key=? AND state='DONE' AND ? - COALESCE(fetched_at, 0) >= ?`).run(now, key, now, this.o.recrawlMinMs);
      }
      else if (source === 'seed') this.db.prepare(`UPDATE urls SET source='seed', priority=MAX(priority, ?) WHERE url_key=?`).run(e.priority.total, key); // seeds are re-marked at every start, so they stay protected from pruning
      else if (e.priority.total > (e.knownPriority ?? 0)) this.db.prepare(`UPDATE urls SET priority=? WHERE url_key=?`).run(e.priority.total, key);
      return 'EXISTS';
    }
    if (e.verdict !== 'WOULD_ADD' || !e.parsed) return e.verdict as AddResult;
    this.ensureDomain(e.domain, e.priority.total, now);
    this.db.prepare(`INSERT OR IGNORE INTO urls (url_key, url, host, domain, queue, priority, state, next_at, depth, discovered_at, source, external) VALUES (?,?,?,?,?,?, 'PENDING', ?, ?, ?, ?, ?)`)
      .run(urlKey(e.parsed.url), e.parsed.url, e.parsed.host, e.domain, options.queue, e.priority.total, now, options.depth ?? 0, now, e.source, options.external ? 1 : 0);
    return 'ADDED';
  }

  /**
   * Admission BEFORE insertion, as a pure read. Order, cheapest first; a URL stops at the first refusal and nothing is written for it:
   *   1 URL policy  2 depth  3 already known  4 non-content URL (LOW_VALUE)  5 language hint (LANGUAGE_FILTERED, 'filter' mode)
   *   6 crawl trap  7 host budget  8 domain pending budget  9 family pending budget  10 global pending budget
   * Steps 4-10 apply to DISCOVERED links only: a seed, a redirect target, a sitemap/provider candidate or an explicit demand request is never judged by them.
   * Counts come from trigger-maintained counters, never from scanning `urls`. `frontier explain` calls this for a URL the frontier has never seen.
   */
  evaluate(raw: string, options: AddOptions): Evaluation {
    const none = { total: 0, base: 0, external: 0, relevance: 0, language: 0, query: 0 };
    const parsed = parseCrawlUrl(raw, undefined, this.policy.trackingParams);
    if (!parsed.ok) return { verdict: parsed.reason, source: options.source ?? 'seed', priority: none, domain: '', languageHint: undefined };
    const depth = options.depth ?? 0; const discovered = options.source === 'discovered' || options.source === 'sitemap'; // sitemap entries are judged like links: a sitemap is operator-controlled by the site, not by us
    const source: Source = options.source ?? (options.queue === 'DEMAND' ? 'demand' : 'seed');
    const domain = this.model.domainOf(parsed.host); const hint = urlLanguageHint(parsed.url); const hintAllowed = languagePreferred(hint, this.policy.preferredLanguages);
    // A caller that names neither a priority nor a source gets 0 (an operator-added URL); one that names a source gets that source's scored priority.
    const breakdown = options.priority !== undefined ? { ...none, total: options.priority, base: options.priority }
      : options.source === undefined ? none : priorityOf({ source, depth, external: options.external ?? false, relevant: options.relevant ?? false, languageHintAllowed: hintAllowed, hasQuery: parsed.url.includes('?') }, this.policy);
    const out = (verdict: Evaluation['verdict'], extra: Partial<Evaluation> = {}): Evaluation => ({ verdict, parsed, source, priority: breakdown, domain, languageHint: hint, ...extra });
    if (depth > this.o.maxDepth) return out('TOO_DEEP');
    const known = this.db.prepare('SELECT queue, priority FROM urls WHERE url_key=?').get(urlKey(parsed.url)) as { queue: Queue; priority: number } | undefined;
    if (known) return out('EXISTS', { knownPriority: known.priority });
    if (discovered) {
      if (lowValueUrl(parsed.url)) return out('LOW_VALUE');
      if (!hintAllowed && this.policy.languageMode === 'filter') return out('LANGUAGE_FILTERED');
      const trap = crawlTrap(parsed.url); if (trap) return out(`TRAP:${trap}`);
      const host = this.db.prepare('SELECT urls FROM hosts WHERE host=?').get(parsed.host) as { urls: number } | undefined;
      if (Number(host?.urls ?? 0) >= this.o.maxUrlsPerHost) return out('HOST_BUDGET');
      const dom = this.db.prepare('SELECT pending FROM domains WHERE domain=?').get(domain) as { pending: number } | undefined;
      if (Number(dom?.pending ?? 0) >= this.policy.maxPendingPerDomain) return out('DOMAIN_BUDGET');
      const family = this.model.familyOfDomain(domain);
      if (family !== domain && Number((this.db.prepare('SELECT COALESCE(SUM(pending),0) AS n FROM domains WHERE family=?').get(family) as { n: number }).n) >= this.policy.maxPendingPerFamily) return out('FAMILY_BUDGET');
      if (Number((this.db.prepare(`SELECT n FROM states WHERE state='PENDING'`).get() as { n: number }).n) >= this.policy.maxPendingTotal) return out('GLOBAL_BUDGET');
    }
    return out('WOULD_ADD');
  }

  /** Whether the domain (and its family) may start one more request: concurrency caps per domain and per family. Reads the trigger-maintained counters, so it also sees leases made earlier in this call. */
  private hasRoom(domain: string, family: string): boolean {
    const row = this.db.prepare('SELECT in_flight FROM domains WHERE domain=?').get(domain) as { in_flight: number } | undefined;
    if (Number(row?.in_flight ?? 0) >= this.policy.domainConcurrency) return false;
    if (family === domain) return true;
    return Number((this.db.prepare('SELECT COALESCE(SUM(in_flight),0) AS n FROM domains WHERE family=?').get(family) as { n: number }).n) < this.policy.familyConcurrency;
  }

  private slotClass(): 'exploit' | 'explore' | 'wildcard' {
    const slot = (this.classTurn++ * 37) % 100; const e = this.policy.explore; // 37 is coprime to 100: every class is spread evenly through the cycle
    return slot < e.exploit ? 'exploit' : slot < e.exploit + e.explore ? 'explore' : 'wildcard';
  }

  /**
   * DONE means "fresh until next_at": a finished URL becomes due again for recrawl. Leases at most one due URL per host, and none for a host that
   * already has one in flight or is waiting out its delay or backoff. A registrable domain also has a concurrency cap (and so does a family).
   *
   * Order: (1) explicit demand first, highest priority first; (2) a reserved share for due recrawls (most overdue first); (3) new public URLs chosen by
   * WEIGHTED FAIR QUEUEING OVER DOMAINS, not over URLs: every domain with pending work carries a virtual time, the domain with the smallest one is served
   * next and its virtual time then advances by 1/weight (weight = saturation x yield x authority, scoring.ts). A domain with a million pending URLs and a
   * domain with ten therefore take turns in proportion to their weights, never to their size. Within a domain the highest-priority due URL goes first.
   * The turns are split by `explore` (default 70/20/10): the fairest-share domain, the youngest domain (fewer than 5 pages crawled), or a pseudo-random one.
   * Whatever a class cannot use falls through to the next, so capacity is never wasted.
   */
  lease(now: number, limit: number): Leased[] {
    return this.transaction(() => {
      const want = Math.max(1, limit); const hosts = new Set<string>(); const out: Leased[] = [];
      const due = `u.next_at <= ? AND COALESCE(h.next_allowed_at,0) <= ? AND COALESCE(h.backoff_until,0) <= ? AND NOT EXISTS (SELECT 1 FROM urls x WHERE x.host = u.host AND x.state='IN_FLIGHT')`;
      const select = (where: string, order: string, cap: number, index = 'urls_due') => this.db.prepare(`SELECT u.* FROM urls u INDEXED BY ${index} LEFT JOIN hosts h ON h.host = u.host WHERE ${where} AND ${due} ORDER BY ${order} LIMIT ?`)
        .all(now, now, now, Math.max(1, cap) * 8) as unknown as UrlRow[];
      const claim = (row: UrlRow): void => {
        hosts.add(row.host); this.db.prepare(`UPDATE urls SET state='IN_FLIGHT', leased_at=? WHERE url_key=?`).run(now, row.url_key);
        if (row.domain) this.db.prepare('UPDATE domains SET leased = leased + 1 WHERE domain=?').run(row.domain);
        const validators = { ...(row.etag ? { etag: row.etag } : {}), ...(row.last_modified ? { lastModified: row.last_modified } : {}) };
        // A recrawl is background work whatever queue first brought the URL in; only a pending demand request uses the demand credential.
        const queue: Queue = row.state === 'PENDING' ? row.queue : 'PUBLIC';
        out.push({ urlKey: row.url_key, url: row.url, host: row.host, queue, generation: row.generation, depth: row.depth, source: row.source, ...(Object.keys(validators).length ? { validators } : {}) });
      };
      const take = (rows: UrlRow[], cap: number, spread = false) => {
        let taken = 0;
        // Recrawls: the most overdue URL of every domain before a second URL of any domain, so one giant site's backlog cannot monopolise the refresh share.
        if (spread) { const seen = new Set<string | null>(); const first: UrlRow[] = []; const later: UrlRow[] = []; for (const r of rows) { (seen.has(r.domain) ? later : first).push(r); seen.add(r.domain); } rows = [...first, ...later]; }
        for (const row of rows) {
          if (taken >= cap || out.length >= want) break; if (hosts.has(row.host)) continue;
          if (row.domain && !this.hasRoom(row.domain, this.model.familyOfDomain(row.domain))) continue;
          claim(row); taken++;
        }
      };
      take(select(`u.state='PENDING' AND u.queue='DEMAND'`, 'u.priority DESC, u.next_at, u.url_key', want, 'urls_pending_demand'), want);
      const rest = want - out.length; if (rest <= 0) return out;
      const recrawlQuota = rest >= 2 ? Math.ceil(rest * this.policy_recrawlShare()) : (this.singleSlotTurn++ % 4 === 3 ? 1 : 0);
      // Two index-ordered scans (done pages first, then failed ones): no sort over every due row.
      const recrawl = () => { const done = select(`u.state='DONE'`, 'u.next_at, u.url_key', rest); return done.length >= rest * 8 ? done : [...done, ...select(`u.state='FAILED'`, 'u.next_at, u.url_key', rest)]; };
      take(recrawl(), recrawlQuota, true);
      const vmin = Number((this.db.prepare('SELECT COALESCE(MIN(vtime),0) AS v FROM domains WHERE pending > 0').get() as { v: number }).v);
      while (out.length < want) { const row = this.pickFresh(now, hosts, vmin); if (!row) break; claim(row); }
      take(recrawl(), want - out.length, true);
      return out;
    });
  }
  private policy_recrawlShare(): number { return this.o.recrawlShare; }

  /**
   * Candidate domains for one slot, in the order the slot's class prefers: only domains that have a due URL on a host that is free right now (the readiness test is in
   * the query, so a domain waiting out its politeness delay is neither considered nor charged). At most 64 per slot.
   */
  private candidates(kind: 'exploit' | 'explore' | 'wildcard', vmin: number, now: number): Array<DomainCounters & { domain: string; family: string; vtime: number }> {
    const columns = 'd.domain, d.family, d.vtime, d.done, d.yield, d.yield_at, d.ref_domains';
    const ready = `AND EXISTS (SELECT 1 FROM urls u INDEXED BY urls_domain_pending LEFT JOIN hosts h ON h.host = u.host WHERE u.domain = d.domain AND u.state='PENDING' AND u.queue='PUBLIC' AND u.next_at <= ?
      AND COALESCE(h.next_allowed_at,0) <= ? AND COALESCE(h.backoff_until,0) <= ? AND NOT EXISTS (SELECT 1 FROM urls x WHERE x.host = u.host AND x.state='IN_FLIGHT'))`;
    const room = this.policy.domainConcurrency;
    if (kind === 'explore') return this.db.prepare(`SELECT ${columns} FROM domains d WHERE d.pending > 0 AND d.done < 5 AND d.in_flight < ? ${ready} ORDER BY d.vtime LIMIT 64`).all(room, now, now, now) as never;
    if (kind === 'wildcard') {
      const vmax = Number((this.db.prepare('SELECT COALESCE(MAX(vtime),0) AS v FROM domains WHERE pending > 0').get() as { v: number }).v);
      const at = vmin + ((this.wildcardTurn++ * 0.6180339887498949) % 1) * Math.max(0, vmax - vmin);
      return this.db.prepare(`SELECT ${columns} FROM domains d WHERE d.pending > 0 AND d.vtime >= ? AND d.in_flight < ? ${ready} ORDER BY d.vtime LIMIT 64`).all(at, room, now, now, now) as never;
    }
    return this.db.prepare(`SELECT ${columns} FROM domains d WHERE d.pending > 0 AND d.in_flight < ? ${ready} ORDER BY d.vtime LIMIT 64`).all(room, now, now, now) as never;
  }

  /** The next domain turn: the first candidate of the slot's class that has a leasable URL. Only a domain that is actually served is charged. */
  private pickFresh(now: number, hosts: Set<string>, vmin: number): UrlRow | undefined {
    const first = this.slotClass();
    const order: Array<'exploit' | 'explore' | 'wildcard'> = first === 'exploit' ? ['exploit'] : [first, 'exploit'];
    const pick = this.db.prepare(`SELECT u.* FROM urls u INDEXED BY urls_domain_pending LEFT JOIN hosts h ON h.host = u.host WHERE u.domain = ? AND u.state='PENDING' AND u.queue='PUBLIC' AND u.next_at <= ?
      AND COALESCE(h.next_allowed_at,0) <= ? AND COALESCE(h.backoff_until,0) <= ? AND NOT EXISTS (SELECT 1 FROM urls x WHERE x.host = u.host AND x.state='IN_FLIGHT')
      ORDER BY u.priority DESC, u.next_at LIMIT 8`); // ties fall to insertion order (rowid), which the index already provides: no sort over the whole domain
    for (const kind of order) {
      for (const d of this.candidates(kind, vmin, now)) {
        if (!this.hasRoom(d.domain, d.family)) continue;
        // The best due URL of this domain whose host is not already used by this lease. The max() with the front of the schedule stops a domain that sat idle from banking credit.
        const row = (pick.all(d.domain, now, now, now) as unknown as UrlRow[]).find(r => !hosts.has(r.host));
        if (!row) continue;
        this.db.prepare('UPDATE domains SET vtime = ? WHERE domain = ?').run(Math.max(d.vtime, vmin) + 1 / domainWeight(d, now, this.policy).weight, d.domain);
        return row;
      }
    }
    return undefined;
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
    // Importance = independent referring DOMAINS (a giant site's subdomains are one voice); looking at 25 distinct linking hosts is enough to tell 5 domains.
    const home = this.model.domainOf((this.db.prepare('SELECT host FROM urls WHERE url_key=?').get(key) as { host: string } | undefined)?.host ?? '');
    const inbound = new Set((this.db.prepare('SELECT DISTINCT src_host FROM links WHERE dst_key=? AND src_host<>dst_host LIMIT 25').all(key) as Array<{ src_host: string }>).map(r => this.model.domainOf(r.src_host)).filter(d => d !== home)).size;
    return Math.min(inbound >= 5 ? Math.min(this.o.recrawlMaxMs, this.o.importantRecrawlMaxMs) : this.o.recrawlMaxMs, current * 2);
  }

  /** Applies one validated fetch result. Every one of the twelve outcomes has an explicit policy here. */
  complete(key: string, result: FetchResult, now: number): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT host, queue, priority, depth, content_sha256, interval_ms, source FROM urls WHERE url_key=?').get(key) as { host: string; queue: Queue; priority: number; depth: number; content_sha256: string | null; interval_ms: number | null; source: Source } | undefined; if (!row) return;
      const delay = Math.max(this.o.hostDelayMs, (result.robots.crawlDelaySec ?? 0) * 1000);
      // Requesting a host, whatever came back, spends its politeness budget; a success clears its failure streak.
      this.db.prepare(`INSERT INTO hosts (host, next_allowed_at) VALUES (?,?) ON CONFLICT(host) DO UPDATE SET next_allowed_at=MAX(next_allowed_at, excluded.next_allowed_at)`).run(row.host, now + delay);
      const http = result.httpStatus ?? null; const gone = now + this.o.goneRecheckMs;
      const errored = result.outcome === 'FETCH_FAILED' || result.outcome === 'UNSUPPORTED_CONTENT_TYPE' || result.outcome === 'TOO_LARGE' || (result.outcome === 'HTTP_ERROR' && result.httpStatus !== 429);
      if (errored && row.source !== 'sitemap') this.recordPage(key, 'error', now); // a missing sitemap.txt is a guess that did not pay off, not a flaw of the site
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
  /** Counts per state, read from the trigger-maintained `states` table: O(1), safe to call from /status on a frontier of any size. */
  stats(): Record<State, number> {
    const out: Record<State, number> = { PENDING: 0, IN_FLIGHT: 0, DONE: 0, BLOCKED: 0, FAILED: 0 };
    for (const row of this.db.prepare(`SELECT state, n FROM states WHERE state IN ('PENDING','IN_FLIGHT','DONE','BLOCKED','FAILED')`).all() as unknown as Array<{ state: State; n: number }>) out[row.state] = Number(row.n);
    return out;
  }
  /** The demand backlog alone (the planner asks on every weak search). */
  pendingDemand(): number { return Number((this.db.prepare(`SELECT n FROM states WHERE state='PENDING_DEMAND'`).get() as { n: number }).n); }
  /**
   * Counts for operators. Backlog sizes are exact and O(1). The two that need a scan (recrawls due now, distinct hosts and domains) are cached for 15 s, so a
   * status page polled every second costs one scan per 15 s, not one per request.
   */
  detail(now: number): { pendingDemand: number; pendingPublic: number; recrawlDue: number; hosts: number; domains: number } {
    const n = (sql: string, ...args: number[]) => Number((this.db.prepare(sql).get(...args) as { n: number }).n);
    if (!this.detailCache || Math.abs(now - this.detailCache.at) >= 15000) {
      this.detailCache = { at: now, recrawlDue: n(`SELECT COUNT(*) AS n FROM urls WHERE state IN ('DONE','FAILED') AND next_at <= ?`, now), hosts: n('SELECT COUNT(*) AS n FROM hosts WHERE urls > 0'), domains: n('SELECT COUNT(*) AS n FROM domains WHERE urls > 0') };
    }
    const pending = n(`SELECT n FROM states WHERE state='PENDING'`); const demand = this.pendingDemand();
    return { pendingDemand: demand, pendingPublic: pending - demand, recrawlDue: this.detailCache.recrawlDue, hosts: this.detailCache.hosts, domains: this.detailCache.domains };
  }

  /**
   * One finished page's contribution to its domain's yield. `useful` = indexed and not a duplicate or low-value page; the others count against it. The yield is an
   * exponentially weighted rate (new sample 10%), measured from the decayed value so an old verdict has already faded. Neutral outcomes record nothing.
   */
  recordPage(key: string, kind: 'useful' | 'duplicate' | 'low_value' | 'error', now: number): void {
    const row = this.db.prepare('SELECT d.domain, d.done, d.yield, d.yield_at, d.ref_domains FROM urls u JOIN domains d ON d.domain = u.domain WHERE u.url_key=?').get(key) as unknown as (DomainCounters & { domain: string }) | undefined; if (!row) return;
    const current = domainWeight(row, now, this.policy).yieldEff; const sample = kind === 'useful' ? 1 : 0;
    this.db.prepare(`UPDATE domains SET fetched = fetched + ?, useful = useful + ?, duplicates = duplicates + ?, low_value = low_value + ?, errors = errors + ?, yield = ?, yield_at = ? WHERE domain = ?`)
      .run(kind === 'error' ? 0 : 1, kind === 'useful' ? 1 : 0, kind === 'duplicate' ? 1 : 0, kind === 'low_value' ? 1 : 0, kind === 'error' ? 1 : 0, Math.min(1, Math.max(0, current * 0.9 + sample * 0.1)), now, row.domain);
  }
  /** Useful pages (indexed, not duplicate, not low-value) fetched so far from a registrable domain. */
  domainUseful(domain: string): number { return Number((this.db.prepare('SELECT useful AS n FROM domains WHERE domain=?').get(domain) as { n: number } | undefined)?.n ?? 0); }
  /** Labels the domain of a seed with an operator-chosen class (official, docs, news, forum, ...): shown by `frontier-cli seeds` and `explain`, never used to rank. */
  markSeedClass(raw: string, seedClass: string): void {
    const parsed = parseCrawlUrl(raw, undefined, this.policy.trackingParams); if (!parsed.ok) return;
    this.db.prepare('UPDATE domains SET seed_class = ? WHERE domain = ?').run(seedClass, this.model.domainOf(parsed.host));
  }
  /** Records that a page of `srcDomain` links to `dstDomain` (once per pair): the count of independent referring domains is the authority signal. */
  noteDomainLink(srcDomain: string, dstDomain: string): void {
    if (srcDomain === dstDomain) return;
    if (Number(this.db.prepare('INSERT OR IGNORE INTO domain_links (src_domain, dst_domain) VALUES (?,?)').run(srcDomain, dstDomain).changes) > 0) this.db.prepare('UPDATE domains SET ref_domains = ref_domains + 1 WHERE domain=?').run(dstDomain);
  }

  /**
   * How concentrated the frontier and the crawl are, per registrable domain. One aggregate pass over `domains` (not `urls`), cached for 15 s, so a status page can show it
   * on every poll. Warnings are plain sentences: they name a domain and a share, never a URL.
   */
  concentration(now: number): Concentration {
    if (this.concentrationCache && Math.abs(now - this.concentrationCache.at) < 15000) return this.concentrationCache.value;
    const measure = (column: 'pending' | 'done'): Concentration['pending'] => {
      const rows = this.db.prepare(`SELECT domain, ${column} AS n FROM domains WHERE ${column} > 0 ORDER BY ${column} DESC, domain LIMIT 5`).all() as unknown as Array<{ domain: string; n: number }>;
      const agg = this.db.prepare(`SELECT COALESCE(SUM(${column}),0) AS total, COALESCE(SUM(1.0 * ${column} * ${column}),0) AS squares FROM domains WHERE ${column} > 0`).get() as { total: number; squares: number };
      const total = Number(agg.total); const hhi = total === 0 ? 0 : Number(agg.squares) / (total * total); const top = (n: number) => (total === 0 ? 0 : rows.slice(0, n).reduce((a, r) => a + Number(r.n), 0) / total);
      const round = (x: number) => Math.round(x * 10000) / 10000;
      return { total, top1: round(top(1)), top5: round(top(5)), herfindahl: round(hhi), effectiveDomains: hhi === 0 ? 0 : round(1 / hhi), topDomain: rows[0]?.domain ?? null };
    };
    const pending = measure('pending'); const crawled = measure('done'); const warnings: string[] = [];
    if (pending.total >= 100 && pending.top1 >= 0.5 && pending.topDomain) warnings.push(`one domain (${pending.topDomain}) holds ${Math.round(pending.top1 * 100)}% of the pending frontier`);
    if (pending.total >= 100 && pending.herfindahl >= 0.25) warnings.push(`the pending frontier is concentrated: it behaves like ${pending.effectiveDomains} equally sized domains`);
    if (crawled.total >= 100 && crawled.top1 >= 0.5 && crawled.topDomain) warnings.push(`one domain (${crawled.topDomain}) accounts for ${Math.round(crawled.top1 * 100)}% of crawled pages`);
    const value = { pending, crawled, warnings }; this.concentrationCache = { at: now, value }; return value;
  }
}
