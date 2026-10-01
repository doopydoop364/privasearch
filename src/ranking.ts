import { DocumentStore, queryTerms } from './documents.js';
import type { Candidate } from './documents.js';

/**
 * First-generation ranking for a small, growing independent index. It is deterministic (the same index and the same query always give the
 * same order; ties break on URL) and every signal is visible in the response, so a result can be explained.
 *
 *   base  = 0.45 relevance + 0.20 title coverage + 0.10 URL coverage + 0.05 description coverage + 0.05 exact phrase + 0.15 term coverage
 *   score = 100 x base x coverage^2 x (1 + 0.10 freshness) x (1 + 0.15 authority)
 *
 * relevance  : the full-text `bm25` score (title weighted 5, description 2, body 1) squashed to 0..1 by x / (x + 6)
 * coverage   : the share of the query's terms the page contains (1 for a page matching every term; below 1 for a partial match, which
 *              is only used to fill out thin results and is penalised twice)
 * title/URL/description coverage: the share of query terms found in the title, the host and path, and the description
 * phrase     : 1 when two or more terms occur next to each other, in order
 * freshness  : exp(-days since the content last changed / 180), worth at most +10 %
 * authority  : min(1, log2(1 + number of other hosts linking to the page) / 4), worth at most +15 %
 *
 * Results that are the same page (a canonical variant, http versus https, www versus bare host, a trailing slash) are shown once. Within the
 * ranked list the n-th result from one host is multiplied by 0.85^(n-1), so one site cannot fill a page.
 */
export interface Relevance { matchedTerms: number; totalTerms: number; titleMatch: boolean; urlMatch: boolean; phraseMatch: boolean; relevance: number; freshness: number; inboundHosts: number }
export interface RankedHit { url: string; title: string; snippet: string; host: string; score: number; fetchedAt: number; lastChangedAt: number; signals: Relevance }
export interface SearchResult {
  /** Terms used, after normalisation; 0 means the query had nothing searchable. */
  terms: number;
  /** Results in the whole ranked list (at most MAX_RESULTS), and the requested page of them. */
  total: number; offset: number; limit: number; hits: RankedHit[];
  /** Results that contain every term and score at least STRONG_SCORE; the demand-crawl policy reads this. */
  strong: number; best: number;
}
export const MAX_RESULTS = 300;
export const STRONG_SCORE = 25;
const POOL = 300;
const DAY = 86400000;

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const tokens = (text: string): Set<string> => new Set(fold(text).match(/[\p{L}\p{N}]+/gu) ?? []);
const squash = (text: string): string => fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** The same page under trivially different URLs shares this key: scheme ignored, a leading www. dropped, a trailing slash dropped. */
export function variantKey(url: string): string {
  try { const u = new URL(url); const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : ''; return `${u.hostname.replace(/^www\./, '')}${path}${u.search}`; } catch { return url; }
}

function snippetFor(candidate: Candidate, terms: string[]): string {
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); // eslint-disable-line no-control-regex
  const text = clean(candidate.text); const lower = text.toLowerCase();
  let at = -1; for (const term of terms) { const i = lower.indexOf(term); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return clean(candidate.description).slice(0, 220) || text.slice(0, 220);
  const start = Math.max(0, at - 70); const end = Math.min(text.length, start + 220);
  let window = text.slice(start, end);
  if (start > 0) window = window.replace(/^\S*\s/, ''); if (end < text.length) window = window.replace(/\s\S*$/, '');
  return `${start > 0 ? '… ' : ''}${window}${end < text.length ? ' …' : ''}`;
}

export class Searcher {
  constructor(private readonly documents: DocumentStore, private readonly clock: () => number = Date.now) {}

