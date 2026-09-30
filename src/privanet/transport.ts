import type { FetchInput } from './contract.js';

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
  | 'FORBIDDEN'     // 401/403 bad credential, JOB_TYPE_FORBIDDEN or FETCH_IDENTITY_REQUIRED: configuration error, do not retry blindly
  | 'INCOMPATIBLE'  // 426 protocol mismatch or an unparseable Coordinator answer: upgrade the packages, do not retry blindly
  | 'JOB_FAILED'    // the job itself failed inside PrivaNet (handler bug, release limit)
  | 'TIMEOUT';
export class TransportError extends Error {
  constructor(readonly code: TransportErrorCode, readonly retryable: boolean) { super(code); this.name = 'TransportError'; }
}
/**
 * The only door from PrivaSearch to PrivaNet. PrivaNetTransport wraps @privanet/sdk (submit with the
 * idempotency key, then waitForResult); FakeTransport is the test double. The result is `unknown` on purpose: nothing from a node is trusted until the driver validates it.
 */
export interface FetchTransport {
  fetch(request: FetchRequest): Promise<unknown>;
}
