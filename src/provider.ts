import { registrableDomain } from './domain.js';
import { parseCrawlUrl } from './url.js';

/**
 * Optional discovery providers: something that, given a query, NAMES URLs worth crawling (a self-hosted SearXNG, a search API, an operator's own endpoint).
 * OFF by default and never required. What a provider is and is not:
 *
 *   - It only names URLs. Every name passes URL admission and is then fetched through web.fetch.v1 like any other URL. PrivaSearch never fetches a page, a result
 *     snippet or a ranking from a provider, and never indexes anything a provider says about a page.
 *   - It is ONE endpoint chosen by the operator (https, or plain http only to a literal loopback address). Nothing a user types can change where the request goes.
 *   - THE QUERY LEAVES PRIVASEARCH. That is the whole point of a provider, and the reason it needs an explicit opt-in (PRIVASEARCH_DISCOVERY_PROVIDER_SEND_QUERIES=true):
 *     the operator of the endpoint sees the words searched for (but nothing about who searched: PrivaSearch knows nobody). Only weak searches reach the provider,
 *     at most `maxPerHour` per hour, each at most once per demand cooldown. The query is never logged.
 *   - It never carries a credential: no API token, no PrivaNet or Coordinator credential, no cookie, no Authorization header, no request metadata from the user. The request
 *     is a plain GET with a fixed User-Agent. (An endpoint that needs a key for itself belongs behind the operator's own proxy.)
 *   - It is bounded: a timeout, a response size cap, no redirects, JSON only, at most `limit` URLs, at most two per registrable domain.
 *   - No scraping: there is no code path that fetches a consumer search engine's result page. A search engine's home page is a poor seed and is not used as one.
 */
export interface DiscoveryProvider { readonly name: string; discover(query: string, limit: number): Promise<string[]> }
export interface HttpProviderOptions { endpoint: string; timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch }
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i;

/** Validates the endpoint the way the Coordinator address is validated: https, or http to a literal loopback address, no credentials in the URL. */
export function validateProviderEndpoint(endpoint: string): URL {
  let url: URL; try { url = new URL(endpoint); } catch { throw new Error('the provider endpoint is not a URL'); }
  if (url.username !== '' || url.password !== '') throw new Error('the provider endpoint must not contain credentials');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.test(url.hostname))) throw new Error('the provider endpoint must be https (plain http only to a loopback address)');
  if (url.search !== '' || url.hash !== '') throw new Error('the provider endpoint must not carry a query string or fragment');
  return url;
}

export class HttpDiscoveryProvider implements DiscoveryProvider {
  readonly name = 'http'; private readonly endpoint: URL; private readonly timeoutMs: number; private readonly maxBytes: number; private readonly fetchImpl: typeof fetch;
  constructor(options: HttpProviderOptions) {
    this.endpoint = validateProviderEndpoint(options.endpoint); this.timeoutMs = options.timeoutMs ?? 5000; this.maxBytes = options.maxBytes ?? 256 * 1024; this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async discover(query: string, limit: number): Promise<string[]> {
    const url = new URL(this.endpoint); url.searchParams.set('q', query.slice(0, 200)); url.searchParams.set('format', 'json');
    const response = await this.fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'application/json', 'user-agent': 'PrivaSearch-discovery' }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`provider status ${response.status}`);
    const type = response.headers.get('content-type') ?? ''; if (!/json/i.test(type)) throw new Error('provider did not answer with JSON');
    const text = await readCapped(response, this.maxBytes); let body: unknown; try { body = JSON.parse(text); } catch { throw new Error('provider answer is not JSON'); }
    return pickUrls(body, limit);
  }
}

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > max) { await reader.cancel(); throw new Error('provider answer too large'); } chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Accepts {results:[{url}]} (SearXNG), {urls:[...]}, or a bare array of strings or {url} objects. Everything else about the answer is ignored. */
export function pickUrls(body: unknown, limit: number): string[] {
  const list: unknown[] = Array.isArray(body) ? body : Array.isArray((body as { results?: unknown })?.results) ? (body as { results: unknown[] }).results : Array.isArray((body as { urls?: unknown })?.urls) ? (body as { urls: unknown[] }).urls : [];
  const out: string[] = []; const perDomain = new Map<string, number>(); const seen = new Set<string>();
  for (const item of list) {
    const raw = typeof item === 'string' ? item : typeof (item as { url?: unknown })?.url === 'string' ? (item as { url: string }).url : undefined; if (raw === undefined) continue;
    const parsed = parseCrawlUrl(raw); if (!parsed.ok || seen.has(parsed.url)) continue;
    const domain = registrableDomain(parsed.host); const n = perDomain.get(domain) ?? 0; if (n >= 2) continue; // never a whole site
    perDomain.set(domain, n + 1); seen.add(parsed.url); out.push(parsed.url); if (out.length >= limit) break;
  }
  return out;
}
