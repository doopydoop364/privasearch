# Crawler health audit — 2026-10-05

## Scope and evidence

PrivaSearch starting commit: `d77ee10c662ea9b8cd2593406106215378fdbac7` (0.5.0). Core starting commit: `29ad9037a856fbc3b12d611a6528c84c223f26d0` (0.4.0-alpha.3). Both checkouts initially clean; no AGENTS.md in either checkout. Existing architecture, crawling, quality, measurements, deployment, integration and maintenance code were inspected before changes. No production database was available and no production state was modified.

Latest mirrored snapshot retrieved from `doopydoop364/doopydoop364.github.io/privanet/crawling/status.json`: generated **2026-10-04 21:45:35.755 UTC**, over two hours old when this audit ran. Its dashboard reported sub-second data age *when the snapshot was generated*, which does not make the mirror current. Recorded baseline: 499,999 pending (499,997 PUBLIC, 2 DEMAND), 134,652 DONE, 423 FAILED, 15 BLOCKED, 8 IN_FLIGHT; 120,119 documents, 111,995 indexed, 8,124 duplicates, 4,979,168 links.

The 100 returned error rows contain 91 ROBOTS_UNAVAILABLE, 6 FETCH_FAILED and 3 HTTP_ERROR; 94 rows have at least five attempts. This is a selected error sample, not an outcome distribution for all requests. Five attempts with a next-due time roughly 30 days later match the existing terminal FAILED recheck policy; they do not establish that the crawler is immediately retrying them.

Facebook/Instagram/X/LinkedIn host rows have large pending backlogs and zero DONE. Some have zero recorded host failures, so backlog alone cannot distinguish unvisited URLs from persistently failing ones. YouTube's www host has 14 DONE, which does not necessarily mean 14 indexed useful pages. A guarded probe through the actual Coordinator/node failed DNS for every tested social host **and the example.com control** in this execution environment. Consequently this audit does not establish their live production crawlability or justify a blacklist. No JavaScript renderer exists in web.fetch.v1, so pages requiring rendering cannot become useful content through this capability.

## Root causes established in source and controlled experiments

1. Robots denials/unavailability and noindex pages did not contribute to useful-yield accounting. Whole classes of unproductive attempts were neutral to weighting.
2. Exploration used `done < 5`, allowing persistently denied domains to stay young indefinitely. DONE itself includes redirects, unsupported content and HTTP errors, so it is also an unreliable successful-document metric.
3. Host failures were counted but backoff duration used only the current URL's attempts. Rotating through fresh sibling URLs repeatedly obtained first-attempt backoff instead of increasing the host's delay.
4. Weighted fairness alone leaves low-yield sites a positive scheduling share. Numerous independent zero-yield domains can collectively consume substantial capacity despite individually fair shares.
5. `/status` concentration was per registrable domain only. The roundup calculated a host share from at most 250 host rows, not the entire frontier. Family budgets existed, but related-operator concentration was not exposed there.
6. Core discarded robots HTTP status, Retry-After and most guarded-client causes before returning ROBOTS_UNAVAILABLE. Historical snapshots cannot recover those lost causes. Robots HTTP 429 also fell into the generic client-error ALLOW_ALL branch.

## Changes

- Eight consecutive unproductive samples open a persistent PUBLIC-domain cooldown: one minute at defaults, doubling on failed probes, capped at six hours. Recovery probes are serialized per domain; useful recovery clears the streak. Explicit DEMAND retains first priority and bypasses the domain cooldown, but never host backoff, politeness, concurrency or bounded URL retries.
- Discovery admission uses at most 64 pending URLs for domains in the sustained bad-streak state. Existing queued URLs are retained; explicit demand/seeds/redirects retain their previous admission exemptions. This does not automatically reclaim an existing saturated frontier.
- Exploration ends after five leases, not five DONE rows. Infrastructure releases retain their job generation and are not counted as domain errors.
- Host retry delay now uses the greater of per-URL backoff and the host failure streak. Success continues to reset host failures. Retry-After remains a lower bound.
- Robots denials/unavailability, blocked targets and noindex contribute to domain yield. Repeated low-value or duplicate *recrawls* do not manufacture new-page circuit failures, and fetched pages remain eligible for refreshing during a domain cooldown.
- `/status` adds a source timestamp, full-domain and configured-family concentration for pending/DONE/useful samples, cumulative outcome and error-code counts by queue, previous-complete-hour fetch count and pages/minute, zero/low-yield backlog totals and bounded top lists, PUBLIC/DEMAND queue state and age summaries, and first-observed-failure retry-age buckets. Pre-upgrade retry ages are explicitly unknown. The expensive URL aggregation is cached for 60 seconds; concentration is cached for 15 seconds.
- All operational writes participate in the same SQLite transactions as their result/state changes. A crash/restart preserves cooldowns and counts; incomplete leases retain generations when requeued. URL deletion removes its retry-age record. Hour buckets retain at most the current hour plus 24 prior hours per queue.
- Core reports robots causes using existing optional `httpStatus`, `error` and `retryAfterSec` fields; its negative cache preserves those diagnostics. DNS remains FETCH_FAILED/DNS; SSRF refusal remains BLOCKED_TARGET; aborts propagate to node release/failure. Remote 5xx can be distinguished from CONNECT/TLS/TIMEOUT/RESET/DECODE/PROTOCOL. Invalid/unsupported encodings and redirect-policy failures remain conservative; there is no robots bypass. A robots 429 returns RATE_LIMITED without fetching the page.
- Core's roundup adapter forwards the exact operational and concentration summaries and the source timestamp, preserving existing snapshot schema 1 fields. The mirror workflow needs no change.

