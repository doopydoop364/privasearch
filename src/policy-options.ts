/**
 * Crawl-quality policy: every knob with its default and its validation. The Frontier takes these as part of FrontierOptions; the service reads them from
 * PRIVASEARCH_* environment variables (service-config.ts). Defaults are chosen so an untouched install behaves sensibly on a small index and on a large one.
 */
export interface ExplorePolicy { exploit: number; explore: number; wildcard: number }
export interface CrawlPolicyOptions {
  /** Pending (not yet crawled) discovered URLs one registrable domain, one operator-defined family, and the whole frontier may hold. Seeds, redirects and demand are exempt. */
  maxPendingPerDomain?: number; maxPendingPerFamily?: number; maxPendingTotal?: number;
  /** In-flight requests allowed per registrable domain and per family (a host still has at most one). */
  domainConcurrency?: number; familyConcurrency?: number;
  /** Domain saturation: a domain's scheduling weight is 1 / (1 + crawledPages / saturationPages), never below minWeight. */
  saturationPages?: number; minWeight?: number;
  /** A yield above or below neutral decays back toward neutral with this half-life. */
  yieldHalfLifeMs?: number;
  /** The share (percent, must total 100) of public leases that exploit the fairest-share order, explore young domains, or pick a pseudo-random domain. */
  explore?: ExplorePolicy;
  /** Languages worth crawling ('*' = all). Page languages and URL language hints outside this set are filtered or de-prioritised, see languageMode. */
  preferredLanguages?: string[]; languageMode?: 'filter' | 'deprioritize';
  /** Per fetched page: how many same-domain links, other-domain links, and "same page in another language edition" links may enter the frontier. */
  maxInternalLinksPerPage?: number; maxExternalLinksPerPage?: number; maxSiblingLinksPerPage?: number;
  /** Priority points added for a link that leaves the linking page's domain, and for a URL whose path shares words with the page that links to it. */
  externalBonus?: number; relevanceBonus?: number;
  /** Extra query-string parameters stripped from every URL (on top of the built-in utm_*, fbclid, gclid, ...). */
  trackingParams?: string[];
}
export interface ResolvedCrawlPolicy {
  maxPendingPerDomain: number; maxPendingPerFamily: number; maxPendingTotal: number; domainConcurrency: number; familyConcurrency: number; saturationPages: number; minWeight: number; yieldHalfLifeMs: number;
  explore: ExplorePolicy; preferredLanguages: string[]; languageMode: 'filter' | 'deprioritize';
  maxInternalLinksPerPage: number; maxExternalLinksPerPage: number; maxSiblingLinksPerPage: number; externalBonus: number; relevanceBonus: number; trackingParams: string[];
}
export const DEFAULT_POLICY: ResolvedCrawlPolicy = {
  maxPendingPerDomain: 3000, maxPendingPerFamily: 6000, maxPendingTotal: 500000, domainConcurrency: 2, familyConcurrency: 4, saturationPages: 200, minWeight: 0.05, yieldHalfLifeMs: 7 * 86400000,
  explore: { exploit: 70, explore: 20, wildcard: 10 }, preferredLanguages: ['en'], languageMode: 'filter',
  maxInternalLinksPerPage: 25, maxExternalLinksPerPage: 40, maxSiblingLinksPerPage: 2, externalBonus: 12, relevanceBonus: 6, trackingParams: [],
};

/** Applies defaults and rejects nonsense with the name of the offending field (never a silent clamp: a typo must be visible). */
export function resolvePolicy(options: CrawlPolicyOptions = {}): ResolvedCrawlPolicy {
  const known = Object.fromEntries(Object.entries(options).filter(([k, v]) => v !== undefined && k in DEFAULT_POLICY));
  const out = { ...DEFAULT_POLICY, ...known } as ResolvedCrawlPolicy;
  const int = (name: string, v: number, min: number, max: number) => { if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`); };
  int('maxPendingPerDomain', out.maxPendingPerDomain, 1, 10_000_000); int('maxPendingPerFamily', out.maxPendingPerFamily, 1, 10_000_000); int('maxPendingTotal', out.maxPendingTotal, 1, 100_000_000);
  int('domainConcurrency', out.domainConcurrency, 1, 64); int('familyConcurrency', out.familyConcurrency, 1, 256); int('saturationPages', out.saturationPages, 1, 10_000_000);
  int('maxInternalLinksPerPage', out.maxInternalLinksPerPage, 0, 100); int('maxExternalLinksPerPage', out.maxExternalLinksPerPage, 0, 100); int('maxSiblingLinksPerPage', out.maxSiblingLinksPerPage, 0, 100);
  int('externalBonus', out.externalBonus, 0, 50); int('relevanceBonus', out.relevanceBonus, 0, 50);
  if (!(out.minWeight > 0 && out.minWeight <= 1)) throw new RangeError('minWeight must be above 0 and at most 1');
  if (!(out.yieldHalfLifeMs >= 60000)) throw new RangeError('yieldHalfLifeMs must be at least one minute');
  if (out.maxPendingPerFamily < out.maxPendingPerDomain) throw new RangeError('maxPendingPerFamily must not be below maxPendingPerDomain');
  const e = out.explore; for (const k of ['exploit', 'explore', 'wildcard'] as const) int(`explore.${k}`, e[k], 0, 100);
  if (e.exploit + e.explore + e.wildcard !== 100) throw new RangeError('explore shares must total 100');
  if (out.languageMode !== 'filter' && out.languageMode !== 'deprioritize') throw new RangeError('languageMode must be filter or deprioritize');
  out.preferredLanguages = out.preferredLanguages.map(l => l.trim().toLowerCase()).filter(Boolean);
  if (out.preferredLanguages.length === 0 || out.preferredLanguages.some(l => l !== '*' && !/^[a-z]{2,3}$/.test(l))) throw new RangeError('preferredLanguages must be ISO 639 codes such as en, de, or *');
  out.trackingParams = out.trackingParams.map(p => p.trim().toLowerCase()).filter(Boolean);
  if (out.trackingParams.some(p => !/^[a-z0-9_.-]{1,40}$/.test(p))) throw new RangeError('trackingParams must be plain parameter names');
  return out;
}
