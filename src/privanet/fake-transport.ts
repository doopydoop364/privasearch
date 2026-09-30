import { FetchInputSchema, FETCH_JOB_TYPE, IDEMPOTENCY_KEY } from './fetch-contract.js';
import type { FetchResult } from './fetch-contract.js';
import { TransportError } from './transport.js';
import type { FetchRequest, FetchTransport } from './transport.js';

/**
 * TEST DOUBLE ONLY. It stands in for the PrivaNet path (SDK, Coordinator, node) until the real capability
 * exists. It never touches the network, the filesystem or any real site: every result is canned by the
 * test. It enforces what the real path enforces on the way in (the strict input schema and the
 * idempotency-key rule) and replays the same result for a repeated key, so tests exercise the same
 * contract the real transport will.
 */
export type Responder = (input: ReturnType<typeof FetchInputSchema.parse>, request: FetchRequest) => unknown | Promise<unknown>;
export class FakeTransport implements FetchTransport {
  readonly type = FETCH_JOB_TYPE;
  readonly calls: FetchRequest[] = [];
  private readonly byKey = new Map<string, unknown>();
  inFlight = 0; maxInFlight = 0;
  constructor(private readonly respond: Responder) {}
  async fetch(request: FetchRequest): Promise<unknown> {
    this.calls.push(request);
    if (!IDEMPOTENCY_KEY.test(request.idempotencyKey)) throw new TransportError('FORBIDDEN', false);
    const input = FetchInputSchema.parse(request.input); // the Coordinator would reject a malformed input with 400
    const seen = this.byKey.get(request.idempotencyKey); if (seen !== undefined) return seen;
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      const result = await this.respond(input, request);
      this.byKey.set(request.idempotencyKey, result);
      return result;
    } finally { this.inFlight--; }
  }
}

/** Builders for canned results, so tests read like the contract. */
const base = (url: string, at: number): Pick<FetchResult, 'requestedUrl' | 'redirects' | 'fetchedAtMs' | 'durationMs' | 'robots'> =>
  ({ requestedUrl: url, redirects: [], fetchedAtMs: at, durationMs: 120, robots: { verdict: 'ALLOWED' } });
export function pageResult(url: string, at: number, page: { title?: string; description?: string; text?: string; links?: Array<{ url: string; nofollow?: boolean }> } = {}, extra: Partial<FetchResult> = {}): FetchResult {
  const digest = Buffer.from(`${url}|${page.text ?? ''}|${page.title ?? ''}`).toString('hex').padEnd(64, '0').slice(0, 64);
  return { ...base(url, at), outcome: 'FETCHED', finalUrl: url, httpStatus: 200, contentType: 'text/html', charset: 'utf-8', bodyBytes: 2048, bodyTruncated: false, contentSha256: digest,
    etag: '"v1"', page: { ...(page.title === undefined ? {} : { title: page.title }), ...(page.description === undefined ? {} : { description: page.description }), ...(page.text === undefined ? {} : { text: page.text }),
      links: (page.links ?? []).map(link => ({ url: link.url, nofollow: link.nofollow ?? false })), linksTruncated: false }, ...extra };
}
export const outcomeResult = (outcome: FetchResult['outcome'], url: string, at: number, extra: Partial<FetchResult> = {}): FetchResult => ({ ...base(url, at), outcome, ...extra });
