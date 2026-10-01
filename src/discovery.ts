import type { DatabaseSync } from 'node:sqlite';
import { DocumentStore } from './documents.js';
import type { RankedHit } from './ranking.js';
import { parseCrawlUrl, urlKey } from './url.js';

/**
 * Query-to-URL discovery. A plain text query does not say which URLs to crawl, so demand crawling asks a small list of sources for candidate
 * URLs, cheapest and most trustworthy first. Nothing here fetches anything: a source only NAMES URLs, and every URL it names still goes through
 * URL admission and then `web.fetch.v1` like any other. There is no search-engine client and no direct HTTP request, so a user's query is never
 * sent to a third party and PrivaSearch ranks only what it fetched and indexed itself.
 *
 *  1. the frontier   URLs already known and waiting whose address contains a query term: promoted from background to demand work
 *  2. the link graph the outgoing links of the best partial matches that have not been crawled yet, those naming a query term first
 *  3. templates      operator-configured URL patterns (for example an encyclopedia article address) filled in from the query; the bootstrap
 *                    for an empty index. A template is only a URL pattern: the operator chooses which sites, and robots.txt, rate limits and
 *                    the node's SSRF guard apply exactly as for every other URL.
 */
export interface DiscoveryContext { db: DatabaseSync; documents: DocumentStore; terms: string[]; hits: RankedHit[]; limit: number }
export type CandidateSource = (context: DiscoveryContext) => string[];

const usable = (term: string) => term.length >= 3;
const escapeLike = (text: string) => text.replace(/[\\%_]/g, ch => `\\${ch}`);

/** Known, waiting, public URLs whose address mentions the query: the most terms first, then the highest priority. */
export const frontierSource: CandidateSource = ({ db, terms, limit }) => {
  const words = terms.filter(usable).slice(0, 6); if (words.length === 0) return [];
  const score = words.map(() => `(CASE WHEN url LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`).join(' + ');
  const like = words.map(word => `%${escapeLike(word)}%`);
  const rows = db.prepare(`SELECT url, ${score} AS matches FROM urls WHERE state='PENDING' AND queue='PUBLIC' AND (${score}) > 0 ORDER BY matches DESC, priority DESC, url LIMIT ?`)
    .all(...like, ...like, limit) as unknown as Array<{ url: string }>;
  return rows.map(row => row.url);
};

/** Links out of the best-matching pages that PrivaSearch has never fetched: related pages are usually linked from the pages that mention the topic. */
export const linkSource: CandidateSource = ({ db, documents, terms, hits, limit }) => {
  const known = db.prepare('SELECT 1 FROM urls WHERE url_key=?'); const out: string[] = [];
  for (const hit of hits.slice(0, 5)) {
    const fresh = documents.outlinks(urlKey(hit.url)).filter(link => known.get(link.key) === undefined);
    fresh.sort((a, b) => Number(terms.some(t => b.url.toLowerCase().includes(t))) - Number(terms.some(t => a.url.toLowerCase().includes(t))) || (a.url < b.url ? -1 : 1));
    out.push(...fresh.slice(0, 3).map(link => link.url)); if (out.length >= limit) break;
  }
  return out;
};

/**
 * Expands URL templates. Placeholders: `{query}` (terms joined with +, percent-encoded), `{title}` (terms joined with _, first letter
 * capitalised: an encyclopedia article title), `{slug}` (terms joined with -). Terms are letters and digits only, so a query cannot add path
 * segments, parameters or another host to the template.
 */
export function expandTemplate(template: string, terms: string[]): string {
  const words = terms.slice(0, 8); const first = words[0] ?? '';
  const title = [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].map(encodeURIComponent).join('_');
  return template.replaceAll('{query}', words.map(encodeURIComponent).join('+')).replaceAll('{title}', title).replaceAll('{slug}', words.map(encodeURIComponent).join('-'));
}
export const templateSource = (templates: string[]): CandidateSource => ({ terms }) => {
  const out: string[] = [];
  for (const template of templates) { const url = expandTemplate(template, terms); if (parseCrawlUrl(url).ok) out.push(url); }
  return out;
};

export function discover(sources: CandidateSource[], context: DiscoveryContext): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const source of sources) {
    for (const raw of source(context)) {
      const parsed = parseCrawlUrl(raw); if (!parsed.ok || seen.has(parsed.url)) continue;
      seen.add(parsed.url); out.push(parsed.url); if (out.length >= context.limit) return out;
    }
  }
  return out;
}
