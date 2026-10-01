# Changelog

## [Unreleased]

### Changed
- **`@privanet/*` now come from public npm.** `package.json` depends on `@privanet/protocol` and `@privanet/sdk` at the exact version `0.3.0-alpha.5` instead of PrivaNet-Core release-asset URLs, and `package-lock.json` is regenerated from the registry. `@privanet/shared` is no longer a direct dependency: PrivaSearch never imported it, and it is installed transitively through the SDK at the same version.
- CI and the release workflow no longer rely on the release-asset URLs. They still check out PrivaNet-Core `v0.3.0-alpha.5` and build it, because the real-path tests and the measured crawl need a genuine Coordinator and PrivaNode (release archives, not npm packages); `PRIVANET_CORE_DIR` still points the tests at any local checkout.
- No version bump: PrivaSearch is not published to npm, and the `0.3.2` archive keeps working. The next release carries this.

### Added
- `tests/dependencies.test.ts`: an offline guard that the `@privanet` dependencies are exact registry versions, that `@privanet/shared` is only transitive, and that the lockfile resolves all three from `registry.npmjs.org` at one matching version with no release-asset URL or `file:` link.

## [Unreleased]

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
