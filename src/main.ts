import { readFileSync } from 'node:fs';
import { ConfigError, parseServiceConfig } from './service-config.js';
import { startService } from './service.js';

// The PrivaSearch service: search API, background crawler and demand crawling in one long-running process (docs/deployment.md).
// Settings come from environment variables only; an invalid one is reported by NAME, never by value, and exits with status 78 (EX_CONFIG) so
// a service manager that honours RestartPreventExitStatus=78 does not restart-loop on a configuration mistake.
const EXIT_CONFIG = 78;
const seedFile = process.env.PRIVASEARCH_SEEDS;
let config;
try { config = parseServiceConfig(process.env, seedFile ? readFileSync(seedFile, 'utf8') : undefined); }
catch (error) {
  const names = error instanceof ConfigError ? error.names : ['PRIVASEARCH_SEEDS'];
  console.error(JSON.stringify({ event: 'service.config_invalid', settings: names, reason: error instanceof ConfigError ? error.message : 'the seed file could not be read' }));
  process.exit(EXIT_CONFIG);
}
let service;
try { service = await startService(config); }
catch (error) { console.error(JSON.stringify({ event: 'service.start_failed', reason: (error as NodeJS.ErrnoException).code ?? 'ERROR' })); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void service.stop().then(() => process.exit(0)); });
