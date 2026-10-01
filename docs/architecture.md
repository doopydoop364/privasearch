# Architecture

PrivaSearch owns: the search API, the URL frontier, crawl prioritisation, demand-crawl policy, robots and crawl *policy*, recrawl policy, document handling, the index, ranking and deduplication. The user interface is PrivaProxy's; metasearch and public-versus-demand budget policy are later. PrivaNet owns transport, authentication, scheduling, leases, and the security-critical fetch. The boundary is documented on the PrivaNet side in `docs/APPLICATION_BOUNDARY.md` (ADR 005).

## Components

**Frontier** (`src/frontier.ts`, SQLite). One row per canonical URL. States `PENDING`, `IN_FLIGHT`, `DONE` (fresh until `next_at`, then due for recrawl), `BLOCKED` (the node refused the target; never retried), `FAILED` (attempts exhausted; retried only rarely, after everything else). Leasing returns at most one URL per host, none for a host with a request in flight, inside its delay, or backing off, and serves the `DEMAND` queue before `PUBLIC`. A demand request promotes a known public URL. Discovered links are always public work.

Every outcome has an explicit policy: success schedules a recrawl with stored validators; a redirect closes the URL and admits the target as new work; robots disallow re-checks in a day; `RATE_LIMITED` waits as told without counting an attempt; `Retry-After` and errors back off exponentially per URL and per host; 404 and 410 are rechecked in 30 days; attempts are bounded.

**Generations and idempotency.** The idempotency key is `crawl:<sha256(url)[0:32]>:<generation>`. The generation advances only when a result was obtained. If the submission gets no result (Coordinator unreachable, queue full) the URL is released with the same generation, so PrivaNet deduplicates the resubmission instead of creating a second job.

**Driver** (`src/driver.ts`). Lease, submit through the transport, validate through the contract schema, cross-check, then ingest. Cross-checks reject results a well-behaved node cannot produce: a different requested URL, a final URL on another host, `FETCHED` without a page, hash or 2xx status, `REDIRECT` without a target, `RATE_LIMITED` without a delay, and so on. A rejected result counts as a failed attempt.

**Documents and index** (`src/documents.ts`). SQLite `documents` plus an FTS5 table (title weighted above description above body, BM25). Identical content under another URL is stored as a duplicate and not indexed. `noindex` pages are never stored and are removed if previously held. Queries are reduced to quoted terms.

**Index and link graph** (`src/documents.ts`, `src/db.ts`). Besides the FTS5 index, `documents` keeps the canonical key, host, first-seen, last-changed and change-count, and `links` keeps who links to whom (used for the inbound-host ranking signal and for discovery). A page naming another indexed page as canonical is a duplicate of it. `initSchema` creates and migrates the schema (`user_version` 2), so every component can open the same file.

**Ranking** (`src/ranking.ts`, [ranking.md](ranking.md)). Retrieves by full-text match (all terms, then any term to fill out thin results), scores each candidate from relevance, title, address, description, phrase, coverage, freshness and inbound-host links, suppresses URL variants, and spreads hosts. Deterministic.

**Search API** (`src/server.ts`, [search-api.md](search-api.md)). `GET /search` (ranked, paginated, with relevance signals, `index` and `crawl` state), `GET /health`, `GET /status`; JSON only, bounded, optional bearer token, no cookies, no query logging.

**Demand planner and discovery** (`src/demand.ts`, `src/discovery.ts`, [crawling.md](crawling.md#demand-crawling)). After a first-page search it decides whether the results are weak, applies cooldown, queue and hourly limits, asks the discovery sources (frontier, link graph, operator templates) for URLs, and queues them as `DEMAND` work. A query is stored only as a salted hash.

**Crawl policy** (`src/policy.ts`, `src/frontier.ts`). Crawl-trap heuristics, discovery priority by depth, a per-host URL budget, adaptive recrawl intervals from content-hash changes, and a lease mix that reserves a share for recrawls.

**Service** (`src/service.ts`, `src/service-config.ts`, `src/main.ts`, [deployment.md](deployment.md)). One process: opens the database, returns leases the previous process held, adds seeds, starts the API and a supervised crawler loop, and stops gracefully (soft stop, a deadline for submitted fetches, then give up on the rest and release their URLs). Search-only when no PrivaNet settings are present.

## Trust boundaries

Nodes and their results are untrusted. The MVP with one operator-owned node is trusted by construction; before third-party nodes crawl, PrivaSearch needs sampled redundant crawls compared by content hash and per-node disagreement tracking (not built). PrivaNet provides no execution attestation.

## What is not built

Robots caching for scheduling, sitemap handling, near-duplicate (not identical) detection, language handling, anchor-text and propagated link ranking, query understanding (stemming, synonyms, spelling), metasearch, a UI of its own (PrivaProxy provides one), distributed storage, and the public-crawl budget logic. See [crawling.md](crawling.md#limitations-known-not-hidden).
