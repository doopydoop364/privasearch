# Changelog

## [Unreleased]

### Fixed
- **The demand-crawl query ledger grew without bound.** Every distinct search ever made (as a salted hash) stayed in the `queries` table for good. The service now forgets entries not seen for 90 days (and keeps at most 500,000, dropping the least recently seen) at start and once a day, and logs only how many it dropped. A forgotten query is treated as new the next time it is searched.

### Changed
- **Per-search cost no longer scales with the whole index and ledger** (30,000 pages of 10 KiB, 200,000 ledger rows, file-backed): `/health` and every search's page counts 24 ms to 0.9 ms (a duplicate count read every page's text; now a partial index), the demand planner's "queries that scheduled crawling this hour" 15 ms to 0.03 ms (index) and its demand-backlog check 12.7 ms to 0.05 ms (it computed all operator counters), and the candidate query ranks the best 300 full-text rows by bm25 before joining them to their pages (203 ms to 110 ms for a word in every page; a search 350 ms to about 170-200 ms). Results and order are unchanged (tested against the old query).

### Fixed
- **A fetched URL was marked done before its page was stored.** The crawler recorded the result in the frontier and then indexed the page in separate steps. A storage failure (disk full, a locked database) between them left the URL "fresh until next recrawl" with nothing indexed, a later `304` would never repair it, and the exception escaped the crawl loop. The URL's new state and its page (document, index row, link graph, discovered links) are now stored in one transaction; on failure nothing of the result is kept, the URL counts a failed attempt with backoff (`INGEST_FAILED`) and the crawler carries on.
- **Ingest cost grew with the size of the index.** A page's full-text row was found with `DELETE FROM docs_fts WHERE url_key=?`, but `url_key` is an UNINDEXED FTS5 column, so every ingested page scanned every stored page: loading 2,000 / 4,000 / 8,000 pages took 3.9 / 11.5 / 45 s (quadratic), and the scan blocked the process (search included) while it ran. The row is now addressed by rowid through a new `docs_index` table (schema version 3, migrated in place; a stale duplicate row left by an old database is dropped): 8,000 pages load in 5.6 s and 50,000 in 45 s, linearly.
- **A page's row, its full-text row and its duplicate bookkeeping were written as separate autocommit statements.** `upsert` and `remove` are now atomic (a savepoint when the caller already holds a transaction), so a failure or a crash can no longer leave a stored page that is not searchable.

## [0.4.0] - 2026-10-01

PrivaSearch becomes a continuously operating search engine. Core is unchanged: this release consumes `@privanet/*` `0.3.0-alpha.5` (and works against PrivaNet-Core `v0.3.0-alpha.5` and `alpha.6`). Details and the audit that preceded it: [docs/phase3-audit.md](docs/phase3-audit.md).

### Added
- **A long-running service** (`npm start`, `node dist/main.js`): the search API, a supervised background crawler and demand crawling in one process over one database; seeds added at start, leases from the previous process returned, graceful shutdown with a deadline, search-only mode when no PrivaNet settings are present, settings errors reported by name with exit status 78. `deploy/`: a hardened systemd unit, an environment template without secrets and an example seed list; shipped in the release archive, whose smoke test now starts the service. See [docs/deployment.md](docs/deployment.md).
- **Demand crawling.** A search for which the index has fewer than three strong results schedules related crawling at demand priority without waiting for it. Cooldown (30 minutes, doubling while a query stays weak, at most 24 hours), a queue limit and an hourly limit prevent crawl storms. Query-to-URL discovery from the frontier, the link graph and operator-configured URL templates; no search-provider client, every fetch through `web.fetch.v1`. A query is stored only as a salted hash. See [docs/crawling.md](docs/crawling.md).
- **Search API 1.** `GET /search` with `limit`/`offset`, relevance signals per hit, `index` and `crawl` state; `GET /status`; optional bearer token (`PRIVASEARCH_API_TOKEN`, required off loopback). See [docs/search-api.md](docs/search-api.md).
- **Ranking.** Relevance, title, address, description, exact phrase, term coverage (partial matches fill out thin results), freshness, inbound-host link authority, canonical and URL-variant suppression, host diversity; deterministic. See [docs/ranking.md](docs/ranking.md).
- **Persistent index additions.** A link graph, canonical-URL deduplication, change tracking (first seen, last changed, change count), `src/db.ts` with in-place migration of 0.3.2 databases (`user_version` 2).
- **Adaptive recrawl.** Per-URL intervals: halved when the content hash changed, doubled when unchanged or `304` (up to 60 days, 14 for pages many hosts link to); a reserved share (25 %) of every lease goes to due recrawls.
- **Crawl-trap guard and per-host budget** for discovered links (calendars, session and filter parameters, repeating paths, deep pagination; 2,000 discovered URLs per host); discovery priority by depth.
- Tests: restart persistence, migration, ranking signals, demand heuristics and storm protection, API shape and auth, recrawl, traps, rate limits, robots, outage recovery, hard-stop shutdown, deploy files, and the whole loop against a real Coordinator and PrivaNode (`tests/service-e2e.test.ts`).
- `tests/dependencies.test.ts`: an offline guard that the `@privanet` dependencies are exact registry versions, that `@privanet/shared` is only transitive, and that the lockfile resolves all three from `registry.npmjs.org` at one matching version with no release-asset URL or `file:` link.

