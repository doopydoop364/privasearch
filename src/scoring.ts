import { DEFAULT_POLICY } from './policy-options.js';
import type { ResolvedCrawlPolicy } from './policy-options.js';
import { DEMAND_PRIORITY, SEED_PRIORITY, discoveryPriority } from './policy.js';

/**
 * Scoring, in two decomposable layers (docs/crawl-quality.md). Both are pure functions of stored facts, so `frontier explain` shows exactly what the scheduler used.
 *
 * LAYER 1 - URL priority, computed once when a URL is admitted and never rewritten:
 *     priority = clamp(base + external + relevance + language + query + source, 0, 99)        (demand = 100, seeds = 60: never clamped)
 *       base       discoveryPriority(depth) = max(0, 50 - 6 * depth): shallow pages first
 *       external   +externalBonus when the link leaves the linking page's registrable domain (new domains are how a crawl widens)
 *       relevance  +relevanceBonus when the URL path shares a word with the linking page's title (cheap context relevance; no anchor text exists in web.fetch.v1)
 *       language   -20 when the URL carries a language hint outside the preferred languages (languageMode 'filter' refuses such URLs at admission instead)
 *       query      -6 when the URL has a query string (parameterised pages are more often views of the same content)
 *
 * LAYER 2 - domain weight, evaluated at lease time from counters (no per-URL work):
 *     weight = max(minWeight, saturation) * yieldFactor * authorityFactor
 *       saturation       1 / (1 + crawledPages / saturationPages): gradual diminishing returns, 1.0 for a new domain, 0.5 after saturationPages pages
 *       yieldFactor      0.25 + 1.5 * yieldEff, where yieldEff is the domain's useful-page rate pulled toward 0.5 (neutral) with age: low yield backs off, then decays
 *       authorityFactor  1 + 0.1 * min(4, log2(1 + independentReferringDomains)): distinct domains linking in, capped, so a link farm gains nothing
 *     The scheduler gives each domain leases in proportion to its weight (weighted fair queueing over `domains.vtime`), so raw URL volume buys nothing.
 *
 * EXPLICIT DEMAND bypasses saturation and the language filter (an explicit request is explicit) but never politeness, concurrency caps or SSRF protection.
 */
export type UrlSource = 'seed' | 'demand' | 'discovered' | 'redirect' | 'sitemap' | 'provider';
export interface PriorityFacts { source: UrlSource; depth: number; external: boolean; relevant: boolean; languageHintAllowed: boolean; hasQuery: boolean; basePriority?: number }
export interface PriorityBreakdown { total: number; base: number; external: number; relevance: number; language: number; query: number }

export function priorityOf(facts: PriorityFacts, policy: ResolvedCrawlPolicy = DEFAULT_POLICY): PriorityBreakdown {
  if (facts.source === 'demand') return { total: DEMAND_PRIORITY, base: DEMAND_PRIORITY, external: 0, relevance: 0, language: 0, query: 0 };
  if (facts.source === 'seed') return { total: SEED_PRIORITY, base: SEED_PRIORITY, external: 0, relevance: 0, language: 0, query: 0 };
  const base = facts.basePriority ?? discoveryPriority(facts.depth);
  const external = facts.external ? policy.externalBonus : 0; const relevance = facts.relevant ? policy.relevanceBonus : 0;
  const language = facts.languageHintAllowed ? 0 : -20; const query = facts.hasQuery ? -6 : 0;
  return { total: Math.max(0, Math.min(99, base + external + relevance + language + query)), base, external, relevance, language, query };
}

export interface DomainCounters { done: number; yield: number; yield_at: number; ref_domains: number }
export interface WeightBreakdown { weight: number; saturation: number; yieldEff: number; yieldFactor: number; authorityFactor: number }
export function domainWeight(d: DomainCounters, now: number, policy: ResolvedCrawlPolicy = DEFAULT_POLICY): WeightBreakdown {
  const saturation = Math.max(policy.minWeight, 1 / (1 + d.done / policy.saturationPages));
  const age = d.yield_at > 0 ? Math.max(0, now - d.yield_at) : 0; const decay = 0.5 ** (age / policy.yieldHalfLifeMs);
  const yieldEff = 0.5 + (d.yield - 0.5) * decay; const yieldFactor = 0.25 + 1.5 * yieldEff;
  const authorityFactor = 1 + 0.1 * Math.min(4, Math.log2(1 + d.ref_domains));
  return { weight: Math.max(policy.minWeight * 0.25, saturation * yieldFactor * authorityFactor), saturation, yieldEff, yieldFactor, authorityFactor };
}

/** Words of three or more letters or digits, lower-cased: the unit of "shares a word". */
export const words = (text: string): Set<string> => new Set(text.toLowerCase().normalize('NFKD').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3));
export function pathShares(urlPath: string, titleWords: Set<string>): boolean {
  if (titleWords.size === 0) return false;
  for (const w of words(decodeURIComponentSafe(urlPath))) if (titleWords.has(w)) return true;
  return false;
}
const decodeURIComponentSafe = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
