import { PrivaNetClient } from '@privanet/sdk';
import { parseFamilies } from './domain.js';
import type { FrontierOptions } from './frontier.js';
import { resolvePolicy } from './policy-options.js';

/**
 * Configuration for the long-running service, from environment variables only. Credentials are never accepted on the command line (they would
 * land in shell history and process listings) and are never logged: an invalid setting is reported by NAME, never by value.
 *
 * PrivaNet is optional. With none of the PrivaNet settings the service is search-only (it serves the existing index and crawls nothing);
 * with all three it also runs the crawler and demand crawling. Anything in between is a configuration error.
 */
export interface ServiceConfig {
  dbPath: string; host: string; port: number; apiToken?: string;
  privanet?: { coordinatorUrl: string; tokens: { DEMAND: string; PUBLIC: string }; allowInsecureLoopback: boolean; waitTimeoutMs: number; pollMs: number };
  concurrency: number; seeds: string[]; templates: string[];
  frontier: FrontierOptions;
  demand: { enabled: boolean; minStrong: number; cooldownMs: number; maxCandidates: number; maxPendingDemand: number; maxQueriesPerHour: number };
  shutdownMs: number; progressMs: number;
}
export class ConfigError extends Error { constructor(readonly names: string[], message: string) { super(message); this.name = 'ConfigError'; } }

const TOKEN = /^[a-f0-9]{64}$/;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/;
function integer(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigError([name], `${name} must be an integer from ${min} to ${max}`);
  return value;
}
function bool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true; if (raw === 'false') return false;
  throw new ConfigError([name], `${name} must be true or false`);
}

