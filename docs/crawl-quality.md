# Crawl quality: diversity, discovery and frontier health

*Status: implemented on branch `claude/crawl-quality` (schema version 4). Not released. Every number below was measured on the synthetic web in `tests/sim` or by `tests/bench/scale.ts`; nothing is estimated and nothing was measured on a live production database.*

## The problem

A frontier of about 18,000 pending URLs was dominated by Wikipedia and its language editions. The cause is arithmetic, not a bug in one rule: the old scheduler ordered work by priority and next-due time, and a page's priority did not depend on how much of the site was already crawled. A giant, densely self-linking site contributes hundreds of links per page, so it floods the frontier with equal-priority URLs and wins every lease. Independent sites that are linked once (an official site, a news site, a blog) sit behind thousands of wiki URLs.

The same harness that measures the new code also ran on the parent commit (v0.4.1, `tests/sim/baseline-0.4.1.jsonl`): the wiki took 82-96 % of fetches and 83-98 % of the pending frontier.

The fix is generic. Nothing names Wikipedia. Any giant, internally linked site (a forum, a docs portal, a marketplace, a Q&A site) is treated the same way.

## The model: host, domain, family

| Level | What it is | What it governs |
| --- | --- | --- |
| **Host** | `en.wikipedia.org` | Politeness delay, robots, backoff, one request in flight, per-host URL budget (as before) |
| **Registrable domain** | `wikipedia.org`, from the Public Suffix List (`tldts`, pinned exactly). Private suffixes such as `github.io` are separate registrable domains, so `alice.github.io` and `bob.github.io` are different sites | Scheduling share, saturation, yield, authority, pending budget, concurrency cap |
| **Family** | Optional, operator-defined (`PRIVASEARCH_DOMAIN_FAMILIES`, e.g. `wikipedia.org,wikimedia.org,wiktionary.org`). Never guessed | Pending budget and concurrency cap across related domains |

## Scheduling: weighted fair queueing over domains

Priority still orders URLs *inside* a domain. Domains compete with each other for slots:

```text
weight(domain) = max(minWeight, saturation) x yieldFactor x authorityFactor
  saturation      = 1 / (1 + pagesCrawled / saturationPages)          (1.0 new; 0.5 after 200 pages by default)
  yieldFactor     = 0.25 + 1.5 x yieldEff                              (yieldEff: useful-page rate, pulled toward 0.5 with a 7-day half-life)
  authorityFactor = 1 + 0.1 x min(4, log2(1 + independent referring domains))
```

Each domain has a virtual time `vtime`. A served domain's `vtime` advances by `1 / weight`, and the next slot goes to the domain with the smallest `vtime` that has a *due URL on a free host*. Consequences:

- A domain with weight 1.0 is served about twice as often as one with weight 0.5; raw URL count buys nothing.
- A domain that sat idle cannot bank credit (`max(vtime, vmin)`), and a new domain starts at the front of the schedule.
- Only a domain that is actually served is charged. A domain waiting out a politeness delay is neither considered nor penalised, so a single-host site is not punished for being polite.
- Slots are split 70 % exploit (smallest `vtime`), 20 % explore (young domains with under 5 pages) and 10 % wildcard (a golden-ratio position in the `vtime` range, so a long tail is touched without randomness).
- Explicit **demand** is leased first, ahead of the fair queue, but still obeys politeness, the domain concurrency cap (2) and the family cap (4).
- Recrawls take a configurable share of each lease (`PRIVASEARCH_RECRAWL_SHARE`) and are spread: the most overdue URL of every domain before a second URL of any domain. A demand re-ask also refreshes a page that has not been fetched within the recrawl cooldown.

## Admission: bounding what enters the frontier

A URL discovered by a page or a sitemap is judged before insertion, in this order (the first reason wins, counters per reason are in `/status`):

`TOO_DEEP`, `EXISTS`, `LOW_VALUE` (media/binary files, edit/history/diff views, login/cart), `LANGUAGE_FILTERED`, `TRAP` (calendars, sessions, filters, deep pagination, plus `LONG_SEGMENT`, `PATH_SESSION`, `REPEATED_PARAM_VALUE`), `HOST_BUDGET`, `DOMAIN_BUDGET`, `FAMILY_BUDGET`, `GLOBAL_BUDGET`.

