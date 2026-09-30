import { z } from 'zod';

/**
 * PrivaSearch's private mirror of the PrivaNet fetch capability contract.
 *
 * The authoritative specification is docs/PRIVASEARCH_INTEGRATION.md in PrivaNet-Core, copied here from
 * commit ffc35e3. The capability id is PROVISIONAL (ADR 005 is proposed, not confirmed) and is defined
 * in exactly one place so a rename touches one line. This is application code: PrivaNet-Core does not
 * import it, and every result is validated through it because results come from untrusted nodes.
 */
export const CONTRACT_SOURCE = 'PrivaNet-Core@ffc35e3 docs/PRIVASEARCH_INTEGRATION.md';
export const FETCH_JOB_TYPE = 'web.fetch.v1';
/** Core's idempotency key rule: 1-128 characters of [a-zA-Z0-9_.:-]. */
export const IDEMPOTENCY_KEY = /^[a-zA-Z0-9_.:-]{1,128}$/;
/** A job result must fit one 32 KiB control-plane body; Core bounds the serialized result at this size. */
export const MAX_RESULT_BYTES = 28000;

const Url = z.string().min(8).max(2048);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.number().int().nonnegative();

export const FetchInputSchema = z.strictObject({
  url: Url,
  mode: z.enum(['DIGEST', 'PROBE']).default('DIGEST'),
  validators: z.strictObject({
    etag: z.string().max(200).regex(/^(?:W\/)?"[\x21\x23-\x7e]*"$/).optional(),
    lastModified: z.string().max(40).regex(/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/).optional(),
  }).optional(),
  maxRedirects: z.number().int().min(0).max(3).default(3),
  timeoutMs: z.number().int().min(1000).max(30000).default(20000),
  maxBodyBytes: z.number().int().min(4096).max(1048576).default(524288),
  maxTextBytes: z.number().int().min(0).max(10240).default(10240),
  maxLinks: z.number().int().min(0).max(100).default(100),
});
export type FetchInput = z.input<typeof FetchInputSchema>;

export const OUTCOMES = [
  'FETCHED', 'NOT_MODIFIED', 'PROBED', 'REDIRECT', 'ROBOTS_DISALLOWED', 'ROBOTS_UNAVAILABLE', 'BLOCKED_TARGET',
  'RATE_LIMITED', 'UNSUPPORTED_CONTENT_TYPE', 'TOO_LARGE', 'HTTP_ERROR', 'FETCH_FAILED',
] as const;
export const FetchOutcomeSchema = z.enum(OUTCOMES);
export type FetchOutcome = z.infer<typeof FetchOutcomeSchema>;

export const FetchResultSchema = z.strictObject({
  outcome: FetchOutcomeSchema,
  requestedUrl: Url,
  finalUrl: Url.optional(),
  redirectTarget: Url.optional(),
  redirects: z.array(z.strictObject({ url: Url, status: z.number().int().min(300).max(399) })).max(3),
  httpStatus: z.number().int().min(100).max(599).optional(),
  fetchedAtMs: Time, durationMs: z.number().int().min(0).max(120000),
  contentType: z.string().max(100).optional(), charset: z.string().max(40).optional(),
  bodyBytes: z.number().int().min(0).max(1048576).optional(),
  bodyTruncated: z.boolean().optional(),
  contentSha256: Sha256.optional(),
  etag: z.string().max(200).optional(), lastModified: z.string().max(40).optional(),
  retryAfterSec: z.number().int().min(0).max(86400).optional(),
  robots: z.strictObject({
    verdict: z.enum(['ALLOWED', 'DISALLOWED', 'UNAVAILABLE']),
    fetchedAtMs: Time.optional(), sha256: Sha256.optional(),
    crawlDelaySec: z.number().min(0).max(300).optional(),
  }),
  indexing: z.strictObject({ noindex: z.boolean(), nofollow: z.boolean(), noarchive: z.boolean() }).optional(),
  page: z.strictObject({
    title: z.string().max(300).optional(), description: z.string().max(500).optional(),
    canonicalUrl: Url.optional(), language: z.string().max(35).optional(),
    text: z.string().max(10240).optional(), textTruncated: z.boolean().optional(),
    links: z.array(z.strictObject({ url: Url, nofollow: z.boolean() })).max(100),
    linksTruncated: z.boolean(),
  }).optional(),
  error: z.strictObject({ code: z.enum(['DNS', 'CONNECT', 'TLS', 'TIMEOUT', 'RESET', 'PROTOCOL', 'DECODE', 'INTERNAL']), retryable: z.boolean() }).optional(),
}).refine(result => Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES, 'result too large');
export type FetchResult = z.infer<typeof FetchResultSchema>;
