# Architecture

PrivaSearch owns: the URL frontier, crawl prioritisation, robots and crawl *policy*, recrawl policy, document handling, the index, ranking, deduplication, and (later) metasearch, UI and public-versus-demand policy. PrivaNet owns transport, authentication, scheduling, leases, and the security-critical fetch. The boundary is documented on the PrivaNet side in `docs/APPLICATION_BOUNDARY.md` (ADR 005).

## Components

**Frontier** (`src/frontier.ts`, SQLite). One row per canonical URL. States `PENDING`, `IN_FLIGHT`, `DONE` (fresh until `next_at`, then due for recrawl), `BLOCKED` (the node refused the target; never retried), `FAILED` (attempts exhausted; terminal). Leasing returns at most one URL per host, none for a host with a request in flight, inside its delay, or backing off, and serves the `DEMAND` queue before `PUBLIC`. A demand request promotes a known public URL. Discovered links are always public work.

Every outcome has an explicit policy: success schedules a recrawl with stored validators; a redirect closes the URL and admits the target as new work; robots disallow re-checks in a day; `RATE_LIMITED` waits as told without counting an attempt; `Retry-After` and errors back off exponentially per URL and per host; 404 and 410 are rechecked in 30 days; attempts are bounded.

**Generations and idempotency.** The idempotency key is `crawl:<sha256(url)[0:32]>:<generation>`. The generation advances only when a result was obtained. If the submission gets no result (Coordinator unreachable, queue full) the URL is released with the same generation, so PrivaNet deduplicates the resubmission instead of creating a second job.

**Driver** (`src/driver.ts`). Lease, submit through the transport, validate through the contract schema, cross-check, then ingest. Cross-checks reject results a well-behaved node cannot produce: a different requested URL, a final URL on another host, `FETCHED` without a page, hash or 2xx status, `REDIRECT` without a target, `RATE_LIMITED` without a delay, and so on. A rejected result counts as a failed attempt.

**Documents and index** (`src/documents.ts`). SQLite `documents` plus an FTS5 table (title weighted above description above body, BM25). Identical content under another URL is stored as a duplicate and not indexed. `noindex` pages are never stored and are removed if previously held. Queries are reduced to quoted terms.

**Search API** (`src/server.ts`). `GET /search?q=&limit=` and `GET /health`, JSON only, bounded, no cookies, no query logging. No UI.

## Trust boundaries

Nodes and their results are untrusted. The MVP with one operator-owned node is trusted by construction; before third-party nodes crawl, PrivaSearch needs sampled redundant crawls compared by content hash and per-node disagreement tracking (not built). PrivaNet provides no execution attestation.

## What is not built

The real PrivaNet transport, robots caching for scheduling, sitemap handling, crawl-trap heuristics, near-duplicate detection, language handling, ranking beyond BM25, metasearch, UI, and the public-crawl budget logic.