Seeds, redirect targets and explicit demand are never judged by these rules. Budgets default to 3,000 pending URLs per domain, 6,000 per family and 500,000 in total.

URL priority is computed once at admission and never rewritten: `clamp(base + external + relevance + language + query)` (demand 100, seeds 60, external bonus 12, relevance bonus 6, language -20). `frontier-cli explain URL` prints the full breakdown.

## Link fanout

A fetched page's links are not all admitted. `chooseLinks` is deterministic: links to *other* registrable domains first (one per domain, up to 40), then internal links whose path shares a word with the page title (up to 25), then at most 2 links to other hosts of the same domain. A giant site therefore contributes tens of URLs per page, not hundreds, and every page is a chance to meet a new site.

## Language

The URL hint comes from the host label or a path segment (`de.example.org`, `/fr/...`); country codes and service labels (`uk`, `ca`, `my`, ...) are never hints. Default: `preferredLanguages=en`, mode `deprioritize` (-20 priority); mode `filter` rejects at admission; `*` turns the check off. A fetched page in a non-preferred language is still indexed, but only its links to other domains are followed. Explicit demand ignores the language preference.

## Quality signals

- **Soft-404 and thin pages** are down-ranked (x0.3 in ranking), not deleted, and count against the domain's yield.
- **Authority** counts distinct registrable domains linking in, so a link farm on one domain gains nothing.
- **Yield** is the useful-page rate per domain; errors count against it, except a missing guessed `/sitemap.txt`.
- **Tracking parameters** can be stripped (`PRIVASEARCH_TRACKING_PARAMS`).

## Discovery

- `discover()` suggests at most 2 candidates per domain; links to other domains come first.
- A query that is itself a URL (or a bare domain) becomes a demand candidate directly.
- **Optional query provider** (off by default). `PRIVASEARCH_DISCOVERY_PROVIDER_URL` plus `PRIVASEARCH_DISCOVERY_PROVIDER_SEND_QUERIES=true`. Both are required because it sends the user's search text to a third party. The endpoint must be https (http only to loopback). It sends a plain `GET ?q=...&format=json` with no credentials, headers or cookies, no redirects, a timeout, a response-byte cap, at most 2 URLs per domain and an hourly cap. Results enter the DEMAND queue as `source=provider` and are *fetched through PrivaNet like everything else*; PrivaSearch never fetches them itself. The log carries counts only: never the query, the endpoint or the reason.
- **Opt-in `/sitemap.txt`** (`PRIVASEARCH_SITEMAP_TXT=true`): after 3 useful pages of a host, one `/sitemap.txt` fetch through `web.fetch.v1` (a text/plain page). Up to 100 same-domain URLs are admitted as `source=sitemap` and judged like links. The file is never indexed; a 404 does not count against the site; it is asked once per host.

## Blocked by the web.fetch.v1 contract

`web.fetch.v1` returns text/html, application/xhtml+xml and text/plain, at most 10 KiB of text and 100 links, with no anchor text, no `hreflang`, no feed links, no XML or gzip, and robots results without `Sitemap:` lines. Therefore PrivaSearch **cannot** currently do: XML sitemaps (and sitemap indexes), RSS/Atom discovery, `hreflang` alternates, anchor-text relevance, or `Sitemap:` discovery from robots.txt. This is policy-neutral transport capability that belongs in PrivaNet-Core, additively (`links[].text`, `hreflang` alternates, feed links, XML and gzip content types, robots `Sitemap` lines). It has been queued as a separate task for Core; PrivaSearch deliberately does not work around it with its own fetching.

## Schema v4 and migration

New: `urls.{domain,source,external}`, `hosts.urls`, `documents.low_value`, and tables `domains`, `states`, `counts`, `domain_links`. SQLite triggers maintain every counter in the same transaction, so counts are exact and O(1) (`/status`, `/health` and the scheduler never scan). Migration is one transaction (ALTERs, backfill, triggers, `user_version=4`); it is tested against a real v0.4.1 database produced by the parent commit's own code (`tests/fixtures/`), including rollback and crash cases. `source` is inferred only for rows that have no domain yet.

