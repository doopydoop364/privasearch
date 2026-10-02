import { getDomain } from 'tldts';

/**
 * The three levels PrivaSearch reasons about, and what each is used for.
 *
 *   host      "en.wikipedia.org"   politeness, robots, backoff and in-flight limits: one server, one connection budget.
 *   domain    "wikipedia.org"      the registrable domain (public-suffix list, private suffixes included). Diversity, pending budgets, crawl-share limits,
 *                                  saturation, yield and every concentration metric. All language editions of one site share one domain, so fifty
 *                                  subdomains are one site, not fifty.
 *   family    "wikimedia"          an OPTIONAL operator grouping of related domains (wikipedia.org + wikimedia.org + wiktionary.org). Used for the
 *                                  family politeness cap and for metrics. It defaults to the domain; PrivaSearch never guesses ownership.
 *
 * Private suffixes count as public suffixes: "alice.github.io" and "bob.github.io" are different sites, as are blogspot.com blogs. A host without a
 * registrable domain (an IP address, "localhost", a bare public suffix) is its own domain.
 */
export const registrableDomain = (host: string): string => getDomain(host, { allowPrivateDomains: true }) ?? host.toLowerCase();

export class DomainModel {
  private readonly families = new Map<string, string>();
  /** `groups` maps a family name to its registrable domains. A domain listed twice is a configuration error. */
  constructor(groups: Record<string, string[]> = {}) {
    for (const [family, domains] of Object.entries(groups)) for (const domain of domains) {
      const d = domain.toLowerCase(); if (this.families.has(d)) throw new Error(`domain ${d} is in two families`);
      this.families.set(d, family);
    }
  }
  domainOf(host: string): string { return registrableDomain(host); }
  familyOfDomain(domain: string): string { return this.families.get(domain) ?? domain; }
  familyOf(host: string): string { return this.familyOfDomain(registrableDomain(host)); }
}

/** Parses "family=domain,domain;family2=domain" (the PRIVASEARCH_DOMAIN_FAMILIES format). */
export function parseFamilies(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of text.split(';').map(p => p.trim()).filter(Boolean)) {
    const [name, list] = part.split('='); const family = name?.trim(); const domains = (list ?? '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    if (!family || !/^[a-z0-9._-]{1,64}$/i.test(family) || domains.length === 0 || domains.some(d => !/^[a-z0-9.-]{1,253}$/.test(d))) throw new Error('malformed family group');
    out[family] = [...(out[family] ?? []), ...domains];
  }
  return out;
}
