import { ZodError } from 'zod';
import { ApiError, PrivaNetClient } from '@privanet/sdk';
import { FETCH_JOB_TYPE, isValidIdempotencyKey } from './contract.js';
import { TransportError } from './transport.js';
import type { FetchRequest, FetchTransport, Queue } from './transport.js';

export interface PrivaNetTransportOptions {
  /** Coordinator base URL, e.g. https://coordinator.example or (local development only) http://127.0.0.1:4010. */
  url: string;
  /** One application credential per queue: the demand and public queues never share a credential. */
  tokens: Record<Queue, string>;
  allowInsecureLoopback?: boolean;
  /** How long to wait for a job to finish before giving up on this attempt (the same key can be resubmitted). */
  waitTimeoutMs?: number; pollMs?: number;
}

/** Translates SDK and Coordinator errors into the small, retry-aware vocabulary the crawler understands. */
export function translateError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;
  if (error instanceof ApiError) {
    if (error.status === 429) return new TransportError('QUEUE_FULL', true);
    if (error.status === 408 || error.code === 'WAIT_TIMEOUT') return new TransportError('TIMEOUT', true);
    if (error.status === 426) return new TransportError('INCOMPATIBLE', false);
    if (error.status === 401 || error.status === 403) return new TransportError('FORBIDDEN', false);
    if (error.status === 409) return new TransportError('JOB_FAILED', true); // the job failed inside PrivaNet; a new generation may succeed
    if (error.status >= 500) return new TransportError('UNAVAILABLE', true);
    return new TransportError('FORBIDDEN', false); // 400/404/422: our request was wrong, retrying the same thing will not help
  }
  if (error instanceof ZodError) return new TransportError('INCOMPATIBLE', false); // the SDK refused an answer that violates the contract (its own second validation)
  return new TransportError('UNAVAILABLE', true); // network failure, aborted request, unparseable response
}

/**
 * The real transport: PrivaSearch → @privanet/sdk → Coordinator → a PrivaNode → web.fetch.v1.
 * PrivaSearch performs no HTTP fetch of a crawled URL itself; this is the only outbound path for crawling.
 * Resubmitting the same idempotency key returns the same job, so a retry after a lost response cannot fetch twice.
 */
export class PrivaNetTransport implements FetchTransport {
  private readonly clients: Record<Queue, PrivaNetClient>;
  private readonly waitTimeoutMs: number; private readonly pollMs: number;
  constructor(options: PrivaNetTransportOptions) {
    const make = (token: string) => new PrivaNetClient({ url: options.url, token, ...(options.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) });
    this.clients = { DEMAND: make(options.tokens.DEMAND), PUBLIC: make(options.tokens.PUBLIC) };
    this.waitTimeoutMs = options.waitTimeoutMs ?? 60000; this.pollMs = options.pollMs ?? 200;
  }

  async fetch(request: FetchRequest): Promise<unknown> {
    if (!isValidIdempotencyKey(request.idempotencyKey)) throw new TransportError('FORBIDDEN', false);
    const client = this.clients[request.queue];
    try {
      const job = await client.submit(FETCH_JOB_TYPE, request.input, request.idempotencyKey);
      return await client.waitForResult(job.id, { timeoutMs: this.waitTimeoutMs, pollMs: this.pollMs, ...(request.signal ? { signal: request.signal } : {}) });
    } catch (error) { throw translateError(error); }
  }
}
