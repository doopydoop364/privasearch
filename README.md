# PrivaSearch

An independent, self-hostable web search engine. PrivaSearch is a **separate application** that consumes [PrivaNet](https://github.com/doopydoop364/PrivaNet-Core): it never fetches pages itself. Every crawl is meant to go **PrivaSearch, PrivaNet SDK, Coordinator, authenticated PrivaNode, fetch capability, validated result**, even on a single machine. PrivaNet-Core contains no PrivaSearch code and this repository contains no PrivaNet internals.

## What it does (0.4.0)

PrivaSearch is a continuously operating search engine. One long-running service serves a search API, crawls in the background without being asked, and, when a search finds too little, schedules related crawling and improves its answer as pages arrive. A user reaches it through [PrivaProxy](https://github.com/doopydoop364/privaproxy): choose "PrivaSearch" in its search-engine dropdown.

```text
PrivaProxy ──> search API ──> ranked results now, from the index as it is
                   │
                   └─ results thin? ──> demand planner ──> frontier (DEMAND, high priority)
seeds, discovered links, recrawls ───────────────────────> frontier (PUBLIC)
                                                              │
        crawler ──> PrivaNetTransport ──> @privanet/sdk ──> Coordinator ──> PrivaNode (web.fetch.v1)
           │
           └─ validate ─> parse ─> index (FTS5) + link graph ─> back into the frontier and the next search
```

| Part | State |
| --- | --- |
| Persistent index (SQLite + FTS5): URL, canonical URL, title, description, text, hashes, fetch and change times, link graph; migrates older databases in place | Implemented and tested |
| Search API with ranking, pagination, relevance signals, index and crawl state, optional bearer token ([docs/search-api.md](docs/search-api.md)) | Implemented and tested |
| Ranking: relevance, title, address, description, exact phrase, term coverage, freshness, inbound-host links, variant suppression, host diversity ([docs/ranking.md](docs/ranking.md)) | Implemented and tested; weights not tuned on a judged query set |
| Demand crawling: a documented "weak results" rule, cooldowns that double while a query stays weak, queue and hourly limits, query-to-URL discovery ([docs/crawling.md](docs/crawling.md)) | Implemented and tested, including against a real Coordinator and node |
| Background crawler: persistent frontier, per-host politeness, `Retry-After`, backoff, depth and priority, crawl-trap guard, per-host budget | Implemented and tested |
| Adaptive recrawl from content-hash changes, `304`s and link importance; rare retries of failed URLs | Implemented and tested |
| Long-running service: graceful shutdown, restart persistence, outage recovery, search-only mode, systemd unit ([docs/deployment.md](docs/deployment.md)) | Implemented and tested |
| Crawl quality and diversity (unreleased, schema v4): registrable-domain model, weighted fair scheduling across domains, pending budgets, link fanout, language policy, soft-404 and trap detection, frontier-cli (analyze, explain, prune, backup), optional query provider and `/sitemap.txt` (both off by default) | Implemented and tested on a synthetic web and at 10k/100k pending URLs ([docs/crawl-quality.md](docs/crawl-quality.md)); not measured on a live database |
| Real path: SDK, Coordinator, authenticated PrivaNode, `web.fetch.v1`, index, search hit, recrawl | Proven end to end against a **local test site** (`tests/service-e2e.test.ts`, needs a PrivaNet-Core checkout); one public URL is proven in CI |
| Crawling the public web at scale, third-party nodes, anchor text, XML sitemaps and feeds (blocked by the `web.fetch.v1` contract), JavaScript rendering, distributed storage | Not done ([docs/crawling.md](docs/crawling.md#limitations-known-not-hidden)) |

PrivaSearch makes **no HTTP request to a crawled URL itself**, and no request to a search provider. The only way out is `PrivaNetTransport`; there is no shortcut for a node on the same machine. `FakeTransport` is the unit-test double and never touches the network. The fetch contract is imported from `@privanet/protocol`; there is no local copy. Nothing has crawled the public web at scale: the measurements in [docs/measurements.md](docs/measurements.md) are against local test sites.

Code map (`src/`): `service.ts` (the process), `server.ts` (API), `ranking.ts`, `demand.ts` and `discovery.ts` (demand crawling), `frontier.ts` and `policy.ts` (what to crawl, when, how politely), `driver.ts` (the crawler), `documents.ts` and `db.ts` (index, link graph, schema and migration), `url.ts` (admission), `privanet/` (the transport port). Design notes: [docs/architecture.md](docs/architecture.md), [docs/phase3-audit.md](docs/phase3-audit.md), [docs/integration.md](docs/integration.md).

## Security posture

- Results come from untrusted nodes. Every result is schema-validated and cross-checked (requested URL, final host, outcome-specific fields) before use; an invalid result is a failed attempt and nothing in it is stored or followed.
- Page text is data. It is stored and returned verbatim, never interpreted. Search input is reduced to quoted terms. API consumers must escape hit text before rendering it.
- No user identifiers or queries enter any job, and nothing is logged per query. The demand ledger keeps only a salted hash of each normalised query, never its text.
- The frontier is the primary politeness limiter; PrivaNet's node limits are defence in depth. Crawl traps and a per-host budget bound what a hostile site can make the crawler queue.
- The search API binds to loopback by default and requires a bearer token when it does not; PrivaNet credentials never leave the process.
- No independent security review has been done. Passing tests is not a security claim.

## License

PrivaSearch is licensed under the [Apache License, Version 2.0](LICENSE) (`Apache-2.0`). This covers the code in this repository. Third-party dependencies, including the `@privanet/*` packages and their own dependencies, keep their own licenses; nothing here relicenses them.

## Development

Node **24.4+**. `@privanet/protocol` and `@privanet/sdk` are plain, exact-version dependencies from the public npm registry (`@privanet/shared` comes in through the SDK; PrivaSearch does not import it). The real-path tests and the crawl scripts also need a PrivaNet-Core Coordinator and PrivaNode, which are release archives and not npm packages: set `PRIVANET_CORE_DIR` to a built PrivaNet-Core checkout (see PrivaNet-Core `docs/PACKAGES.md`).

```bash
npm ci
npm run build
npm test
npm run lint
npm run typecheck
```

`npm start` (or `node dist/main.js` from a release archive) runs the whole service; see [docs/deployment.md](docs/deployment.md) for settings, the systemd unit and PrivaProxy configuration. With no PrivaNet settings it is search-only. A minimal local run against a Coordinator and a node that offers `web.fetch.v1`:

```bash
export PRIVANET_COORDINATOR_URL=https://coordinator.example
export PRIVANET_DEMAND_TOKEN=<64 hex>   # never on the command line
export PRIVANET_PUBLIC_TOKEN=<64 hex>   # a different credential
export PRIVASEARCH_SEEDS=./seeds.txt    # one URL per line, # comments
export PRIVASEARCH_DISCOVERY_TEMPLATES='https://en.wikipedia.org/wiki/{title}'
npm start
curl 'http://127.0.0.1:4020/search?q=alpine+hiking'
```

`npm run serve` is the same service (without PrivaNet settings it only serves the index, as before). `npm run crawl` is the older crawl-only command (frontier, crawler and transport, no API); it uses the same database and remains for compatibility.

The real-path tests need a built PrivaNet-Core checkout and permission to listen on `127.0.0.1:80` (PrivaSearch crawls default ports only); without them they are skipped:

```bash
git clone --branch v0.3.0-alpha.5 https://github.com/doopydoop364/PrivaNet-Core ../PrivaNet-Core && (cd ../PrivaNet-Core && npm ci && npm run build)
export PRIVANET_CORE_DIR=$PWD/../PrivaNet-Core
npm test                                        # includes the end-to-end path
node dist/tests/scale-crawl.js 100              # measured crawl of a synthetic local site
node dist/tests/live-url.js https://example.com/ example   # one public URL, node SSRF policy unrelaxed
```
