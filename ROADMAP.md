# PrivaSearch roadmap

Status terms: **Done**, **Next**, **Blocked** (needs PrivaNet work), **Planned**.

1. **Milestone 1: pipeline against a test double.** Done: contract mirror, URL policy, frontier, driver, document store, FTS5 index, search API.
2. **Milestone 2: real path.** Blocked on PrivaNet: the fetch capability and an installable SDK. Then: the real transport adapter, one local PrivaNode, a first real crawl.
3. **Measured milestones.** Planned, on one local node: 1,000, then 10,000, then 100,000 pages, reporting throughput, error rates and what PrivaNet should change.
4. **Crawl quality.** Planned: robots caching for scheduling, sitemaps, crawl-trap and near-duplicate handling, language handling, recrawl tuning.
5. **Search quality.** Planned: ranking beyond BM25, snippets, a UI.
6. **Metasearch fallback.** Planned, after the index proves itself.
7. **Third-party nodes.** Planned: sampled redundant crawls and node disagreement tracking before trusting any node we do not run.