  search(query: string, options: { limit?: number; offset?: number } = {}): SearchResult {
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 10)), 50); const offset = Math.min(Math.max(0, Math.trunc(options.offset ?? 0)), MAX_RESULTS);
    const terms = [...new Set(queryTerms(query).map(fold))];
    if (terms.length === 0) return { terms: 0, total: 0, offset, limit, hits: [], strong: 0, best: 0 };
    const all = this.documents.candidates(query, 'AND', POOL); const everyTerm = new Set(all.map(c => c.urlKey));
    const partial = terms.length > 1 && all.length < 100 ? this.documents.candidates(query, 'OR', POOL).filter(c => !everyTerm.has(c.urlKey)) : [];
    const inbound = this.documents.inboundHosts([...all, ...partial].map(c => c.urlKey));
    const now = this.clock(); const phrase = terms.join(' ');
    const scored: Array<{ hit: RankedHit; group: string; https: boolean }> = [];
    for (const [candidate, isAll] of [...all.map(c => [c, true] as const), ...partial.map(c => [c, false] as const)]) {
      let host = candidate.host; let path = '';
      try { const u = new URL(candidate.url); host = u.hostname; path = decodeURIComponent(u.pathname); } catch { /* keep the stored host */ }
      const titleTokens = tokens(candidate.title); const urlTokens = tokens(`${host} ${path}`); const descTokens = tokens(candidate.description);
      const bodyTokens = isAll ? undefined : tokens(candidate.text);
      const matched = isAll ? terms.length : terms.filter(t => titleTokens.has(t) || urlTokens.has(t) || descTokens.has(t) || bodyTokens?.has(t)).length;
      if (matched === 0) continue;
      const share = (set: Set<string>) => terms.filter(t => set.has(t)).length / terms.length;
      const titleCov = share(titleTokens); const urlCov = share(urlTokens); const descCov = share(descTokens);
      const phraseMatch = terms.length > 1 && squash(`${candidate.title} ${candidate.description} ${candidate.text}`).includes(phrase);
      const x = Math.max(0, -candidate.ftsScore); const relevance = x / (x + 6);
      const coverage = matched / terms.length;
      const freshness = Math.exp(-Math.max(0, now - candidate.lastChangedAt) / DAY / 180);
      const links = inbound.get(candidate.urlKey) ?? 0; const authority = Math.min(1, Math.log2(1 + links) / 4);
      const base = 0.45 * relevance + 0.20 * titleCov + 0.10 * urlCov + 0.05 * descCov + 0.05 * (phraseMatch ? 1 : 0) + 0.15 * coverage;
      const score = round(100 * base * coverage * coverage * (1 + 0.10 * freshness) * (1 + 0.15 * authority));
      let title = candidate.title.trim(); if (title === '') title = `${host}${path === '/' ? '' : path}`;
      scored.push({
        group: candidate.canonicalKey ?? variantKey(candidate.url), https: candidate.url.startsWith('https:'),
        hit: { url: candidate.url, title, snippet: snippetFor(candidate, terms), host, score, fetchedAt: candidate.fetchedAt, lastChangedAt: candidate.lastChangedAt,
          signals: { matchedTerms: matched, totalTerms: terms.length, titleMatch: titleCov > 0, urlMatch: urlCov > 0, phraseMatch, relevance: round(relevance), freshness: round(freshness), inboundHosts: links } },
      });
    }
    // One entry per page: the best-scoring variant (https first on a tie).
    scored.sort((a, b) => b.hit.score - a.hit.score || Number(b.https) - Number(a.https) || (a.hit.url < b.hit.url ? -1 : 1));
    const seen = new Set<string>(); const unique = scored.filter(s => { if (seen.has(s.group)) return false; seen.add(s.group); return true; });
    // Host diversity: the n-th result from a host is worth 0.85^(n-1) of its score.
    const perHost = new Map<string, number>(); const diversified: RankedHit[] = [];
    for (const { hit } of unique) { const n = perHost.get(hit.host) ?? 0; perHost.set(hit.host, n + 1); diversified.push(n === 0 ? hit : { ...hit, score: round(hit.score * 0.85 ** n) }); }
    diversified.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    const ranked = diversified.slice(0, MAX_RESULTS);
    const strong = ranked.filter(h => h.signals.matchedTerms === h.signals.totalTerms && h.score >= STRONG_SCORE).length;
    return { terms: terms.length, total: ranked.length, offset, limit, hits: ranked.slice(offset, offset + limit), strong, best: ranked[0]?.score ?? 0 };
  }
}
