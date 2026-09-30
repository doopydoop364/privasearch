/**
 * Configuration for the crawl command, from environment variables. Credentials are never accepted on the command
 * line (they would land in shell history and process listings) and never logged.
 */
export interface CrawlConfig {
  coordinatorUrl: string; tokens: { DEMAND: string; PUBLIC: string }; allowInsecureLoopback: boolean;
  dbPath: string; concurrency: number; seeds: string[]; seedQueue: 'DEMAND' | 'PUBLIC'; waitTimeoutMs: number; pollMs: number;
}
const TOKEN = /^[a-f0-9]{64}$/;
function integer(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function parseCrawlConfig(env: Record<string, string | undefined>, args: string[], seedFileText?: string): CrawlConfig {
  const coordinatorUrl = env.PRIVANET_COORDINATOR_URL; if (!coordinatorUrl) throw new Error('PRIVANET_COORDINATOR_URL is required');
  const demand = env.PRIVANET_DEMAND_TOKEN; const pub = env.PRIVANET_PUBLIC_TOKEN;
  if (!demand || !TOKEN.test(demand)) throw new Error('PRIVANET_DEMAND_TOKEN must be the 64-hex application credential for the demand queue');
  if (!pub || !TOKEN.test(pub)) throw new Error('PRIVANET_PUBLIC_TOKEN must be the 64-hex application credential for the public queue');
  if (demand === pub) throw new Error('the demand and public queues must use different PrivaNet application credentials');
  const fromFile = (seedFileText ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
  const seedQueue = env.PRIVASEARCH_SEED_QUEUE ?? 'PUBLIC'; if (seedQueue !== 'DEMAND' && seedQueue !== 'PUBLIC') throw new Error('PRIVASEARCH_SEED_QUEUE must be DEMAND or PUBLIC');
  return {
    coordinatorUrl, tokens: { DEMAND: demand, PUBLIC: pub }, allowInsecureLoopback: env.PRIVASEARCH_ALLOW_INSECURE_LOOPBACK === 'true',
    dbPath: env.PRIVASEARCH_DB ?? './var/privasearch.sqlite', concurrency: integer('PRIVASEARCH_CONCURRENCY', env.PRIVASEARCH_CONCURRENCY, 32, 1, 512),
    seeds: [...args.filter(arg => !arg.startsWith('-')), ...fromFile], seedQueue,
    waitTimeoutMs: integer('PRIVASEARCH_WAIT_TIMEOUT_MS', env.PRIVASEARCH_WAIT_TIMEOUT_MS, 60000, 1000, 600000), pollMs: integer('PRIVASEARCH_POLL_MS', env.PRIVASEARCH_POLL_MS, 100, 10, 5000),
  };
}