### Changed
- **`@privanet/*` now come from public npm.** `package.json` depends on `@privanet/protocol` and `@privanet/sdk` at the exact version `0.3.0-alpha.5` instead of PrivaNet-Core release-asset URLs, and `package-lock.json` is regenerated from the registry. `@privanet/shared` is no longer a direct dependency: PrivaSearch never imported it, and it is installed transitively through the SDK at the same version.
- CI and the release workflow no longer rely on the release-asset URLs. They still check out PrivaNet-Core `v0.3.0-alpha.5` and build it, because the real-path tests and the measured crawl need a genuine Coordinator and PrivaNode (release archives, not npm packages); `PRIVANET_CORE_DIR` still points the tests at any local checkout.
- `src/main.ts` is now the service (it was an API-only entry point); without PrivaNet settings it behaves as before. `npm run serve` still points at it.
- A URL that exhausted its attempts (`FAILED`) is retried after 30 days and after everything else, instead of never. A URL asked for by demand while it is waiting out a failure backoff is not made due early. A recrawl uses the public credential even for a URL first queued as demand.
- The upsert result reports `changed` and `firstSeen`; removing a page promotes a duplicate of it; `count()` is unchanged (`linkCount()` is new).
- Tests run one file at a time (`--test-concurrency=1`): two of them need port 80.

## [0.3.2] - 2026-09-30

Consumes PrivaNet-Core v0.3.0-alpha.5 and fixes a stall found by running PrivaSearch on a desktop against a server Coordinator.

### Fixed
- **A short PrivaNet outage stalled the crawl for a flat minute.** After a transport failure the driver made every affected URL wait 60 s, so a six-second Coordinator restart cost about 54 s before the next page. It now uses a pipeline-level backoff: the first failure opens a one-second window shared by every URL that fails inside it, each further failure doubles the next window (up to `infrastructureRetryMs`, 60 s), leasing pauses while a window is open, and one answer from PrivaNet resets it. Resubmissions still reuse the idempotency key. Measured: first page 1.0 s after the Coordinator was back (was 54 s); without the pause a dead Coordinator was hit with 180 submissions in 350 ms, with it at most 12. New option `infrastructureBackoffBaseMs`.