No query text, user identifiers, credentials or URL strings were added to operational summaries. Family names and domain names appear in the authenticated status endpoint, as concentration names already did; progress logging still strips domain names. No replication, repair or storage changes were made.

## Before/after measurements

The real Frontier and Crawler run on a deterministic fake clock for one hour, 1,800 single-slot opportunities, 2-second host delay, 3,000 URLs per domain, two healthy domains, and either one or eight persistently failing domains. Useful documents have unique hashes. No remote network is involved. Workload: `node dist/tests/sim/zero-yield.js`; raw data in `tests/sim/zero-yield-{before,after}.jsonl`.

| Bad domains / outcome | Wasted attempts before → after | Useful indexed documents before → after |
|---|---:|---:|
| 1 / ROBOTS_DISALLOWED | 724 → 13 | 1,076 → 1,787 |
| 8 / ROBOTS_DISALLOWED | 1,400 → 104 | 400 → 1,696 |
| 1 / ROBOTS_UNAVAILABLE | 60 → 6 | 1,740 → 1,794 |
| 8 / ROBOTS_UNAVAILABLE | 480 → 48 | 1,320 → 1,752 |

All four existing 600-fetch simulation outputs were **identical** before/after, including per-site counts, discovery order and demand/pipelined runs (`tests/sim/health-existing-{before,after}.jsonl`). These are synthetic capacity/yield improvements, not measured production improvements or judged search relevance.

Existing file-backed frontier benchmark at 100,000 rows: health aggregation **79.77 ms**, cached call **0.00 ms** rounded; domain/family concentration **3.04 ms**; lease p50 **4.18 ms**, p99 **19.20 ms**; completion **0.27 ms** average. One run on this environment, not a latency guarantee at production scale. Raw data: `tests/bench/health-100k.jsonl`; reproduce with `node dist/tests/bench/scale.js 100000`.

## Tests and changed files

New crawler tests cover eight large denied frontiers competing with healthy domains, rotating PUBLIC/DEMAND robots failures, demand retry exhaustion and re-promotion, serialized cooldown recovery, family concentration across many related hosts/domains, genuine versus unknown retry ages, thin-page refreshes, tightened discovery admission, rollback, restart and in-flight generation preservation.

Core tests cover robots 503/Retry-After and negative-cache replay, timeout, DNS, redirect policy, compressed-body decode failure, TLS diagnostics, robots 429, and roundup forwarding with old-source compatibility. The existing service integration test now cleans up its service even when an assertion fails.

| Repository | Files |
|---|---|
| PrivaSearch behavior | `src/db.ts`, `src/frontier.ts`, `src/driver.ts`, `src/server.ts` |
| PrivaSearch verification | `tests/crawl-health.test.ts`, `tests/api.test.ts`, `tests/service-e2e.test.ts`, `tests/sim/zero-yield.ts`, `tests/bench/scale.ts`, `tests/fixtures/loopback-port-remap.mjs`, five measurement JSONL files |
| Documentation | this report, `docs/crawling.md`, `docs/search-api.md`, `docs/crawl-quality.md` |
| Core support | `apps/node/src/fetch/handler.ts`, `apps/node/src/fetch/robots.ts`, `deploy/bin/privanet-roundup-api`, `tests/fetch-handler.test.ts`, `tests/roundup.test.ts`, `docs/CRAWLER_OBSERVABILITY.md` |

