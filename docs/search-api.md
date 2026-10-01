# Search API

PrivaSearch serves a small, stable JSON API over HTTP. It is meant for another server (PrivaProxy's server calls it; a browser should not). `apiVersion` is `1`; within version 1 changes are additive.

- JSON only, `GET` only, no cookies, no user identifiers, no logging of queries.
- Page text comes from untrusted websites. **Escape it before rendering it.** PrivaProxy renders it with `textContent`.
- The PrivaNet tokens never appear in any response. The optional API token below is a different credential, for callers of this API.

## Authentication

By default the service binds to `127.0.0.1` and needs no token. If `PRIVASEARCH_API_TOKEN` is set (at least 32 characters; required when `PRIVASEARCH_HOST` is not a loopback address), `/search` and `/status` need `Authorization: Bearer <token>`, compared in constant time, and answer `401 {"error":"UNAUTHORIZED"}` with `WWW-Authenticate: Bearer` otherwise. `/health` stays open for monitoring.

## `GET /health`

```json
{ "status": "ok", "apiVersion": 1, "version": "0.4.0", "documents": 120, "indexed": 118, "duplicates": 2, "crawling": true }
```

## `GET /search`

| Parameter | Meaning |
| --- | --- |
| `q` | The query, 1 to 200 characters. Required. Only letters and digits are used, so search operators are inert text. |
| `limit` | Results per page, 1 to 50, default 10 (an invalid value falls back to the default). |
| `offset` | Where the page starts, 0 to 300, default 0. |

```json
{
  "apiVersion": 1,
  "query": "sourdough starter",
  "total": 4, "offset": 0, "limit": 10,
  "hits": [
    {
      "url": "https://example.org/sourdough/starter",
      "title": "Sourdough starter guide",
      "snippet": "… how to keep a sourdough starter alive …",
      "host": "example.org",
      "score": 61.482,
      "fetchedAt": 1790800000000,
      "lastChangedAt": 1790700000000,
      "signals": { "matchedTerms": 2, "totalTerms": 2, "titleMatch": true, "urlMatch": true, "phraseMatch": true, "relevance": 0.41, "freshness": 0.97, "inboundHosts": 3 }
    }
  ],
  "index": { "state": "ready", "documents": 118 },
  "crawl": { "triggered": false, "state": "none", "candidates": 0 }
}
```

- `hits` are ranked best first (see [ranking.md](ranking.md)); `total` is the size of the whole ranked list (at most 300), so pages `offset=0`, `10`, `20`… tile it.
- `snippet` is plain text from the page body or description. `title` falls back to the address for an untitled page. `url` is the page's own address.
- `signals` explain a result: how many of the query's words it contains, whether the title, the address or an exact phrase matched, and the freshness and link signals.
- `index.state` is `ready` (at least three strong results), `partial` (some, but fewer) or `empty` (none). "Strong" is defined in [crawling.md](crawling.md#demand-crawling).
- `crawl` says what this search did about a thin result. It is only evaluated for the first page (`offset` 0); later pages never start crawling.

| `crawl.state` | Meaning |
| --- | --- |
| `none` | Nothing needed: the results are good enough (or the query had nothing searchable). |
| `scheduled` | Related URLs were queued as demand crawl work (`triggered: true`), or are already waiting from an earlier search (`triggered: false`, crawling is in progress). Results improve as pages are indexed; ask again in a few seconds. |
| `cooldown` | This query already scheduled crawling recently. Nothing new was started. `retryAfterSec` says when another round could start. |
| `busy` | The demand queue is full. |
| `rate_limited` | Too many different thin queries this hour. `retryAfterSec` is advisory. |
| `no_candidates` | Discovery found no new URLs to try for this query. |
| `disabled` | This service is not crawling (search-only mode, or demand crawling turned off). |

A search never waits for crawling: the response is always the index as it is now. A caller that wants to show improvement should look again after a few seconds (PrivaProxy does so up to eight times, four seconds apart).

Errors: `400 {"error":"BAD_QUERY"}` (missing, empty or over 200 characters), `401`, `404 {"error":"NOT_FOUND"}`, `405 {"error":"METHOD_NOT_ALLOWED"}`.

## `GET /status`

Counters for operators (authenticated like `/search`); never URLs or queries.

```json
{ "apiVersion": 1, "uptimeSec": 86400, "crawling": true,
  "documents": { "documents": 120, "indexed": 118, "duplicates": 2, "links": 2310 },
  "frontier": { "PENDING": 410, "IN_FLIGHT": 3, "DONE": 8200, "BLOCKED": 4, "FAILED": 17, "pendingDemand": 0, "pendingPublic": 410, "recrawlDue": 12, "hosts": 94 },
  "demand": { "queries": 52, "explored": 9 } }
```

## Stability

Fields may be added within `apiVersion` 1. A removed or changed field would bump `apiVersion`. `score` is for ordering and explanation, not a probability, and its scale may be retuned; do not store it.
