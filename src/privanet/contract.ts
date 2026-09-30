import { FETCH_MAX_RESULT_BYTES, FETCH_OUTCOMES, FetchInputSchema, FetchOutputSchema, SubmitSchema } from '@privanet/protocol';
import type { FetchInput, FetchOutput } from '@privanet/protocol';

/**
 * The fetch capability contract is owned by PrivaNet-Core and consumed here from @privanet/protocol.
 * There is no local copy: a schema change arrives as a package upgrade and shows up as a type error or a
 * failing test. This is application code, so it only re-exports; every result is still validated because
 * results come from untrusted nodes.
 */
export const FETCH_JOB_TYPE = 'web.fetch.v1' as const;
export { FETCH_MAX_RESULT_BYTES, FETCH_OUTCOMES, FetchInputSchema, FetchOutputSchema };
export type { FetchInput, FetchOutput };
export type FetchOutcome = FetchOutput['outcome'];
export const FetchResultSchema = FetchOutputSchema;
export type FetchResult = FetchOutput;

/** Whether PrivaNet would accept this idempotency key, decided by its own submit schema rather than a copy of the rule. */
export function isValidIdempotencyKey(key: string): boolean {
  return SubmitSchema.safeParse({ type: FETCH_JOB_TYPE, input: { url: 'https://example.invalid/' }, idempotencyKey: key }).success;
}
