# Changelog

## [Unreleased]

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
