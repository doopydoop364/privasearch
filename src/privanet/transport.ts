import type { FetchInput } from './fetch-contract.js';

/** The two crawl queues from the design. Each maps to its own PrivaNet application credential. */
export type Queue = 'DEMAND' | 'PUBLIC';
export interface FetchRequest {
  input: FetchInput;
  /** crawl:<sha256(url)[0:32]>:<generation>. Resubmitting the same key returns the same job. */
  idempotencyKey: string;
  queue: Queue;
  signal?: AbortSignal;
}
export type TransportErrorCode =
  | 'UNAVAILABLE'   // Coordinator unreachable or no node online: retry later, not the URL's fault
  | 'QUEUE_FULL'    // 429 QUEUE_LIMIT: back off submissions
  | 'FORBIDDEN'     // 403 JOB_TYPE_FORBIDDEN or bad credential: configuration error, do not retry blindly
  | 'JOB_FAILED'    // the job itself failed inside PrivaNet (handler bug, release limit)
  | 'TIMEOUT';
export class TransportError extends Error {
  constructor(readonly code: TransportErrorCode, readonly retryable: boolean) { super(code); this.name = 'TransportError'; }
}
/**
 * The only door from PrivaSearch to PrivaNet. The real implementation wraps @privanet/sdk
 * (submit with the idempotency key, then waitForResult); it is deliberately NOT wired yet, because the
 * capability does not exist in PrivaNet-Core and the SDK is not consumable from this repository (see README).
 * The result is `unknown` on purpose: nothing from a node is trusted until the driver validates it.
 */
export interface FetchTransport {
  fetch(request: FetchRequest): Promise<unknown>;
}