export function parseServiceConfig(env: Record<string, string | undefined>, seedFileText?: string): ServiceConfig {
  const host = env.PRIVASEARCH_HOST ?? '127.0.0.1';
  const apiToken = env.PRIVASEARCH_API_TOKEN === undefined || env.PRIVASEARCH_API_TOKEN === '' ? undefined : env.PRIVASEARCH_API_TOKEN;
  if (apiToken !== undefined && apiToken.length < 32) throw new ConfigError(['PRIVASEARCH_API_TOKEN'], 'PRIVASEARCH_API_TOKEN must be at least 32 characters');
  if (!LOOPBACK.test(host) && apiToken === undefined) throw new ConfigError(['PRIVASEARCH_API_TOKEN', 'PRIVASEARCH_HOST'], 'PRIVASEARCH_API_TOKEN is required when PRIVASEARCH_HOST is not a loopback address');

  const urlSetting = env.PRIVANET_COORDINATOR_URL; const demand = env.PRIVANET_DEMAND_TOKEN; const pub = env.PRIVANET_PUBLIC_TOKEN;
  const given = [urlSetting, demand, pub].filter(value => value !== undefined && value !== '').length;
  let privanet: ServiceConfig['privanet'];
  if (given > 0) {
    const missing = [['PRIVANET_COORDINATOR_URL', urlSetting], ['PRIVANET_DEMAND_TOKEN', demand], ['PRIVANET_PUBLIC_TOKEN', pub]].filter(([, value]) => !value).map(([name]) => name as string);
    if (missing.length > 0) throw new ConfigError(missing, `PrivaNet is partly configured; also set ${missing.join(', ')} (or none of the three for search-only)`);
    if (!TOKEN.test(demand as string)) throw new ConfigError(['PRIVANET_DEMAND_TOKEN'], 'PRIVANET_DEMAND_TOKEN must be a 64-hex application credential');
    if (!TOKEN.test(pub as string)) throw new ConfigError(['PRIVANET_PUBLIC_TOKEN'], 'PRIVANET_PUBLIC_TOKEN must be a 64-hex application credential');
    if (demand === pub) throw new ConfigError(['PRIVANET_DEMAND_TOKEN', 'PRIVANET_PUBLIC_TOKEN'], 'the demand and public queues must use different PrivaNet application credentials');
    const allowInsecureLoopback = bool('PRIVASEARCH_ALLOW_INSECURE_LOOPBACK', env.PRIVASEARCH_ALLOW_INSECURE_LOOPBACK, false);
    // Refuse an unusable Coordinator address HERE, as a configuration error (exit status 78, no restart loop), using the SDK's own rules. Left to the transport it
    // surfaced as an unexplained "service.start_failed" with status 1, which a service manager restarts every few seconds. The address itself is never echoed (it can carry credentials).
    try { new PrivaNetClient({ url: urlSetting as string, token: demand as string, ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}) }); }
    catch { throw new ConfigError(['PRIVANET_COORDINATOR_URL'], 'PRIVANET_COORDINATOR_URL is not an acceptable Coordinator address: use https://host (plain http only for a literal loopback address with PRIVASEARCH_ALLOW_INSECURE_LOOPBACK=true)'); }
    privanet = { coordinatorUrl: urlSetting as string, tokens: { DEMAND: demand as string, PUBLIC: pub as string }, allowInsecureLoopback,
      waitTimeoutMs: integer('PRIVASEARCH_WAIT_TIMEOUT_MS', env.PRIVASEARCH_WAIT_TIMEOUT_MS, 60000, 1000, 600000), pollMs: integer('PRIVASEARCH_POLL_MS', env.PRIVASEARCH_POLL_MS, 100, 10, 5000) };
  }
  const seeds = (seedFileText ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
  const templates = (env.PRIVASEARCH_DISCOVERY_TEMPLATES ?? '').split(/\s+/).filter(Boolean);
  const ms = (name: string, fallback: number, min: number, max: number) => integer(name, env[name], fallback, min, max);
  const frontier: FrontierOptions = {
    hostDelayMs: ms('PRIVASEARCH_HOST_DELAY_MS', 2000, 0, 3600000), maxDepth: ms('PRIVASEARCH_MAX_DEPTH', 8, 0, 32), maxUrlsPerHost: ms('PRIVASEARCH_MAX_URLS_PER_HOST', 2000, 1, 1000000),
    recrawlMs: ms('PRIVASEARCH_RECRAWL_MS', 7 * 86400000, 60000, 365 * 86400000), recrawlMinMs: ms('PRIVASEARCH_RECRAWL_MIN_MS', 6 * 3600000, 60000, 365 * 86400000),
    recrawlMaxMs: ms('PRIVASEARCH_RECRAWL_MAX_MS', 60 * 86400000, 60000, 3650 * 86400000),
  };
  Object.assign(frontier, parsePolicy(env));
  if ((frontier.recrawlMinMs ?? 0) > (frontier.recrawlMaxMs ?? 0)) throw new ConfigError(['PRIVASEARCH_RECRAWL_MIN_MS', 'PRIVASEARCH_RECRAWL_MAX_MS'], 'PRIVASEARCH_RECRAWL_MIN_MS must not exceed PRIVASEARCH_RECRAWL_MAX_MS');
  return {
    dbPath: env.PRIVASEARCH_DB ?? './var/privasearch.sqlite', host, port: integer('PRIVASEARCH_PORT', env.PRIVASEARCH_PORT, 4020, 0, 65535), ...(apiToken ? { apiToken } : {}),
    ...(privanet ? { privanet } : {}), concurrency: integer('PRIVASEARCH_CONCURRENCY', env.PRIVASEARCH_CONCURRENCY, 8, 1, 512), seeds, templates, frontier,
    demand: { enabled: bool('PRIVASEARCH_DEMAND', env.PRIVASEARCH_DEMAND, true), minStrong: ms('PRIVASEARCH_DEMAND_MIN_RESULTS', 3, 1, 50), cooldownMs: ms('PRIVASEARCH_DEMAND_COOLDOWN_MS', 30 * 60000, 1000, 86400000),
      maxCandidates: ms('PRIVASEARCH_DEMAND_MAX_CANDIDATES', 12, 1, 100), maxPendingDemand: ms('PRIVASEARCH_DEMAND_MAX_PENDING', 300, 1, 100000), maxQueriesPerHour: ms('PRIVASEARCH_DEMAND_MAX_PER_HOUR', 30, 1, 100000) },
    shutdownMs: ms('PRIVASEARCH_SHUTDOWN_MS', 15000, 0, 300000), progressMs: ms('PRIVASEARCH_PROGRESS_MS', 60000, 1000, 3600000),
  };
}

/**
 * The crawl-quality settings (docs/crawl-quality.md). Each is validated by name here, so a typo is reported as the setting that holds it, never as a value;
 * the cross-field rules live in resolvePolicy and are reported against the settings they involve.
 */
