import type { DatabaseSync } from 'node:sqlite';
import { initSchema, inTransaction } from './db.js';
import { parseCrawlUrl, urlKey } from './url.js';

/**
 * Stored page digests, the full-text index over them, and the link graph. Everything here came from an untrusted node
 * through PrivaNet, so it is treated as data: it is length-bounded by the contract, never interpreted as markup or
 * instructions, and search input is turned into quoted terms so it cannot inject FTS syntax.
 */
export interface DocumentInput {
  urlKey: string; url: string; finalUrl: string; title: string; description: string; canonicalUrl: string | null;
  language: string | null; text: string; contentSha256: string; fetchedAt: number; httpStatus: number;
  /** A soft 404 or an almost empty page: kept and still findable, but ranked far below real pages (down-ranked before anything is ever deleted). */
  lowValue?: boolean;
}
export interface Hit { url: string; title: string; snippet: string; score: number }
/** What `upsert` learned about the page: whether it is indexed, a duplicate, and whether its content differs from the previous fetch. */
export interface UpsertResult { duplicateOf?: string; changed: boolean; firstSeen: boolean }
/** One candidate for ranking: everything the ranker needs, in one row. */
export interface Candidate {
  urlKey: string; url: string; finalUrl: string; title: string; description: string; text: string; host: string; canonicalKey: string | null;
  fetchedAt: number; lastChangedAt: number; ftsScore: number; httpStatus: number; lowValue: boolean;
}
export interface LinkInput { key: string; url: string; host: string }

/** Only letters and digits survive; each term is quoted, so operators such as OR, NEAR, * and column filters are inert. */
export function queryTerms(raw: string): string[] {
  return (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16).map(term => term.slice(0, 64));
}
export function toMatchQuery(raw: string, mode: 'AND' | 'OR' = 'AND'): string | undefined {
  const terms = [...new Set(queryTerms(raw))];
  return terms.length === 0 ? undefined : terms.map(term => `"${term}"`).join(mode === 'AND' ? ' ' : ' OR ');
}

export class DocumentStore {
  constructor(private readonly db: DatabaseSync) { initSchema(db); }

  /**
   * Stores or refreshes a page. A page whose content is identical to one held under another URL, or whose canonical URL names another page
   * already held, is a duplicate: kept, not indexed. When the canonical page itself arrives later, pages that pointed at it become duplicates.
   */
  upsert(doc: DocumentInput): UpsertResult { return inTransaction(this.db, () => this.upsertWithin(doc)); }
  private upsertWithin(doc: DocumentInput): UpsertResult {
    const previous = this.db.prepare('SELECT content_sha256, first_seen_at, last_changed_at, change_count FROM documents WHERE url_key=?').get(doc.urlKey) as
      { content_sha256: string; first_seen_at: number | null; last_changed_at: number | null; change_count: number } | undefined;
    const changed = previous === undefined || previous.content_sha256 !== doc.contentSha256;
    const canonical = doc.canonicalUrl ? parseCrawlUrl(doc.canonicalUrl, doc.finalUrl) : undefined;
    const canonicalKey = canonical?.ok && urlKey(canonical.url) !== doc.urlKey ? urlKey(canonical.url) : null;
    let host = ''; try { host = new URL(doc.url).hostname; } catch { /* host stays empty */ }
    const byHash = this.db.prepare('SELECT url_key FROM documents WHERE content_sha256=? AND url_key<>? AND duplicate_of IS NULL ORDER BY fetched_at, url_key LIMIT 1').get(doc.contentSha256, doc.urlKey) as { url_key: string } | undefined;
    const byCanonical = canonicalKey === null ? undefined : this.db.prepare('SELECT url_key FROM documents WHERE url_key=? AND duplicate_of IS NULL AND (canonical_key IS NULL OR canonical_key<>?)').get(canonicalKey, doc.urlKey) as { url_key: string } | undefined;
    const original = byCanonical?.url_key ?? byHash?.url_key;
    this.db.prepare(`INSERT INTO documents (url_key,url,final_url,title,description,canonical_url,language,text,content_sha256,fetched_at,http_status,duplicate_of,canonical_key,host,first_seen_at,last_changed_at,change_count,low_value)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
      ON CONFLICT(url_key) DO UPDATE SET url=excluded.url, final_url=excluded.final_url, title=excluded.title, description=excluded.description, canonical_url=excluded.canonical_url,
        language=excluded.language, text=excluded.text, content_sha256=excluded.content_sha256, fetched_at=excluded.fetched_at, http_status=excluded.http_status, duplicate_of=excluded.duplicate_of,
        canonical_key=excluded.canonical_key, host=excluded.host, low_value=excluded.low_value,
        last_changed_at=CASE WHEN ? THEN excluded.fetched_at ELSE COALESCE(documents.last_changed_at, excluded.fetched_at) END,
        change_count=documents.change_count + CASE WHEN ? AND ? THEN 1 ELSE 0 END`)
      .run(doc.urlKey, doc.url, doc.finalUrl, doc.title, doc.description, doc.canonicalUrl, doc.language, doc.text, doc.contentSha256, doc.fetchedAt, doc.httpStatus, original ?? null,
        canonicalKey, host, previous?.first_seen_at ?? doc.fetchedAt, doc.fetchedAt, doc.lowValue ? 1 : 0, changed ? 1 : 0, changed ? 1 : 0, previous === undefined ? 0 : 1);
    if (original) { this.unindex(doc.urlKey); return { duplicateOf: original, changed, firstSeen: previous === undefined }; }
    this.index(doc.urlKey, doc.title, doc.description, doc.text);
    this.absorbCanonicalDuplicates(doc.urlKey);
    return { changed, firstSeen: previous === undefined };
  }

