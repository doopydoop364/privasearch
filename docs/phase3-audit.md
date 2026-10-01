# Phase 3 audit: what PrivaSearch 0.3.2 had, and the gaps

This audit was written before the continuous-search work (0.4.0) and is kept as the record of what existed and why each piece was built or reused. File names are in `src/`.

## What already existed (reused, not rewritten)

| Area | State in 0.3.2 | Where |
| --- | --- | --- |
| Persistent storage | One SQLite file (WAL): `urls`, `hosts`, `documents`, `docs_fts` | `frontier.ts`, `documents.ts` |
| URL normalisation | Scheme/host/percent-escape normalisation, tracking parameters removed, fragments dropped, IP literals, internal hosts, credentials and non-default ports refused | `url.ts` |
| Frontier | Persistent, deduplicated by canonical URL key; `DEMAND` and `PUBLIC` queues with separate PrivaNet credentials; priority column; depth limit 8; one in-flight URL per host; per-host delay (raised by robots `Crawl-delay`); exponential backoff, `Retry-After`, a host-wide backoff; every one of the twelve fetch outcomes has an explicit policy; stale lease requeue | `frontier.ts` |
| Crawl pipeline | `Crawler.run`: a continuous pipeline over `FetchTransport`, results validated against the Core schema and cross-checked, ingest, link discovery into the `PUBLIC` queue, a pipeline-level backoff while PrivaNet is unreachable (0.3.2) | `driver.ts` |
| Transport | The only way out is `@privanet/sdk` (`web.fetch.v1`); no direct fetch of a crawled URL anywhere | `privanet/` |
| Robots, redirects, size, content type, SSRF | Enforced by the PrivaNode fetcher (Core); PrivaSearch handles the resulting outcomes | Core + `frontier.ts` |
| Index | FTS5 over title, description, text (`bm25` column weights); exact-content duplicate detection; `noindex` and 404/410 removal; query terms quoted so FTS syntax is inert | `documents.ts` |
| Search API | `GET /search?q=&limit=`, `GET /health`, JSON, bounded input, no cookies, no query logging | `server.ts` |
| Crawl command | `crawl.ts`: seeds from arguments or a file, run until stopped | `crawl.ts` |

## Gaps (what 0.3.2 could not do)

1. **No long-running service.** The search API (`main.ts`) and the crawler (`crawl.ts`) were separate processes over one database, with no shared lifecycle, no graceful shutdown and no seeds-at-start model.
2. **No demand crawl.** A search never caused any crawling. There was no query-to-URL discovery and no policy for "the index is too thin".
3. **Ranking was `bm25` alone.** No title/URL/domain signal beyond column weights, no freshness, no link signal, no partial-match fallback, no duplicate suppression beyond identical content, no pagination, no relevance information in the response.
4. **No link graph.** Discovered links went to the frontier and were forgotten, so there was nothing to rank by or to discover from.
5. **Recrawl was a fixed seven days** for every page, whether it changed daily or never, and a URL that failed permanently was never retried (`FAILED` was not leasable). Content hashes were stored but never compared.
6. **No crawl-trap defence** beyond the depth limit: calendars, faceted filters, session identifiers and repeating path segments could flood the frontier. No per-host URL budget.
7. **Discovery priority was flat.** Every discovered link had priority 0 regardless of depth.
8. **Canonical URLs were stored but not used** for deduplication.
9. **No migration path** for a database created by an older version.
10. **The search API had no authentication option**, which a service reachable from another machine needs.

## Decisions

- PrivaSearch stays the owner of all of this. PrivaNet-Core is unchanged: nothing here needs a Core capability that does not already exist. (`web.fetch.v1` returns no anchor text, which would improve ranking; that is recorded as a limitation, not a Core change request.)
- One process, one SQLite database, no distributed storage (that is Phase 5).
- Every fetch, for demand crawling and for the background crawler alike, goes through `web.fetch.v1`. There is no localhost bypass and no direct HTTP request to a crawled URL or to a search provider.
- Queries are never stored in plain text: demand deduplication uses a hash of the normalised terms.
- Query-to-URL discovery uses only the existing index and link graph, the frontier, and operator-configured URL templates. A template is a plain URL pattern fetched through PrivaNet like any other URL; there is no metasearch API client.
