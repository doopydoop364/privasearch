# Crawling

How PrivaSearch decides what to fetch, when, and how politely. All of this is PrivaSearch policy. **Every fetch, with no exception, goes through PrivaNet's `web.fetch.v1`**: PrivaSearch makes no HTTP request to a crawled URL, and there is no shortcut for a node on the same machine. robots.txt, redirects, size and content-type limits, and the SSRF guard are enforced by the node; PrivaSearch applies the policy on top and handles each outcome.

```text
 seeds ─┐
 demand ┼─> frontier (SQLite) ─> lease ─> Crawler ─> PrivaNetTransport ─> Coordinator ─> PrivaNode (web.fetch.v1)
 links ─┘      ^                                          |
               |                                          v
        discovered links, recrawls  <──  validate ─> parse ─> index + link graph
```

## The frontier

A persistent SQLite table of URLs: state (`PENDING`, `IN_FLIGHT`, `DONE`, `BLOCKED`, `FAILED`), queue (`DEMAND` or `PUBLIC`, each with its own PrivaNet application credential), priority, depth, attempts, next due time, validators (ETag, Last-Modified), content hash and the recrawl interval. It survives restarts; on start the service takes back any lease the previous process held, and the idempotency key `crawl:<hash>:<generation>` makes a resubmission safe (PrivaNet returns the same job).

**Admission** (`src/url.ts`): only `http` and `https` on default ports; no credentials in the URL, no IP literals, no internal host names; fragments dropped; tracking parameters (`utm_*`, `fbclid`, `gclid`…) removed; host lower-cased; percent-escapes normalised. A parameter that selects a resource (`?id=7`) is kept. This is policy so the frontier never wastes jobs on URLs the node would refuse; the node re-validates independently.

**Politeness**: at most one URL in flight per host, a minimum delay between requests to a host (default 2 s, raised by a robots `Crawl-delay`), exponential backoff on errors (default 1 minute doubling to 6 hours), `Retry-After` honoured, and a host that keeps failing backs off as a whole. A `429` or `RATE_LIMITED` result waits as told and does not count as the URL's failure. Concurrency (default 8) bounds work in flight; it is also bounded by what your PrivaNodes offer, since the Coordinator only hands work to nodes that have room under their owner's resource policy.

## Background crawling

The crawler runs whenever the service runs, with or without searches:

1. **Seeds** (`PRIVASEARCH_SEEDS`, one URL per line) are added at start at priority 60 (re-adding is a no-op).
2. Each fetched page's links go into the frontier as `PUBLIC` work at **priority `50 - 6 x depth`** (never below 0), so shallow pages come first; a link seen again with a better priority raises it. Depth is limited (default 8).
3. The lease order is: explicit demand first; then a reserved **25 %** of each lease for recrawls that are due (most overdue first) and the rest for new URLs (highest priority, then oldest); whatever one side cannot use goes to the other. A single-slot lease gives every fourth turn to a recrawl. So endless discovery cannot starve refreshing, and refreshing cannot starve discovery.

### Crawl traps

Discovered links (not seeds, redirects or demand) are checked by `src/policy.ts` and refused, and counted, when they look like an unbounded URL space:

- more than 10 path segments, or the same segment three or more times;
- more than 5 query parameters, or a query over 160 characters;
- session or filter parameters (`sessionid`, `PHPSESSID`, `sort`, `order`, `filter`, `facet`, `replytocom`, `share`, `print`…);
- calendar or archive paths combined with date parameters or date segments, or two or more date parameters;
- pagination beyond page 20 (`?page=99`, `/page/45/`).

The backstop is a **per-host budget** of 2,000 discovered URLs (`PRIVASEARCH_MAX_URLS_PER_HOST`): past it, further discovered links on that host are refused. These are heuristics: they will refuse some legitimate URLs (a site with genuinely deep paths), and they cannot recognise every trap. See Limitations.

## Demand crawling

When a search finds too little, PrivaSearch schedules related crawling at higher priority than the background crawl, without making the searcher wait.

### When results are "weak"

A result is **strong** when it contains every query term and scores at least 25 of 100 ([ranking.md](ranking.md)). The result set is **weak** when it has **fewer than three strong results** (`PRIVASEARCH_DEMAND_MIN_RESULTS`). So no results, only partial matches, and a couple of marginal pages all count as weak; three solid pages do not. Only the first page of a search is considered.

### What happens, in order (stopping at the first that applies)

| State | Condition |
| --- | --- |
| `cooldown` | This query already scheduled crawling recently. The cooldown starts at 30 minutes (`PRIVASEARCH_DEMAND_COOLDOWN_MS`) and doubles for every round that did not fix the problem, up to 24 hours: a query that stays weak is retried with new candidates (the index has grown) but never hammered. |
| `busy` | The demand queue already holds 300 URLs (`PRIVASEARCH_DEMAND_MAX_PENDING`). |
| `rate_limited` | 30 distinct thin queries already scheduled crawling this hour (`PRIVASEARCH_DEMAND_MAX_PER_HOUR`). |
| `no_candidates` | Discovery named nothing new. A short cooldown applies so the lookup is not repeated on every search. |
| `scheduled` | Up to 12 NEW candidate URLs (`PRIVASEARCH_DEMAND_MAX_CANDIDATES`) are queued as `DEMAND` work, priority 100. If everything named is already waiting as demand work, crawling is in progress and nothing more is started. |