### Changed
- The `@privanet/*` packages and the Core release used by CI and the release workflow move to `v0.3.0-alpha.5` (the SDK's `waitForResult` now survives a Coordinator restart on its own).

### Added
- `tests/lan-crawl.mjs` and measurement experiment 9: PrivaSearch on a desktop host, a server Coordinator behind TLS, and a Coordinator restart, using PrivaNet-Core's network-namespace rig.

## [0.3.1] - 2026-09-30

Consumes PrivaNet-Core v0.3.0-alpha.4 (Coordinator, PrivaNode and the `@privanet/*` packages) and adds a multi-node measurement. No PrivaSearch behaviour change.

### Changed
- The `@privanet/*` packages and the Core release used by CI and the release workflow move to `v0.3.0-alpha.4`, which fixes a Coordinator cost that grew with the number of waiting node lanes. CI runs the real-path and public-URL jobs against it.

### Added
- Measurement experiment 8 in `docs/measurements.md`: four nodes with 16 slots each crawled 3,000 pages at 6,778 pages per minute against 2,303 for one node, with no invalid results and no transport errors (synthetic site, one machine, single run).

## [0.3.0] - 2026-09-30

The crawler is now usable and measured. Requires PrivaNet-Core v0.3.0-alpha.3 (Coordinator and PrivaNode) and consumes its `@privanet/*` packages from that release's assets.

### Added
- Measurement experiment 7 (multi-slot nodes) and the `SCALE_SLOTS` knob; the rig raises its node memory ceiling so slot experiments are not memory bound.
- Measurement experiments 4 to 6 in `docs/measurements.md` (lease that waits for work, one-slot node under simulated network latency, job reads that wait for the result) and `scale-crawl` knobs `SCALE_NODES` (several node processes) and `SCALE_SITE_DELAY_MS` (per-request site latency). The rig can start several PrivaNodes.
- `npm run crawl`: the crawl command. Wires the real `PrivaNetTransport` and `Crawler.run` to a SQLite database from environment configuration (validated, credentials only from the environment, distinct queue credentials required), seeds from arguments or a file, aggregate-only logs, clean stop on SIGINT or SIGTERM. Tested as a real process against a real Coordinator and PrivaNode.
- `Crawler.run()`: a continuous pipeline that keeps up to `concurrency` crawls in flight and refills a slot the moment one frees, honours an abort signal and finishes what it already submitted. Measured against the batch driver on the real path: 1,281 to 3,404 pages per minute at 32 in flight. The frontier still allows one in-flight URL per host. `runOnce()` stays for tests and one-shot use.

### Added
- Measurement experiments (`docs/measurements.md`): SDK polling interval and the node poll loop, which found a Core throughput bug (59 to 1,018 pages per minute on default settings once fixed in PrivaNet-Core). `scale-crawl` accepts `SCALE_POLL_MS`, `SCALE_NODE_POLL_MS`, `SCALE_BATCH`, `SCALE_HOST_DELAY_MS`.

## [0.2.1] - 2026-09-30

Licensing release. No behaviour change.

### Added
- **License: Apache-2.0.** The standard `LICENSE` file and `"license": "Apache-2.0"` in `package.json`; the license text ships in the release distribution. Third-party dependencies keep their own licenses; nothing is relicensed.
- A test that keeps the license file, the package field and the README statement consistent.

### Changed
- The `@privanet/*` packages now come from the PrivaNet-Core `v0.3.0-alpha.2` release assets (the first release that carries the Apache-2.0 license text), and CI and the release workflow validate against that Core release. The switch to the public npm registry follows once the packages are published there.

## [0.2.0] - 2026-09-30

Milestone 2: the real PrivaNet path. Requires PrivaNet-Core v0.3.0-alpha.1 (Coordinator and PrivaNode) and consumes its `@privanet/*` packages from the release assets. Milestone 1 (pipeline against a test double) is included.

### Added
- Milestone 1: contract mirror of the PrivaNet fetch capability (pinned to PrivaNet-Core `ffc35e3`), URL admission and normalisation, SQLite frontier with per-host politeness, backoff, recrawl and two queues, crawl driver with result validation and cross-checks, document store with FTS5 index, duplicate handling and noindex, a minimal search API, and a test double for the PrivaNet path.
- CI on Linux, macOS and Windows with Node 24 and 26.
- Milestone 2: the real PrivaNet path. `@privanet/protocol`, `@privanet/shared` and `@privanet/sdk` are consumed (from the PrivaNet-Core `v0.3.0-alpha.1` release assets); the contract mirror is removed and the schemas are imported. `PrivaNetTransport` (credential per queue, idempotent resubmission, error translation). Black-box rig and end-to-end test through a real Coordinator and PrivaNode, a measured-crawl script, a one-URL live script, and CI jobs for both.

### Changed
- The `@privanet/*` packages and the Core release used by CI and the release workflow move to `v0.3.0-alpha.3`, so PrivaSearch's job waits (one request per job instead of a poll every interval) and the Core throughput fixes it was measured against are what it runs on.
- `src/privanet/fetch-contract.ts` is replaced by `src/privanet/contract.ts`; `IDEMPOTENCY_KEY` is replaced by `isValidIdempotencyKey`, decided by PrivaNet's own submit schema.

### Not included
- Public-web crawling at scale. The 1,000-page measurement is a local, synthetic, single-node run.