  /** Puts (or replaces) a page's full-text row. The row is addressed by rowid through `docs_index`: `docs_fts.url_key` is not indexed, so deleting by it would scan every row. */
  private index(key: string, title: string, description: string, text: string): void {
    const existing = this.db.prepare('SELECT id FROM docs_index WHERE url_key=?').get(key) as { id: number } | undefined;
    let id: number | bigint;
    if (existing) { id = existing.id; this.db.prepare('DELETE FROM docs_fts WHERE rowid=?').run(id); } else id = this.db.prepare('INSERT INTO docs_index (url_key) VALUES (?)').run(key).lastInsertRowid;
    this.db.prepare('INSERT INTO docs_fts (rowid,url_key,title,description,text) VALUES (?,?,?,?,?)').run(id, key, title, description, text);
  }
  private unindex(key: string): void {
    const existing = this.db.prepare('SELECT id FROM docs_index WHERE url_key=?').get(key) as { id: number } | undefined; if (!existing) return;
    this.db.prepare('DELETE FROM docs_fts WHERE rowid=?').run(existing.id); this.db.prepare('DELETE FROM docs_index WHERE id=?').run(existing.id);
  }

  /** Pages that named this one as their canonical page stop being separate results (unless doing so would leave a pair with no original). */
  private absorbCanonicalDuplicates(canonicalKey: string): void {
    const rows = this.db.prepare('SELECT url_key FROM documents WHERE canonical_key=? AND url_key<>? AND duplicate_of IS NULL').all(canonicalKey, canonicalKey) as Array<{ url_key: string }>;
    for (const row of rows) {
      this.db.prepare('UPDATE documents SET duplicate_of=? WHERE url_key=?').run(canonicalKey, row.url_key);
      this.unindex(row.url_key);
    }
  }

  /** Replaces the outgoing links recorded for a page (at most 100 arrive per fetch). */
  setLinks(srcKey: string, srcHost: string, links: LinkInput[]): void {
    this.db.prepare('DELETE FROM links WHERE src_key=?').run(srcKey);
    const insert = this.db.prepare('INSERT OR IGNORE INTO links (src_key,dst_key,dst_url,src_host,dst_host) VALUES (?,?,?,?,?)');
    for (const link of links.slice(0, 100)) if (link.key !== srcKey) insert.run(srcKey, link.key, link.url, srcHost, link.host);
  }
  outlinks(srcKey: string): Array<{ key: string; url: string; host: string }> {
    return (this.db.prepare('SELECT dst_key AS key, dst_url AS url, dst_host AS host FROM links WHERE src_key=? ORDER BY dst_url').all(srcKey) as unknown as Array<{ key: string; url: string; host: string }>);
  }
  /** For each page, the number of distinct OTHER hosts that link to it: the link signal used by ranking (a site linking to itself says nothing). */
  inboundHosts(keys: string[]): Map<string, number> {
    const out = new Map<string, number>(); if (keys.length === 0) return out;
    const rows = this.db.prepare(`SELECT dst_key, COUNT(DISTINCT src_host) AS n FROM links WHERE dst_key IN (${keys.map(() => '?').join(',')}) AND src_host<>dst_host GROUP BY dst_key`).all(...keys) as unknown as Array<{ dst_key: string; n: number }>;
    for (const row of rows) out.set(row.dst_key, Number(row.n)); return out;
  }