function parsePolicy(env: Record<string, string | undefined>): FrontierOptions {
  const int = (name: string, fallback: number | undefined, min: number, max: number): number | undefined => (env[name] === undefined || env[name] === '' ? fallback : integer(name, env[name], 0, min, max));
  const out: FrontierOptions = {};
  const set = <K extends keyof FrontierOptions>(key: K, value: FrontierOptions[K]) => { if (value !== undefined) out[key] = value; };
  set('maxPendingPerDomain', int('PRIVASEARCH_MAX_PENDING_PER_DOMAIN', undefined, 1, 10_000_000)); set('maxPendingPerFamily', int('PRIVASEARCH_MAX_PENDING_PER_FAMILY', undefined, 1, 10_000_000));
  set('maxPendingTotal', int('PRIVASEARCH_MAX_PENDING_TOTAL', undefined, 1, 100_000_000)); set('domainConcurrency', int('PRIVASEARCH_DOMAIN_CONCURRENCY', undefined, 1, 64));
  set('familyConcurrency', int('PRIVASEARCH_FAMILY_CONCURRENCY', undefined, 1, 256)); set('saturationPages', int('PRIVASEARCH_SATURATION_PAGES', undefined, 1, 10_000_000));
  set('yieldHalfLifeMs', int('PRIVASEARCH_YIELD_HALF_LIFE_MS', undefined, 60000, 3650 * 86400000));
  set('maxInternalLinksPerPage', int('PRIVASEARCH_MAX_INTERNAL_LINKS', undefined, 0, 100)); set('maxExternalLinksPerPage', int('PRIVASEARCH_MAX_EXTERNAL_LINKS', undefined, 0, 100));
  set('maxSiblingLinksPerPage', int('PRIVASEARCH_MAX_SIBLING_LINKS', undefined, 0, 100)); set('externalBonus', int('PRIVASEARCH_EXTERNAL_BONUS', undefined, 0, 50)); set('relevanceBonus', int('PRIVASEARCH_RELEVANCE_BONUS', undefined, 0, 50));
  if (env.PRIVASEARCH_MIN_DOMAIN_WEIGHT) { const w = Number(env.PRIVASEARCH_MIN_DOMAIN_WEIGHT); if (!(w > 0 && w <= 1)) throw new ConfigError(['PRIVASEARCH_MIN_DOMAIN_WEIGHT'], 'PRIVASEARCH_MIN_DOMAIN_WEIGHT must be above 0 and at most 1'); out.minWeight = w; }
  if (env.PRIVASEARCH_EXPLORE_SHARES) {
    const parts = env.PRIVASEARCH_EXPLORE_SHARES.split('/').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 100) || parts[0]! + parts[1]! + parts[2]! !== 100) throw new ConfigError(['PRIVASEARCH_EXPLORE_SHARES'], 'PRIVASEARCH_EXPLORE_SHARES must be three whole percentages totalling 100, for example 70/20/10 (exploit/explore/wildcard)');
    out.explore = { exploit: parts[0]!, explore: parts[1]!, wildcard: parts[2]! };
  }
  if (env.PRIVASEARCH_LANGUAGES) {
    const list = env.PRIVASEARCH_LANGUAGES.split(',').map(l => l.trim().toLowerCase()).filter(Boolean);
    if (list.length === 0 || list.some(l => l !== '*' && !/^[a-z]{2,3}$/.test(l))) throw new ConfigError(['PRIVASEARCH_LANGUAGES'], 'PRIVASEARCH_LANGUAGES must be a comma-separated list of language codes such as en,de, or *');
    out.preferredLanguages = list;
  }
  if (env.PRIVASEARCH_LANGUAGE_MODE) { if (env.PRIVASEARCH_LANGUAGE_MODE !== 'filter' && env.PRIVASEARCH_LANGUAGE_MODE !== 'deprioritize') throw new ConfigError(['PRIVASEARCH_LANGUAGE_MODE'], 'PRIVASEARCH_LANGUAGE_MODE must be filter or deprioritize'); out.languageMode = env.PRIVASEARCH_LANGUAGE_MODE; }
  if (env.PRIVASEARCH_TRACKING_PARAMS) {
    const list = env.PRIVASEARCH_TRACKING_PARAMS.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
    if (list.some(p => !/^[a-z0-9_.-]{1,40}$/.test(p))) throw new ConfigError(['PRIVASEARCH_TRACKING_PARAMS'], 'PRIVASEARCH_TRACKING_PARAMS must be a comma-separated list of parameter names'); out.trackingParams = list;
  }
  if (env.PRIVASEARCH_DOMAIN_FAMILIES) { try { out.families = parseFamilies(env.PRIVASEARCH_DOMAIN_FAMILIES); } catch { throw new ConfigError(['PRIVASEARCH_DOMAIN_FAMILIES'], 'PRIVASEARCH_DOMAIN_FAMILIES must look like family=domain.org,other.org;family2=third.org, with no domain in two families'); } }
  try { resolvePolicy(out); }
  catch (error) { throw new ConfigError(['PRIVASEARCH_MAX_PENDING_PER_DOMAIN', 'PRIVASEARCH_MAX_PENDING_PER_FAMILY'], error instanceof RangeError ? error.message : 'invalid crawl-quality settings'); }
  return out;
}
