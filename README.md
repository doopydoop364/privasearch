# PrivaSearch

An independent, self-hostable web search engine. PrivaSearch is a **separate application** that consumes [PrivaNet](https://github.com/doopydoop364/PrivaNet-Core): it never fetches pages itself. Every crawl is meant to go **PrivaSearch, PrivaNet SDK, Coordinator, authenticated PrivaNode, fetch capability, validated result**, even on a single machine. PrivaNet-Core contains no PrivaSearch code and this repository contains no PrivaNet internals.

## Status: milestone 2, the real PrivaNet path works

**Read this before assuming anything works beyond what is listed.**

| Part | State |
| --- | --- |
| Frontier (SQLite): URL admission, per-host politeness, backoff, recrawl, both queues | Implemented and tested |
| Result validation against the schemas from `@privanet/protocol` (untrusted results, all 12 outcomes) | Implemented and tested |
| Crawl driver: lease, submit, validate, ingest, discover | Implemented and tested against the test double **and** the real path |
| `PrivaNetTransport` (`@privanet/sdk`): credential per queue, idempotent resubmission, error translation | Implemented and tested |
| Real path: SDK, Coordinator, authenticated PrivaNode, `web.fetch.v1`, validated result, index, search hit | Proven end to end against a **local test site** (`tests/core-e2e.test.ts`, needs a PrivaNet-Core checkout); public-URL proof runs in CI (`live-public-url` job) |
| Measured crawl on a synthetic local site: 10, 100, 1,000 pages | Measured once, see [docs/measurements.md](docs/measurements.md). Not the public web, not 10,000 |
| Document store, FTS5 index, ranking (BM25), duplicate handling, noindex | Implemented and tested |
| Search API (`GET /search?q=`, JSON only) | Implemented and tested; no UI |
| `npm run crawl`: continuous pipeline through PrivaNet from seeds, clean stop | Implemented and tested end to end against a real Coordinator and node |
| Parsing beyond PrivaNet's digest, ranking beyond BM25, metasearch, UI, third-party nodes | Not started |

PrivaSearch makes **no HTTP request to a crawled URL itself**. The only way out is `PrivaNetTransport`; `FakeTransport` is the test double and never touches the network. The fetch contract is imported from `@privanet/protocol`; there is no local copy.

Nothing has crawled the public web at scale. The 1,000-page figure is a local, synthetic, single-node measurement that relaxes the node's SSRF policy for the test host only (a node-owner setting that exists solely for local testing).

## How it fits together

```text
frontier (what, when, how politely)  ->  Crawler  ->  FetchTransport  ->  [PrivaNet path]
      ^                                    |               (PrivaNetTransport via @privanet/sdk; FakeTransport in unit tests)
      |                                    v
  discovered links  <-  validated result  ->  DocumentStore + FTS5  ->  search API
```

- `src/privanet/contract.ts`: re-exports the authoritative schemas from `@privanet/protocol` and holds the capability id in one constant. No copy of the contract.
- `src/privanet/privanet-transport.ts`: the real transport over `@privanet/sdk`.
- `src/privanet/transport.ts`: the single port to PrivaNet. The result type is `unknown` on purpose.
- `src/privanet/fake-transport.ts`: test double only.
- `tests/core-rig.ts`, `tests/core-e2e.test.ts`, `tests/scale-crawl.ts`, `tests/live-url.ts`: a black-box rig that runs a real Coordinator and PrivaNode from a PrivaNet-Core checkout.
- `src/url.ts`, `src/frontier.ts`, `src/driver.ts`, `src/documents.ts`, `src/server.ts`.

Details: [docs/architecture.md](docs/architecture.md), [docs/integration.md](docs/integration.md).

## Security posture

- Results come from untrusted nodes. Every result is schema-validated and cross-checked (requested URL, final host, outcome-specific fields) before use; an invalid result is a failed attempt and nothing in it is stored or followed.
- Page text is data. It is stored and returned verbatim, never interpreted. Search input is reduced to quoted terms. API consumers must escape hit text before rendering it.
- No user identifiers or queries enter any job, and nothing is logged per query.
- The frontier is the primary politeness limiter; PrivaNet's node limits are defence in depth.
- No independent security review has been done. Passing tests is not a security claim.

## License

PrivaSearch is licensed under the [Apache License, Version 2.0](LICENSE) (`Apache-2.0`). This covers the code in this repository. Third-party dependencies, including the `@privanet/*` packages and their own dependencies, keep their own licenses; nothing here relicenses them.

## Development

Node **24.4+**. The PrivaNet packages are installed from the PrivaNet-Core `v0.3.0-alpha.4` release assets (a temporary bridge until they are published to the npm registry; see PrivaNet-Core `docs/PACKAGES.md`).

```bash
npm ci
npm run build
npm test
npm run lint
npm run typecheck
```

`npm run serve` serves the search API over an existing database (`PRIVASEARCH_DB`, default `./var/privasearch.sqlite`, on `127.0.0.1:4020`). It does not crawl.

`npm run crawl` crawls through PrivaNet until stopped (SIGINT or SIGTERM), writing to the same database. It needs a running PrivaNet Coordinator with at least one PrivaNode that offers `web.fetch.v1`, and two application credentials issued by the PrivaNet administrator (one per queue, each with a registered fetch identity):

```bash
export PRIVANET_COORDINATOR_URL=https://coordinator.example
export PRIVANET_DEMAND_TOKEN=<64 hex>   # never on the command line
export PRIVANET_PUBLIC_TOKEN=<64 hex>   # a different credential
export PRIVASEARCH_SEEDS=./seeds.txt    # optional: one URL per line, # comments; URLs may also be arguments
npm run crawl -- https://example.com/
```

Options (environment): `PRIVASEARCH_DB`, `PRIVASEARCH_CONCURRENCY` (default 32, at most one URL per host is ever in flight), `PRIVASEARCH_SEED_QUEUE` (`PUBLIC` default, or `DEMAND`), `PRIVASEARCH_WAIT_TIMEOUT_MS`, `PRIVASEARCH_POLL_MS`, `PRIVASEARCH_ALLOW_INSECURE_LOOPBACK=true` (development only). Logs are aggregate counts: no URL, query or credential is written.

The real-path tests need a built PrivaNet-Core checkout and permission to listen on `127.0.0.1:80` (PrivaSearch crawls default ports only); without them they are skipped:

```bash
git clone --branch v0.3.0-alpha.4 https://github.com/doopydoop364/PrivaNet-Core ../PrivaNet-Core && (cd ../PrivaNet-Core && npm ci && npm run build)
export PRIVANET_CORE_DIR=$PWD/../PrivaNet-Core
npm test                                        # includes the end-to-end path
node dist/tests/scale-crawl.js 100              # measured crawl of a synthetic local site
node dist/tests/live-url.js https://example.com/ example   # one public URL, node SSRF policy unrelaxed
```
