import type { DatabaseSync } from 'node:sqlite';

/**
 * Stored page digests and the full-text index over them. Everything here came from an untrusted node
 * through PrivaNet, so it is treated as data: it is length-bounded by the contract, never interpreted
 * as markup or instructions, and search input is turned into quoted terms so it cannot inject FTS syntax.
 */
export interface DocumentInput {
  urlKey: string; url: string; finalUrl: string; title: string; description: string; canonicalUrl: string | null;
  language: string | null; text: string; contentSha256: string; fetchedAt: number; httpStatus: number;
}
export interface Hit { url: string; title: string; snippet: string; score: number }
const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  url_key TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  canonical_url TEXT, language TEXT, text TEXT NOT NULL, content_sha256 TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  http_status INTEGER NOT NULL, duplicate_of TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS documents_hash ON documents(content_sha256);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(url_key UNINDEXED, title, description, text, tokenize='unicode61 remove_diacritics 2');
`;
/** Only letters and digits survive; each term is quoted, so operators such as OR, NEAR, * and column filters are inert. */
export function toMatchQuery(raw: string): string | undefined {
  const terms = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16).map(term => term.slice(0, 64));
  return terms.length === 0 ? undefined : terms.map(term => `"${term}"`).join(' ');
}
export class DocumentStore {
  constructor(private readonly db: DatabaseSync) { db.exec(SCHEMA); }
  /** Stores or refreshes a page. Identical content already held under another URL makes this one a duplicate: kept, not indexed. */
  upsert(doc: DocumentInput): { duplicateOf?: string } {
    const original = this.db.prepare(`SELECT url_key FROM documents WHERE content_sha256=? AND url_key<>? AND duplicate_of IS NULL ORDER BY fetched_at, url_key LIMIT 1`).get(doc.contentSha256, doc.urlKey) as { url_key: string } | undefined;
    this.db.prepare(`INSERT INTO documents (url_key,url,final_url,title,description,canonical_url,language,text,content_sha256,fetched_at,http_status,duplicate_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(url_key) DO UPDATE SET url=excluded.url, final_url=excluded.final_url, title=excluded.title, description=excluded.description, canonical_url=excluded.canonical_url,
        language=excluded.language, text=excluded.text, content_sha256=excluded.content_sha256, fetched_at=excluded.fetched_at, http_status=excluded.http_status, duplicate_of=excluded.duplicate_of`)
      .run(doc.urlKey, doc.url, doc.finalUrl, doc.title, doc.description, doc.canonicalUrl, doc.language, doc.text, doc.contentSha256, doc.fetchedAt, doc.httpStatus, original?.url_key ?? null);
    this.db.prepare('DELETE FROM docs_fts WHERE url_key=?').run(doc.urlKey);
    if (original) return { duplicateOf: original.url_key };
    this.db.prepare('INSERT INTO docs_fts (url_key,title,description,text) VALUES (?,?,?,?)').run(doc.urlKey, doc.title, doc.description, doc.text);
    return {};
  }
  /** Removes a page from the store and the index (the site now says noindex, or the page is gone). */
  remove(urlKey: string): void { this.db.prepare('DELETE FROM docs_fts WHERE url_key=?').run(urlKey); this.db.prepare('DELETE FROM documents WHERE url_key=?').run(urlKey); }
  search(query: string, limit = 10): Hit[] {
    const match = toMatchQuery(query); if (!match) return [];
    return (this.db.prepare(`SELECT d.url AS url, d.title AS title, snippet(docs_fts, 3, '', '', '…', 24) AS snippet, bm25(docs_fts, 0.0, 5.0, 2.0, 1.0) AS score
      FROM docs_fts JOIN documents d ON d.url_key = docs_fts.url_key WHERE docs_fts MATCH ? ORDER BY score LIMIT ?`).all(match, Math.min(Math.max(1, limit), 50)) as unknown as Hit[])
      .map(row => ({ url: String(row.url), title: String(row.title), snippet: String(row.snippet), score: Number(row.score) }));
  }
  count(): { documents: number; indexed: number; duplicates: number } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return { documents: n('SELECT COUNT(*) AS n FROM documents'), indexed: n('SELECT COUNT(*) AS n FROM docs_fts'), duplicates: n('SELECT COUNT(*) AS n FROM documents WHERE duplicate_of IS NOT NULL') };
  }
}
