# PrivaSearch roadmap

Status terms: **Done**, **In progress**, **Next**, **Planned**.

1. **Milestone 1: pipeline against a test double.** Done.
2. **Milestone 2: real PrivaNet path.** Done locally: `@privanet` packages consumed, contract mirror removed, `PrivaNetTransport`, end-to-end test through a real Coordinator and PrivaNode. In progress: the public-URL proof (CI `live-public-url`).
3. **Measured milestones.** In progress: 10, 100 and 1,000 pages measured on a synthetic local site ([docs/measurements.md](docs/measurements.md)). Measurement already found and fixed one Core bottleneck (a node poll loop capped at one job per poll interval, about 17 times on default settings). Since then a continuous crawl pipeline (about 4,300 pages per minute on the synthetic site at 128 in flight). Measurement has since led to three Core changes (node poll loop, lease that waits for work, job reads that wait for the result). Multi-slot nodes followed (one process, 16 slots: 2,103 pages/min at 200 ms latency, 10 times less memory than 16 processes). Next: real public sites and a measured 10,000-page crawl, then 100,000.
4. **Continuous operation (0.4.0).** Done locally: one long-running service (search API, background crawler, demand crawling), a persistent index with a link graph, first-generation ranking, adaptive recrawl, crawl-trap and per-host limits, restart and outage recovery, a systemd unit, and a search-engine option in PrivaProxy. Proven end to end against a real Coordinator and node on a local test site; not yet run against the public web at scale ([docs/crawling.md](docs/crawling.md#limitations-known-not-hidden)).
5. **Crawl quality.** Planned: robots caching for scheduling, sitemaps, near-duplicate and language handling, per-site rules, smarter trap detection, anchor-text (needs a generic Core capability first).
6. **Search quality.** Planned: ranking tuned on judged queries, link propagation, query understanding (stemming, synonyms, spelling), result freshness policy, a verified ranking test corpus.
7. **Metasearch fallback.** Planned, after the index proves itself (and only as discovery or fallback, never as the permanent source of ranked results).
8. **Third-party nodes.** Planned: sampled redundant crawls and node disagreement tracking before trusting any node we do not run.
9. **Scale.** Planned, with Core's storage phases: an index and frontier that outgrow one process and one SQLite file.
