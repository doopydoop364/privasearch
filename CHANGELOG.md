# Changelog

## [Unreleased]

### Added
- Milestone 1: contract mirror of the PrivaNet fetch capability (pinned to PrivaNet-Core `ffc35e3`), URL admission and normalisation, SQLite frontier with per-host politeness, backoff, recrawl and two queues, crawl driver with result validation and cross-checks, document store with FTS5 index, duplicate handling and noindex, a minimal search API, and a test double for the PrivaNet path.
- CI on Linux, macOS and Windows with Node 24 and 26.

### Not included
- Real crawling: the PrivaNet capability and an installable SDK do not exist yet. No page has been crawled.