**Rollback caveat:** a v4 database is not readable by v0.4.1 code (it refuses newer schemas). Take a backup before the first start of the new version:

```sh
npm run frontier -- backup --db /var/lib/privasearch/privasearch.sqlite --out /var/backups/privasearch-pre-v4.sqlite   # VACUUM INTO: consistent even while the service runs
```

## Operator tools (`npm run frontier -- <command> --db PATH`, or `PRIVASEARCH_DB`)

| Command | What it does |
| --- | --- |
| `analyze [--top N] [--json]` | Read-only concentration report: shares by domain, Herfindahl index, effective number of domains, warnings |
| `explain URL` | Why a URL has its priority, and whether it would be admitted today (and which rule rejects it) |
| `domain DOMAIN` | One domain's counters, weight breakdown, hosts and pending/done mix |
| `seeds` | Health of each seed: pages, yield, last fetch; seed classes (`URL class=name`) are honoured |
| `prune --dry-run` (default) / `--apply` | Removes never-fetched, low-value or over-budget *discovered* pending URLs. Never touches demand, seeds, redirect targets, non-pending or fetched rows, documents or links. Dry-run equals apply; works in short batches; interruptible |
| `backup --out FILE` | `VACUUM INTO` a consistent copy |

`/status` (authenticated) carries cached concentration (top share, Herfindahl, effective domains, warnings) and the admission counters. Log lines carry numbers only; domain names appear only in `/status` and the CLI.

## Configuration

All settings are `PRIVASEARCH_*` environment variables, documented with defaults in `deploy/env/privasearch.env.example`. A nonsensical value stops the service at start (exit 78) naming the setting.

| Setting | Default |
| --- | --- |
| `PRIVASEARCH_MAX_PENDING_PER_DOMAIN` / `_PER_FAMILY` / `_TOTAL` | 3000 / 6000 / 500000 |
| `PRIVASEARCH_DOMAIN_CONCURRENCY` / `PRIVASEARCH_FAMILY_CONCURRENCY` | 2 / 4 |
| `PRIVASEARCH_SATURATION_PAGES`, `_MIN_DOMAIN_WEIGHT`, `_YIELD_HALF_LIFE_MS` | 200, 0.05, 7 days |
| `PRIVASEARCH_EXPLORE_SHARES` | `70,20,10` |
| `PRIVASEARCH_LANGUAGES`, `PRIVASEARCH_LANGUAGE_MODE` | `en`, `deprioritize` |
| `PRIVASEARCH_MAX_INTERNAL_LINKS`, `_MAX_EXTERNAL_LINKS`, `_MAX_SIBLING_LINKS` | 25, 40, 2 |
| `PRIVASEARCH_EXTERNAL_BONUS`, `PRIVASEARCH_RELEVANCE_BONUS` | 12, 6 |
| `PRIVASEARCH_TRACKING_PARAMS`, `PRIVASEARCH_DOMAIN_FAMILIES` | none |
| `PRIVASEARCH_RECRAWL_SHARE` | 0.25 |
| `PRIVASEARCH_SITEMAP_TXT` | off |
| `PRIVASEARCH_DISCOVERY_PROVIDER_*` | off |

## Results

### Synthetic web (`node dist/tests/sim/run.js 600`)

The synthetic web has a 50-edition wiki with translated titles, official, docs, news, forum and blog sites, spam, a redirecting site and a giant single-host site (`mega.test`). Same harness, same seeds, 600 fetches. Raw lines: `tests/sim/baseline-0.4.1.jsonl` (before) and `tests/sim/after-0.5.0.jsonl` (after).

| Scenario | Wiki share of fetches, before -> after | First independent site fetched at fetch #, before -> after |
| --- | --- | --- |
| A. one wiki seed, background only | 96 % -> 30 % | 17 -> 2 |
| B. A plus a search for "chatgpt" | 96 % -> 30 % | 17 -> 2 |
| C. wiki plus the giant single-host `mega.test`, all languages | 90 % -> 22 % | 21 -> 3 |
| D. as C, pipelined (8 in flight, 2 s fetches) | 83 % -> 26 % | 17 -> 3 |

