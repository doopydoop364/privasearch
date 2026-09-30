# PrivaSearch

An independent, self-hostable web search engine. PrivaSearch is a **separate application** that consumes [PrivaNet](https://github.com/doopydoop364/PrivaNet-Core): it never fetches pages itself. Every crawl is meant to go **PrivaSearch, PrivaNet SDK, Coordinator, authenticated PrivaNode, fetch capability, validated result**, even on a single machine. PrivaNet-Core contains no PrivaSearch code and this repository contains no PrivaNet internals.

## Status: milestone 1, not a working crawler yet

**Read this before assuming anything works.**

| Part | State |
| --- | --- |
| Frontier (SQLite): URL admission, per-host politeness, backoff, recrawl, both queues | Implemented and tested |
| Contract mirror and result validation (untrusted results, all 12 outcomes) | Implemented and tested |
| Crawl driver: lease, submit, validate, ingest, discover | Implemented and tested **against a test double** |
| Document store, FTS5 index, ranking, duplicate handling, noindex | Implemented and tested |
| Search API (`GET /search?q=`, JSON only) | Implemented and tested; no UI |
| **Real crawling through PrivaNet** | **Not possible yet.** See below |
| Parsing beyond PrivaNet's digest, ranking beyond BM25, metasearch, UI | Not started |

**Why crawling is not real yet.** The `web.fetch.v1` capability (provisional id) does not exist in PrivaNet-Core: its registry has only two diagnostic job types, so a Coordinator would reject the job type. The architecture decision on where such capabilities live (ADR 005 in PrivaNet-Core) is still *proposed*. Separately, `@privanet/sdk` is not published anywhere this repository can install it from. So all crawling here runs through `FakeTransport`, a test double that returns canned results and **never touches the network**. Nothing here has crawled a real page, and the 1,000 / 10,000 / 100,000 page milestones cannot start until the PrivaNet side ships.

## How it fits together

```text
frontier (what, when, how politely)  ->  Crawler  ->  FetchTransport  ->  [PrivaNet path]
      ^                                    |               (real: @privanet/sdk; today: FakeTransport)
      |                                    v
  discovered links  <-  validated result  ->  DocumentStore + FTS5  ->  search API
```

- `src/privanet/fetch-contract.ts`: Zod mirror of the fetch capability contract, pinned to the PrivaNet-Core commit it was copied from, with the capability id in one constant.
- `src/privanet/transport.ts`: the single port to PrivaNet. The result type is `unknown` on purpose.
- `src/privanet/fake-transport.ts`: test double only.
- `src/url.ts`, `src/frontier.ts`, `src/driver.ts`, `src/documents.ts`, `src/server.ts`.

Details: [docs/architecture.md](docs/architecture.md), [docs/integration.md](docs/integration.md).

## Security posture

- Results come from untrusted nodes. Every result is schema-validated and cross-checked (requested URL, final host, outcome-specific fields) before use; an invalid result is a failed attempt and nothing in it is stored or followed.
- Page text is data. It is stored and returned verbatim, never interpreted. Search input is reduced to quoted terms. API consumers must escape hit text before rendering it.
- No user identifiers or queries enter any job, and nothing is logged per query.
- The frontier is the primary politeness limiter; PrivaNet's node limits are defence in depth.
- No independent security review has been done. Passing tests is not a security claim.

## Development

Node **24.4+**.

```bash
npm ci
npm run build
npm test
npm run lint
npm run typecheck
```

`npm run serve` serves the search API over an existing database (`PRIVASEARCH_DB`, default `./var/privasearch.sqlite`, on `127.0.0.1:4020`). It cannot crawl.
