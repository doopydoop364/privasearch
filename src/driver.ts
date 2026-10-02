import { Frontier } from './frontier.js';
import type { Leased } from './frontier.js';
import { DocumentStore } from './documents.js';
import { FetchResultSchema } from './privanet/contract.js';
import type { FetchResult } from './privanet/contract.js';
import { TransportError } from './privanet/transport.js';
import type { FetchTransport } from './privanet/transport.js';
import { languagePreferred, looksLikeSoft404, looksThin } from './language.js';
import { pathShares, words } from './scoring.js';
import { idempotencyKeyFor, parseCrawlUrl, urlKey } from './url.js';

export interface DriverOptions {
  frontier: Frontier; documents: DocumentStore; transport: FetchTransport; clock?: () => number;
  /** URLs submitted per pass; the frontier still allows only one per host. */
  batch?: number;
  /** Longest wait after PrivaNet could not be reached (default 60 s); the wait starts at `infrastructureBackoffBaseMs` and doubles while it stays unreachable. */
  infrastructureRetryMs?: number; infrastructureBackoffBaseMs?: number;
  /** Aborting this gives up on every submitted job still waiting for its result (shutdown past its deadline); each URL is released and resubmitted under the same key later. */
  hardStop?: AbortSignal;
}
export interface PassSummary {
  submitted: number; outcomes: Partial<Record<FetchResult['outcome'], number>>;
  indexed: number; duplicates: number; discovered: number; invalidResults: number; transportErrors: number;
  /** Discovered links refused by the crawl-trap guard or the per-host budget, and pages whose content changed since the last fetch. */
  trapped: number; changed: number;
}

/**
 * Drives crawling through PrivaNet: lease from the frontier, submit through the transport, then
 * validate and ingest. Results come from untrusted nodes, so nothing is used before it passes the
 * contract schema and a set of cross-checks against what was asked for.
 */
export class Crawler {
  private readonly clock: () => number; private readonly batch: number; private readonly infraRetryMs: number; private readonly infraBaseMs: number;
  /** Consecutive windows in which PrivaNet was unreachable, and when the current window ends. */
  private infraLevel = 0; private breakerUntil = 0;
  constructor(private readonly o: DriverOptions) {
    this.clock = o.clock ?? Date.now; this.batch = o.batch ?? 8; this.infraRetryMs = o.infrastructureRetryMs ?? 60000; this.infraBaseMs = o.infrastructureBackoffBaseMs ?? 1000;
  }

  /**
   * How long a URL waits after PrivaNet could not be reached. The first failure opens a short window (1 s), every URL that fails inside it shares its end,
   * and a failure after it doubles the next window up to the configured maximum; one answer from PrivaNet resets it. A brief Coordinator restart therefore
   * costs seconds, not a flat minute per URL (measured on a real LAN deployment), while a long outage is still probed gently instead of hammered.
   */
  private infrastructureDelay(now: number): number {
    if (now >= this.breakerUntil) { this.infraLevel++; this.breakerUntil = now + Math.min(this.infraRetryMs, this.infraBaseMs * 2 ** Math.min(this.infraLevel - 1, 16)); }
    return this.breakerUntil - now;
  }

  async runOnce(): Promise<PassSummary> {
    const summary: PassSummary = { submitted: 0, outcomes: {}, indexed: 0, duplicates: 0, discovered: 0, invalidResults: 0, transportErrors: 0, trapped: 0, changed: 0 };
    this.o.frontier.requeueStale(this.clock());
    const leased = this.o.frontier.lease(this.clock(), this.batch);
    await Promise.all(leased.map(item => this.crawl(item, summary)));
    return summary;
  }