  /** Removes a page from the store, the index and the link graph (the site now says noindex, or the page is gone). Pages that were its duplicates are re-evaluated. */
  remove(urlKey_: string): void { inTransaction(this.db, () => this.removeWithin(urlKey_)); }
  private removeWithin(urlKey_: string): void {
    this.unindex(urlKey_);
    this.db.prepare('DELETE FROM documents WHERE url_key=?').run(urlKey_);
    this.db.prepare('DELETE FROM links WHERE src_key=?').run(urlKey_);
    const orphans = this.db.prepare('SELECT url_key, title, description, text FROM documents WHERE duplicate_of=? ORDER BY fetched_at, url_key').all(urlKey_) as unknown as Array<{ url_key: string; title: string; description: string; text: string }>;
    const [first, ...rest] = orphans; if (!first) return;
    this.db.prepare('UPDATE documents SET duplicate_of=NULL WHERE url_key=?').run(first.url_key);
    this.index(first.url_key, first.title, first.description, first.text);
    for (const other of rest) this.db.prepare('UPDATE documents SET duplicate_of=? WHERE url_key=?').run(first.url_key, other.url_key);
  }

  /** Plain full-text search, best `bm25` first. The ranker (ranking.ts) is what the API uses; this stays for tests and tools. */
  search(query: string, limit = 10): Hit[] {
    const match = toMatchQuery(query); if (!match) return [];
    return (this.db.prepare(`SELECT d.url AS url, d.title AS title, snippet(docs_fts, 3, '', '', '…', 24) AS snippet, bm25(docs_fts, 0.0, 5.0, 2.0, 1.0) AS score
      FROM docs_fts JOIN documents d ON d.url_key = docs_fts.url_key WHERE docs_fts MATCH ? ORDER BY score LIMIT ?`).all(match, Math.min(Math.max(1, limit), 50)) as unknown as Hit[])
      .map(row => ({ url: String(row.url), title: String(row.title), snippet: String(row.snippet), score: Number(row.score) }));
  }

  /** Up to `limit` indexed pages matching the query (all terms, or any term), with the raw `bm25` score for the ranker. */
  candidates(query: string, mode: 'AND' | 'OR', limit: number): Candidate[] {
    const match = toMatchQuery(query, mode); if (!match) return [];
    // Rank first, join after: the best `limit` full-text rows are picked by bm25 alone, and only those are joined to their pages. Joining first read a page row for every
    // page matching a common word (tens of thousands) just to throw all but `limit` of them away.
    const rows = this.db.prepare(`SELECT d.url_key AS urlKey, d.url AS url, d.final_url AS finalUrl, d.title AS title, d.description AS description, d.text AS text, COALESCE(d.host,'') AS host,
        d.canonical_key AS canonicalKey, d.fetched_at AS fetchedAt, COALESCE(d.last_changed_at, d.fetched_at) AS lastChangedAt, d.http_status AS httpStatus, d.low_value AS lowValue, f.ftsScore AS ftsScore
      FROM (SELECT url_key, bm25(docs_fts, 0.0, 5.0, 2.0, 1.0) AS ftsScore FROM docs_fts WHERE docs_fts MATCH ? ORDER BY ftsScore, url_key LIMIT ?) f
      JOIN documents d ON d.url_key = f.url_key WHERE d.duplicate_of IS NULL ORDER BY f.ftsScore, d.url_key`).all(match, Math.min(Math.max(1, limit), 500)) as unknown as Candidate[];
    return rows.map(r => ({ ...r, fetchedAt: Number(r.fetchedAt), lastChangedAt: Number(r.lastChangedAt), ftsScore: Number(r.ftsScore), httpStatus: Number(r.httpStatus), lowValue: Number(r.lowValue) === 1 }));
  }

  get(key: string): { url: string; title: string; contentSha256: string; fetchedAt: number; lastChangedAt: number; changeCount: number; duplicateOf: string | null } | undefined {
    const row = this.db.prepare('SELECT url, title, content_sha256 AS contentSha256, fetched_at AS fetchedAt, COALESCE(last_changed_at, fetched_at) AS lastChangedAt, change_count AS changeCount, duplicate_of AS duplicateOf FROM documents WHERE url_key=?').get(key);
    return row as unknown as ReturnType<DocumentStore['get']>;
  }

  count(): { documents: number; indexed: number; duplicates: number } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return { documents: n('SELECT COUNT(*) AS n FROM documents'), indexed: n('SELECT COUNT(*) AS n FROM docs_index'), duplicates: n('SELECT COUNT(*) AS n FROM documents WHERE duplicate_of IS NOT NULL') };
  }
  /** Pages in the full-text index (what a search can find); one index scan, cheap enough to ask on every search. */
  indexedCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM docs_index').get() as { n: number }).n); }
  linkCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }).n); }
}
