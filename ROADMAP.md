# PrivaSearch roadmap

Status terms: **Done**, **In progress**, **Next**, **Planned**.

1. **Milestone 1: pipeline against a test double.** Done.
2. **Milestone 2: real PrivaNet path.** Done locally: `@privanet` packages consumed, contract mirror removed, `PrivaNetTransport`, end-to-end test through a real Coordinator and PrivaNode. In progress: the public-URL proof (CI `live-public-url`).
3. **Measured milestones.** In progress: 10, 100 and 1,000 pages measured on a synthetic local site ([docs/measurements.md](docs/measurements.md)). Next: the same against real public sites, then 10,000 and 100,000, with the PrivaNet changes the measurements justify (SDK polling cost first).
4. **Crawl quality.** Planned: robots caching for scheduling, sitemaps, crawl-trap and near-duplicate handling, language handling, recrawl tuning.
5. **Search quality.** Planned: ranking beyond BM25, snippets, a UI.
6. **Metasearch fallback.** Planned, after the index proves itself.
7. **Third-party nodes.** Planned: sampled redundant crawls and node disagreement tracking before trusting any node we do not run.