## Deployment, compatibility and remaining risks

Back up SQLite using the existing backup tool, then deploy PrivaSearch and restart it. The new tables/triggers are an idempotent **additive schema-4 extension**: user_version and existing state formats remain 4, all URL/index records are retained, old readers ignore the extension. Old writers do not update these new counters or enforce cooldowns; a rollback must therefore treat operational statistics as incomplete. Do not run old/new crawler processes on the same database concurrently.

Deploy the Core node changes to obtain detailed robots causes; older nodes continue to work but report UNKNOWN causes. No protocol schema or npm package bump is required. Deploy/restart the roundup adapter and ensure the dashboard forwards new `/status` fields. A source that strips them yields null summaries, not fabricated health. Verify both mirror generated_at and dashboard/source/cache timestamps after rollout.

For Wikimedia, configure `PRIVASEARCH_DOMAIN_FAMILIES=wikimedia=wikipedia.org,wikimedia.org,wiktionary.org,wikibooks.org,wikisource.org,wikinews.org,wikiquote.org,wikiversity.org,wikivoyage.org,wikidata.org,mediawiki.org`. Ownership is operator-supplied, never guessed. Unconfigured related owners will still look independent; configured families expose concentration and apply existing family budgets/concurrency, not equal family scheduling shares.

Eight-sample/64-URL thresholds are conservative defaults supported by these controlled workloads, not globally tuned values. Path-specific denials, duplicate-heavy legitimate sites, biased node failures and sparse pages can temporarily suppress useful new work; bounded recovery and demand priority mitigate this. Many previously unseen independent failing domains can still consume exploration before evidence exists. Fetched pages are not removed. Existing large backlogs require review with `frontier analyze` and `prune --dry-run`; nothing automatically deletes production URLs.

A true ranking-quality evaluation requires a judged query corpus. Current useful-yield, low-value, duplicate and concentration figures are defensible indexing proxies only. Robots parse errors in ordinary directive text are ignored by the bounded parser rather than producing ROBOTS_UNAVAILABLE; a challenge served as 200 text is a remaining policy limitation. Live network reachability, real deployed metadata propagation and post-deployment quality remain unverified. Passing tests does not establish bug freedom or security.

## Final validation and self-review

- PrivaSearch complete lint and typecheck: pass. Full test suite against current Core: **185 passed, 0 failed, 0 skipped**.
- Real-path compatibility against Core v0.3.0-alpha.5 (the release CI pins): **5 passed, 0 failed, 0 skipped**, covering crawler CLI, SDK credentials, demand/discovery/indexing, recrawl/restart and Coordinator crash recovery. Current Core real-path cases also passed within the full suite.
- Core complete lint and typecheck: pass. Full suite: **550 passed, 2 failed, 6 skipped** (558 total). Remaining failures are the panel's OS interface enumeration (`uv_interface_addresses` denied) and the storage-policy test's inspection of a spawned process under `/proc/<pid>/fd` (ENOENT in this runtime). Those code paths were not modified. Platform-specific skipped tests are explicitly reported; this is not a fully green Core run.
- Local port 80 binding is denied. The real-path runs use an explicitly imported **test-only** loopback port remap, available in `tests/fixtures/loopback-port-remap.mjs`; it maps only loopback port 80 to a high test port and leaves wire URLs, guarded resolution, authentication, SSRF checks and actual Coordinator/node processes intact. Normal hosts/CI should run without it. Example for this restricted runtime: `PRIVASEARCH_TEST_PORT=18089 NODE_OPTIONS="--import=$PWD/tests/fixtures/loopback-port-remap.mjs" PRIVANET_CORE_DIR=/absolute/path/to/Core PRIVASEARCH_REQUIRE_REAL_PATH=1 npm test`.
- Before/after workload files were compared; all four legacy simulation lines are identical. The zero-yield workload was rerun on the final behavior. Added tests cover transactional rollback and persistent cooldown/counters; existing schema-3 migrations, counter consistency, atomic indexing and privacy checks also passed.
- Diff review checked query/token exposure, static SQL, bounded result lists/hour retention, transaction boundaries, demand exemptions, politeness, admission exemptions, schema compatibility and snapshot freshness. No production settings/state or mirror workflow were changed. Remaining risks above still apply; passing tests is not a security proof.
