# Fixtures

`privasearch-0.4.1-schema3.sqlite.gz` is a real database written by PrivaSearch 0.4.1 (schema version 3, commit `050b770`): 14 crawl passes over the synthetic web in
`tests/sim/web.ts` with one demand-crawl search, so it holds a wiki-dominated frontier (about 4,200 URLs), 105 indexed pages, the link graph, the full-text index and
the query ledger. It was produced by running that parent commit's own `Frontier`, `Crawler`, `DemandPlanner` and `Searcher` (a git worktree of `050b770`), never by
hand, so the migration tests start from exactly the production schema. Tests gunzip it into a temporary directory; the fixture itself is never opened in place.