  /**
   * Continuous pipeline: keeps up to `concurrency` crawls in flight and leases more from the frontier the moment a
   * slot frees, instead of waiting for a whole batch (runOnce) to finish. A batch-at-a-time loop lets the queue at
   * PrivaNet drain empty every pass, so an idle node pays its poll interval before each batch; measured, that made
   * throughput proportional to the batch size. The frontier still allows one in-flight URL per host and enforces
   * politeness delays, so more concurrency never means more pressure on one site.
   */
  async run(options: { concurrency?: number; signal?: AbortSignal; until?: () => boolean; idleMs?: number } = {}): Promise<PassSummary> {
    const summary: PassSummary = { submitted: 0, outcomes: {}, indexed: 0, duplicates: 0, discovered: 0, invalidResults: 0, transportErrors: 0, trapped: 0, changed: 0 };
    const concurrency = Math.max(1, options.concurrency ?? this.batch); const idleMs = Math.max(1, options.idleMs ?? 25);
    const active = new Set<Promise<void>>();
    const nap = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    while (!options.signal?.aborted && !options.until?.()) {
      const room = concurrency - active.size;
      // While PrivaNet is unreachable nothing new is leased: the frontier is not churned through failing submissions.
      if (room > 0 && this.clock() >= this.breakerUntil) {
        this.o.frontier.requeueStale(this.clock());
        for (const item of this.o.frontier.lease(this.clock(), room)) {
          const task: Promise<void> = this.crawl(item, summary).finally(() => { active.delete(task); });
          active.add(task);
        }
      }
      // Wake as soon as any crawl finishes (a slot is free), or after a short nap when nothing is due yet.
      await Promise.race([...active, nap(idleMs)]);
    }
    await Promise.allSettled([...active]); // never abandon a submitted job: its result must be ingested or its key retried
    return summary;
  }

  private async crawl(item: Leased, summary: PassSummary): Promise<void> {
    summary.submitted++;
    let raw: unknown;
    try {
      raw = await this.o.transport.fetch({
        input: { url: item.url, mode: 'DIGEST', ...(item.validators ? { validators: item.validators } : {}) },
        idempotencyKey: idempotencyKeyFor(item.url, item.generation), queue: item.queue, ...(this.o.hardStop ? { signal: this.o.hardStop } : {}),
      });
    } catch (error) {
      summary.transportErrors++;
      // No result was obtained: not the URL's fault. Keep the generation so a resubmission is deduplicated by PrivaNet.
      const now = this.clock();
      // A job that FAILED inside PrivaNet is a finished answer about this URL, not an outage: PrivaNet is reachable and resubmitting the same key would only replay the
      // same failed job for ever (and every replay would open the "unreachable" window and stall all other crawling). It counts as a failed attempt, with backoff, and
      // the next attempt gets a new generation and therefore a new job.
      if (error instanceof TransportError && error.code === 'JOB_FAILED') { this.o.frontier.fail(item.urlKey, now, 'JOB_FAILED'); return; }
      const delay = error instanceof TransportError && !error.retryable ? this.infraRetryMs * 10 : this.infrastructureDelay(now);
      this.o.frontier.release(item.urlKey, now, delay); return;
    }
    this.infraLevel = 0;
    const parsed = FetchResultSchema.safeParse(raw);
    const problem = parsed.success ? this.crossCheck(item, parsed.data) : 'SCHEMA';
    if (!parsed.success || problem) { summary.invalidResults++; this.o.frontier.fail(item.urlKey, this.clock(), `INVALID_RESULT:${problem ?? 'SCHEMA'}`); return; }
    const result = parsed.data; const now = this.clock();
    // The URL's new state and the page it produced are stored together. Marking the URL done and then failing to store its page would leave it "fresh"
    // with nothing indexed, and a later 304 would never repair that. If storing fails, nothing of this result is kept and the URL counts a failed attempt.
    const counted = { ...summary, discovered: 0, duplicates: 0, indexed: 0, trapped: 0, changed: 0 };
    try {
      this.o.frontier.atomically(() => {
        this.o.frontier.complete(item.urlKey, result, now);
        if (result.outcome === 'FETCHED' && result.page) this.ingest(item, result, counted);
        else if (result.outcome === 'HTTP_ERROR' && (result.httpStatus === 404 || result.httpStatus === 410)) this.o.documents.remove(item.urlKey);
      });
    } catch {
      summary.invalidResults++; this.o.frontier.fail(item.urlKey, this.clock(), 'INGEST_FAILED'); return;
    }
    summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
    summary.discovered += counted.discovered; summary.duplicates += counted.duplicates; summary.indexed += counted.indexed; summary.trapped += counted.trapped; summary.changed += counted.changed;
  }