Repeated and rephrased searches do not cause crawl storms: the query is reduced to its sorted, de-duplicated, case- and diacritic-folded terms before it is looked up, so "Rust language", "language rust" and "rust  language!" are the same query.

**Privacy.** A query is stored only as a salted hash with counters and timestamps (the `queries` table; the salt is per install). The text is not kept, and nothing about who searched is known to this code. The terms exist in memory only while the request is handled. Search text is never put in a PrivaNet job; only the URLs chosen from it are.

### Query-to-URL discovery

A query does not name URLs, so `src/discovery.ts` asks a short list of sources, cheapest and most trustworthy first. A source only **names** URLs; each one still goes through admission and `web.fetch.v1`. There is no search-engine client and no direct request, so a user's query is never sent to a third party, and PrivaSearch ranks only what it has fetched and indexed itself.

1. **The frontier**: known `PUBLIC` URLs still waiting whose address contains a query term (3 letters or more) are promoted to demand work, the most terms matched first.
2. **The link graph**: for the best partial matches in the index, outgoing links that have never been fetched (those naming a query term first), up to three per page.
3. **Templates** (`PRIVASEARCH_DISCOVERY_TEMPLATES`, whitespace-separated, empty by default): operator-chosen URL patterns filled in from the query, the bootstrap for an **empty index**. `{title}` is the terms joined with `_` and the first letter capitalised (an encyclopedia article address such as `https://en.wikipedia.org/wiki/{title}`), `{slug}` joins with `-`, `{query}` joins with `+`. Terms are letters and digits only, so a query cannot add path segments, parameters or another host. A template is only a URL pattern: you choose which sites, and robots.txt, rate limits and the node's SSRF guard apply as for every other URL.

Newly fetched pages are parsed and indexed as they arrive and their links feed the frontier, so each round gives the next round better candidates.

## Recrawl

Each URL has its own interval. After a successful fetch:

| What happened | New interval |
| --- | --- |
| First fetch | the initial interval (`PRIVASEARCH_RECRAWL_MS`, default 7 days) |
| Content hash **changed** | halved, down to a minimum (`PRIVASEARCH_RECRAWL_MIN_MS`, default 6 hours) |
| Content hash **unchanged**, or the server said `304 Not Modified` | doubled, up to a maximum (`PRIVASEARCH_RECRAWL_MAX_MS`, default 60 days; 14 days for a page that five or more other hosts link to, so important pages stay fresher) |
| A probe | unchanged |

Recrawls send the stored validators (ETag, Last-Modified), so an unchanged page usually costs a `304`. Failures are separate: errors back off (above); a URL that exhausts its attempts becomes `FAILED` and is retried only rarely (30 days) and after everything else; `404`/`410` and "unsupported content" are rechecked after 30 days; a robots-disallowed URL is asked again after a day (robots.txt changes); a node-refused target (`BLOCKED_TARGET`) is not retried blindly.

## Index and deduplication

One SQLite file (`PRIVASEARCH_DB`): `documents` (normalised URL, final and canonical URL, title, description, extracted text, language, content hash, last fetch, last change, change count, HTTP status), an FTS5 index over title, description and text, the `links` graph, the frontier, the demand ledger. A database written by an older version is migrated in place when it is opened (`user_version` 2).

- Pages that are not text are not indexed: the node reports `UNSUPPORTED_CONTENT_TYPE` and the page is not stored. Only 2xx `FETCHED` pages are indexed; `noindex` pages are removed, and so are pages that now return `404` or `410`.
- Identical content under another URL is stored as a duplicate and not indexed. A page whose canonical URL names another indexed page is a duplicate of it, whichever arrives first. If the original is removed, a duplicate is promoted.
- URL variants collapse at admission (above); an unsafe-to-merge difference, such as a different query parameter that selects another resource, is kept.

## Limitations (known, not hidden)

- **One process, one SQLite file**: sized for hundreds of thousands of pages, not the public web at large. Search is synchronous inside the process. Distributed storage is later roadmap work.
- The trap heuristics will miss some traps and refuse some real URLs. The per-host budget bounds the damage.
- Default ports only: a site on a non-standard port is not crawled.
- Discovery for an **empty** index depends on the templates and seeds you configure; without them a first search finds nothing to crawl (`no_candidates`).
- `web.fetch.v1` returns at most 10 KiB of text and 100 links per page, and no anchor text, so the index holds the start of long pages only.
- No sitemaps, no JavaScript rendering, no per-site rules beyond robots.txt, no language-specific analysis.
- No trust model for third-party nodes: results from nodes you do not control are validated for shape and consistency only, which is why untrusted nodes are a later roadmap item.
