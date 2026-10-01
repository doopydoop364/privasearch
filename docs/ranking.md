# Ranking

A first-generation ranker for a small, growing, independent index. The goal is "reasonable, useful results"; it is deliberately not a large-scale ranking system. It is deterministic (same index, same query, same order; ties break on URL) and every signal is returned in the response so a result can be explained. The implementation is `src/ranking.ts`; the numbers below are the ones it uses.

## Retrieval

The query is reduced to lower-case letters and digits (diacritics folded), at most 16 terms. Candidates come from the full-text index (SQLite FTS5, `bm25` with the title weighted 5, the description 2 and the body 1):

1. pages containing **every** term (up to 300);
2. if there are fewer than 100 of those and the query has more than one term, pages containing **any** term, to fill out thin results. These are partial matches and are ranked below full matches.

## Score

```
base  = 0.45 relevance + 0.20 title + 0.10 address + 0.05 description + 0.05 phrase + 0.15 coverage
score = 100 x base x coverage^2 x (1 + 0.10 freshness) x (1 + 0.15 authority)
```

| Signal | Definition |
| --- | --- |
| `relevance` | The `bm25` score squashed to 0..1 by `x / (x + 6)`. |
| `title`, `address`, `description` | The share of query terms found in the title, in the host and path, in the description. |
| `phrase` | 1 when two or more terms occur next to each other, in order, in the title, description or body. |
| `coverage` | The share of query terms the page contains: 1 for a full match, less for a partial match (which is penalised twice). |
| `freshness` | `exp(-days since the content last changed / 180)`, worth at most +10 %. Based on when the content hash last changed, not on when the page was last fetched. |
| `authority` | `min(1, log2(1 + N) / 4)` where N is the number of **other hosts** that link to the page, worth at most +15 %. A site linking to itself counts for nothing. |

A **strong** result contains every term and scores at least 25. The demand-crawl policy counts them ([crawling.md](crawling.md#demand-crawling)).

## Duplicates and diversity

- Identical content under different URLs is stored once as the original; the others are kept but not indexed ([crawling.md](crawling.md#index-and-deduplication)).
- A page that names another page as its canonical version is not a separate result once the canonical page is indexed.
- The same page under trivial variants (`http` or `https`, with or without `www.`, with or without a trailing slash) is shown once, the best-scoring variant, `https` winning a tie.
- On a result page, the n-th result from one host is multiplied by `0.85^(n-1)`, so one site cannot fill a page.

## Limits

- Link authority counts distinct linking hosts only from pages PrivaSearch has crawled, so on a small index it is a weak signal. There is no PageRank-style propagation.
- `web.fetch.v1` returns no anchor text, so link text is not used.
- No query understanding: no stemming, synonyms, spelling correction, language detection beyond the page's own declaration, or personalisation (there are no user identifiers).
- The weights were chosen by reasoning and checked against the tests in `tests/ranking.test.ts`, not tuned on a large judged query set. Expect to retune them as the index grows.