  /** What a well-behaved node cannot get wrong. A mismatch means a buggy or dishonest node, so the result is rejected. */
  private crossCheck(item: Leased, result: FetchResult): string | undefined {
    if (result.requestedUrl !== item.url) return 'REQUESTED_URL_MISMATCH';
    if (result.finalUrl !== undefined) {
      const final = parseCrawlUrl(result.finalUrl); if (!final.ok) return 'FINAL_URL_INVALID';
      if (final.host !== item.host) return 'FINAL_URL_OFF_HOST'; // the node must not follow cross-origin redirects
    }
    if (result.outcome === 'REDIRECT' && !result.redirectTarget) return 'REDIRECT_WITHOUT_TARGET';
    if (result.outcome === 'FETCHED' && (!result.page || !result.contentSha256 || result.httpStatus === undefined || result.httpStatus < 200 || result.httpStatus > 299)) return 'FETCHED_INCOMPLETE';
    if (result.outcome === 'HTTP_ERROR' && (result.httpStatus === undefined || result.httpStatus < 400)) return 'HTTP_ERROR_STATUS';
    if (result.outcome === 'RATE_LIMITED' && result.retryAfterSec === undefined) return 'RATE_LIMITED_WITHOUT_DELAY';
    if (result.outcome === 'FETCH_FAILED' && !result.error) return 'FAILED_WITHOUT_ERROR';
    return undefined;
  }

  private ingest(item: Leased, result: FetchResult, summary: PassSummary): void {
    const page = result.page; if (!page) return;
    const frontier = this.o.frontier; const policy = frontier.policy; const now = this.clock();
    let stored: { duplicateOf?: string; changed: boolean } | undefined; let kind: 'useful' | 'duplicate' | 'low_value' | undefined;
    // A short "not found" page served with HTTP 200, or a page with almost nothing on it: kept (down-ranked, never deleted) and counted against its domain's yield.
    const lowValue = looksLikeSoft404(page.title ?? '', page.text ?? '', page.links.length) || looksThin(page.text ?? '', page.links.length);
    if (result.indexing?.noindex) { this.o.documents.remove(item.urlKey); } // the site asked not to be indexed: drop anything held, and keep its links out of the graph
    else {
      stored = this.o.documents.upsert({
        urlKey: item.urlKey, url: item.url, finalUrl: result.finalUrl ?? item.url, title: page.title ?? '', description: page.description ?? '',
        canonicalUrl: page.canonicalUrl ?? null, language: page.language ?? null, text: page.text ?? '', contentSha256: result.contentSha256 ?? '', fetchedAt: result.fetchedAtMs, httpStatus: result.httpStatus ?? 200, lowValue });
      if (stored.duplicateOf) summary.duplicates++; else summary.indexed++;
      if (stored.changed && !stored.duplicateOf) summary.changed++;
      kind = stored.duplicateOf ? 'duplicate' : lowValue ? 'low_value' : 'useful'; frontier.recordPage(item.urlKey, kind, now);
    }
    if (result.indexing?.nofollow) { if (stored) this.o.documents.setLinks(item.urlKey, item.host, []); return; }
    // Discovered links become public-queue work. Which links, and how many: see `chooseLinks`. Priorities are computed by the frontier from the link's facts.
    const graph: Array<{ key: string; url: string; host: string }> = []; const candidates: LinkCandidate[] = [];
    const srcDomain = frontier.model.domainOf(item.host); const titleWords = words(page.title ?? '');
    for (const link of page.links) {
      if (link.nofollow) continue;
      const parsed = parseCrawlUrl(link.url, item.url, policy.trackingParams); if (!parsed.ok) continue;
      graph.push({ key: urlKey(parsed.url), url: parsed.url, host: parsed.host });
      const domain = frontier.model.domainOf(parsed.host); let path = parsed.url; try { path = new URL(parsed.url).pathname; } catch { /* keep the whole URL */ }
      candidates.push({ url: parsed.url, domain, kind: domain !== srcDomain ? 'external' : parsed.host !== item.host ? 'sibling' : 'internal', relevant: pathShares(path, titleWords) });
    }
    const foreignPage = !languagePreferred(page.language, policy.preferredLanguages);
    for (const link of chooseLinks(candidates, policy, foreignPage)) {
      const added = frontier.add(link.url, { queue: 'PUBLIC', depth: item.depth + 1, source: 'discovered', external: link.kind === 'external', relevant: link.relevant }, now);
      if (added === 'ADDED') summary.discovered++; else if (added !== 'EXISTS') summary.trapped++;
    }
    if (kind === 'useful') for (const domain of new Set(candidates.filter(c => c.kind === 'external').map(c => c.domain))) frontier.noteDomainLink(srcDomain, domain); // independent referring domains, from real pages only
    if (stored && !stored.duplicateOf) this.o.documents.setLinks(item.urlKey, item.host, graph);
    // A page that names another page of the same site as its canonical version makes that page worth fetching (never another site: a page cannot send the crawler elsewhere).
    if (stored && !stored.duplicateOf && page.canonicalUrl) {
      const canonical = parseCrawlUrl(page.canonicalUrl, result.finalUrl ?? item.url, policy.trackingParams);
      if (canonical.ok && canonical.host === item.host) frontier.add(canonical.url, { queue: 'PUBLIC', depth: item.depth, source: 'discovered' }, now);
    }
  }
}

