import { Frontier } from './frontier.js';
import type { Leased } from './frontier.js';
import { DocumentStore } from './documents.js';
import { FetchResultSchema } from './privanet/contract.js';
import type { FetchResult } from './privanet/contract.js';
import { TransportError } from './privanet/transport.js';
import type { FetchTransport } from './privanet/transport.js';
import { idempotencyKeyFor, parseCrawlUrl } from './url.js';

export interface DriverOptions {
  frontier: Frontier; documents: DocumentStore; transport: FetchTransport; clock?: () => number;
  /** URLs submitted per pass; the frontier still allows only one per host. */
  batch?: number; infrastructureRetryMs?: number;
}
export interface PassSummary {
  submitted: number; outcomes: Partial<Record<FetchResult['outcome'], number>>;
  indexed: number; duplicates: number; discovered: number; invalidResults: number; transportErrors: number;
}

/**
 * Drives crawling through PrivaNet: lease from the frontier, submit through the transport, then
 * validate and ingest. Results come from untrusted nodes, so nothing is used before it passes the
 * contract schema and a set of cross-checks against what was asked for.
 */
export class Crawler {
  private readonly clock: () => number; private readonly batch: number; private readonly infraRetryMs: number;
  constructor(private readonly o: DriverOptions) { this.clock = o.clock ?? Date.now; this.batch = o.batch ?? 8; this.infraRetryMs = o.infrastructureRetryMs ?? 60000; }

  async runOnce(): Promise<PassSummary> {
    const summary: PassSummary = { submitted: 0, outcomes: {}, indexed: 0, duplicates: 0, discovered: 0, invalidResults: 0, transportErrors: 0 };
    this.o.frontier.requeueStale(this.clock());
    const leased = this.o.frontier.lease(this.clock(), this.batch);
    await Promise.all(leased.map(item => this.crawl(item, summary)));
    return summary;
  }

  private async crawl(item: Leased, summary: PassSummary): Promise<void> {
    summary.submitted++;
    let raw: unknown;
    try {
      raw = await this.o.transport.fetch({
        input: { url: item.url, mode: 'DIGEST', ...(item.validators ? { validators: item.validators } : {}) },
        idempotencyKey: idempotencyKeyFor(item.url, item.generation), queue: item.queue,
      });
    } catch (error) {
      summary.transportErrors++;
      // No result was obtained: not the URL's fault. Keep the generation so a resubmission is deduplicated by PrivaNet.
      const delay = error instanceof TransportError && !error.retryable ? this.infraRetryMs * 10 : this.infraRetryMs;
      this.o.frontier.release(item.urlKey, this.clock(), delay); return;
    }
    const parsed = FetchResultSchema.safeParse(raw);
    const problem = parsed.success ? this.crossCheck(item, parsed.data) : 'SCHEMA';
    if (!parsed.success || problem) { summary.invalidResults++; this.o.frontier.fail(item.urlKey, this.clock(), `INVALID_RESULT:${problem ?? 'SCHEMA'}`); return; }
    const result = parsed.data; const now = this.clock();
    summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
    this.o.frontier.complete(item.urlKey, result, now);
    if (result.outcome === 'FETCHED' && result.page) this.ingest(item, result, summary);
    else if (result.outcome === 'HTTP_ERROR' && (result.httpStatus === 404 || result.httpStatus === 410)) this.o.documents.remove(item.urlKey);
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
    if (result.indexing?.noindex) { this.o.documents.remove(item.urlKey); } // the site asked not to be indexed: drop anything held
    else {
      const stored = this.o.documents.upsert({
        urlKey: item.urlKey, url: item.url, finalUrl: result.finalUrl ?? item.url, title: page.title ?? '', description: page.description ?? '',
        canonicalUrl: page.canonicalUrl ?? null, language: page.language ?? null, text: page.text ?? '', contentSha256: result.contentSha256 ?? '', fetchedAt: result.fetchedAtMs, httpStatus: result.httpStatus ?? 200 });
      if (stored.duplicateOf) summary.duplicates++; else summary.indexed++;
    }
    if (result.indexing?.nofollow) return;
    // Discovered links become public-queue work: user demand only ever comes from an explicit request.
    for (const link of page.links) {
      if (link.nofollow) continue;
      const parsed = parseCrawlUrl(link.url, item.url); if (!parsed.ok) continue;
      // The frontier enforces the maximum crawl depth.
      const added = this.o.frontier.add(parsed.url, { queue: 'PUBLIC', depth: item.depth + 1 }, this.clock());
      if (added === 'ADDED') summary.discovered++;
    }
  }
}
