# Changelog

## [Unreleased]

### Added
- Measurement experiment 7 (multi-slot nodes) and the `SCALE_SLOTS` knob; the rig raises its node memory ceiling so slot experiments are not memory bound.
- Measurement experiments 4 to 6 in `docs/measurements.md` (lease that waits for work, one-slot node under simulated network latency, job reads that wait for the result) and `scale-crawl` knobs `SCALE_NODES` (several node processes) and `SCALE_SITE_DELAY_MS` (per-request site latency). The rig can start several PrivaNodes.

### Added
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
- `src/privanet/fetch-contract.ts` is replaced by `src/privanet/contract.ts`; `IDEMPOTENCY_KEY` is replaced by `isValidIdempotencyKey`, decided by PrivaNet's own submit schema.

### Not included
- Public-web crawling at scale. The 1,000-page measurement is a local, synthetic, single-node run.
