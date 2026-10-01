import type { FrontierOptions } from './frontier.js';

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
    privanet = { coordinatorUrl: urlSetting as string, tokens: { DEMAND: demand as string, PUBLIC: pub as string }, allowInsecureLoopback: bool('PRIVASEARCH_ALLOW_INSECURE_LOOPBACK', env.PRIVASEARCH_ALLOW_INSECURE_LOOPBACK, false),
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
  if ((frontier.recrawlMinMs ?? 0) > (frontier.recrawlMaxMs ?? 0)) throw new ConfigError(['PRIVASEARCH_RECRAWL_MIN_MS', 'PRIVASEARCH_RECRAWL_MAX_MS'], 'PRIVASEARCH_RECRAWL_MIN_MS must not exceed PRIVASEARCH_RECRAWL_MAX_MS');
  return {
    dbPath: env.PRIVASEARCH_DB ?? './var/privasearch.sqlite', host, port: integer('PRIVASEARCH_PORT', env.PRIVASEARCH_PORT, 4020, 0, 65535), ...(apiToken ? { apiToken } : {}),
    ...(privanet ? { privanet } : {}), concurrency: integer('PRIVASEARCH_CONCURRENCY', env.PRIVASEARCH_CONCURRENCY, 8, 1, 512), seeds, templates, frontier,
    demand: { enabled: bool('PRIVASEARCH_DEMAND', env.PRIVASEARCH_DEMAND, true), minStrong: ms('PRIVASEARCH_DEMAND_MIN_RESULTS', 3, 1, 50), cooldownMs: ms('PRIVASEARCH_DEMAND_COOLDOWN_MS', 30 * 60000, 1000, 86400000),
      maxCandidates: ms('PRIVASEARCH_DEMAND_MAX_CANDIDATES', 12, 1, 100), maxPendingDemand: ms('PRIVASEARCH_DEMAND_MAX_PENDING', 300, 1, 100000), maxQueriesPerHour: ms('PRIVASEARCH_DEMAND_MAX_PER_HOUR', 30, 1, 100000) },
    shutdownMs: ms('PRIVASEARCH_SHUTDOWN_MS', 15000, 0, 300000), progressMs: ms('PRIVASEARCH_PROGRESS_MS', 60000, 1000, 3600000),
  };
}