All nine independent sites are reached in every run, before and after. What changes is how much they get: in scenario A each of the main independent sites (official, docs, news, blogs) receives 23-73 of 600 fetches after, versus 1-6 before. (`old.test`, the redirecting site, receives one fetch by design.) The raw lines are authoritative.

In the final pending frontier of scenario A the wiki holds 99.7 % of what is *left*, but the synthetic independent sites are finite and were crawled out, while the wiki is effectively unbounded; the scheduling share is what changed, and it is what matters.

### Scale (`node dist/tests/bench/scale.js 10000 100000`)

File-backed SQLite, one process, this container (not a production host). N pending URLs over N/40 domains; one giant domain holds 60 % of them. 98 % are inserted as *discovered* URLs, so every insert runs the full admission path (budgets are lifted for the benchmark so all are admitted), 2 % are seeds. A steady crawl of 300 leases of 8, each batch completed (with `recordPage`) before the next lease. `prune` runs with `keepPerDomain=20`, so it plans real work.

| Pending URLs | Insert incl. admission (rows/s) | Lease of 8, p50 / p99 | Complete + domain stats (avg) | `stats`+`detail` | Concentration | `analyze` | Prune dry-run (candidates) | DB size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 | 5,149 | 6.1 / 24 ms | 0.95 ms | 0.4 ms | 0.5 ms | 18 ms | 56 ms (7,580) | 4.6 MB |
| 100,000 | 5,058 | 6.4 / 24 ms | 0.94 ms | 0.8 ms | 1.4 ms | 161 ms | 2.76 s (85,980) | 36.6 MB |
| 1,000,000 | 8,355 | 6.5 / 35 ms | 0.96 ms | 1.7 ms | 3.5 ms | 721 ms | 61.6 s (463,980) | 196 MB |

Lease time is flat from 10k to 100k; prune dry-run grows with the work it plans (a read-only plan, never blocking the service). The benchmark found two real problems, fixed in this branch (same harness, before and after): the planner used a full-table index for the candidate-domain check and for demand/recrawl lookups (3,000 pending URLs: lease p50 20 ms -> 1.2 ms, with `INDEXED BY`), and the domain URL pick sorted every pending row of a giant domain because of an `ORDER BY` tie-break the index could not serve (profile of 400 pick queries at 100k pending: 213 ms -> 20 ms in total). The 10k case also runs in the test suite with generous limits (`tests/scale.test.ts`), so a regression to a table scan fails CI.

The 1,000,000 row is a single run on this container. Lease, completion and status costs stay flat; the prune *plan* is the expensive operation (about a minute at 1M, read-only), so run it from cron or by hand off-peak, not on the request path.

## Not done (deferred, honestly)

- **Near-duplicate detection** (simhash). Exact-content hashing and canonical-link dedup remain; near-duplicate would need another schema change and is not done.
- **Boilerplate reduction** and anchor-text signals (the latter blocked by the contract).
- **A built-in maintenance job.** Prune is a manual or cron command.
- **Robots/crawl-delay review.** Core owns robots; PrivaSearch honours the crawl-delay it is given. Reviewed only as documentation.
- **Live-database analysis.** Not performed; this branch never touched a production database. Run `frontier-cli analyze` on a *backup* copy.

## Rollout

1. `frontier-cli backup` the live database (above). Check the copy opens.
2. Deploy the new build. First start migrates in one transaction (a large frontier takes seconds to a minute; do not kill it).
3. Leave the defaults; add `PRIVASEARCH_DOMAIN_FAMILIES` for the giant sites you know (e.g. Wikimedia).
4. `frontier-cli analyze` and `/status` concentration after an hour and a day. Expect the top domain's share of *new fetches* to fall; the old pending backlog drains slowly by design.
5. `frontier-cli prune --dry-run`, review, then `--apply` to shed the old wiki backlog (never-fetched, low-priority discovered URLs only).
6. Only then consider `PRIVASEARCH_SITEMAP_TXT` and, if you accept the privacy trade-off, the query provider.