export interface LinkCandidate { url: string; domain: string; kind: 'internal' | 'external' | 'sibling'; relevant: boolean }
/**
 * Bounded, deterministic link fanout. A page may name up to 100 links (the contract), but a giant site's page names mostly its own navigation. The frontier gets:
 *   external   up to maxExternalLinksPerPage, one per distinct other domain first (document order), then more from the same domains: the way a crawl widens
 *   internal   up to maxInternalLinksPerPage, links whose path shares a word with the page title first, then document order
 *   sibling    up to maxSiblingLinksPerPage links to ANOTHER HOST of the same domain (language editions, docs./blog./shop. subdomains): a language switcher names dozens of them
 * From a page in a language outside the preferred set (unless preferredLanguages is '*') only external links are followed: one foreign page must not open a whole foreign site.
 * Everything is a pure function of the page, so the same page always yields the same links.
 */
export function chooseLinks(candidates: LinkCandidate[], policy: { maxInternalLinksPerPage: number; maxExternalLinksPerPage: number; maxSiblingLinksPerPage: number }, foreignPage: boolean): LinkCandidate[] {
  const seen = new Set<string>(); const unique = candidates.filter(c => !seen.has(c.url) && seen.add(c.url));
  const external = unique.filter(c => c.kind === 'external'); const firstPerDomain = new Set<string>(); const spread: LinkCandidate[] = []; const more: LinkCandidate[] = [];
  for (const c of external) { if (firstPerDomain.has(c.domain)) more.push(c); else { firstPerDomain.add(c.domain); spread.push(c); } }
  const chosen = [...spread, ...more].slice(0, policy.maxExternalLinksPerPage);
  if (foreignPage) return chosen;
  const internal = unique.filter(c => c.kind === 'internal'); const ranked = [...internal.filter(c => c.relevant), ...internal.filter(c => !c.relevant)];
  return [...chosen, ...ranked.slice(0, policy.maxInternalLinksPerPage), ...unique.filter(c => c.kind === 'sibling').slice(0, policy.maxSiblingLinksPerPage)];
}
