import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { analyzeFrontier, formatAnalysis } from './analyze.js';
import type { FrontierOptions } from './frontier.js';
import { explainUrl, formatExplanation } from './explain.js';
import { formatPrune, prune } from './prune.js';
import { ConfigError, parseServiceConfig } from './service-config.js';

/**
 * Operator commands for the frontier (docs/crawl-quality.md). The database is PRIVASEARCH_DB or --db PATH; crawl-quality settings are the same PRIVASEARCH_* variables
 * the service reads, so a prune applies the policy the service runs with. Nothing here sends a request anywhere.
 *
 *   analyze [--top N] [--json]        read-only concentration report; works on any schema version, never migrates
 *   explain <url>                     read-only: why this URL has the priority and position it has (schema 4)
 *   prune [--dry-run] [--apply] ...   remove never-fetched discovered URLs the current rules would refuse, expired ones, and those over a budget
 *   backup --out FILE                 consistent copy of the database (VACUUM INTO), safe while the service runs
 */
const USAGE = `usage: frontier-cli <command> [--db PATH]
  analyze [--top N] [--json]
  explain <url>
  prune [--dry-run | --apply] [--expire-days N] [--keep-per-domain N] [--max-total N] [--protect-priority N] [--batch N]
  backup --out FILE`;
const args = process.argv.slice(2); const command = args.shift();
const option = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const number = (name: string): number | undefined => { const raw = option(name); if (raw === undefined) return undefined; const n = Number(raw); if (!Number.isFinite(n) || n < 0) { console.error(`${name} must be a non-negative number`); process.exit(2); } return n; };
const dbPath = option('--db') ?? process.env.PRIVASEARCH_DB ?? '';
const fail = (message: string, code = 2): never => { console.error(message); process.exit(code); };
if (!command || !['analyze', 'explain', 'prune', 'backup'].includes(command)) fail(USAGE);
if (dbPath === '' || !existsSync(dbPath)) fail('the database file was not found; pass --db PATH or set PRIVASEARCH_DB');
let policy: FrontierOptions = {};
try { policy = parseServiceConfig(process.env).frontier; }
catch (error) { fail(error instanceof ConfigError ? `invalid setting(s) ${error.names.join(', ')}: ${error.message}` : 'invalid configuration', 78); }

if (command === 'analyze') {
  const report = analyzeFrontier(dbPath, { top: Math.min(100, Math.max(1, number('--top') ?? 10)) });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatAnalysis(report));
} else if (command === 'explain') {
  const url = args.find(a => !a.startsWith('--') && a !== option('--db')); if (!url) fail(USAGE);
  const now = Date.now(); console.log(formatExplanation(explainUrl(dbPath, url as string, now, policy), now));
} else if (command === 'prune') {
  if (args.includes('--apply') && args.includes('--dry-run')) fail('choose --dry-run or --apply, not both');
  const abort = new AbortController(); process.on('SIGINT', () => { console.error('stopping after the current batch...'); abort.abort(); });
  const day = 86400000; const expire = number('--expire-days');
  const report = prune(dbPath, { now: Date.now(), apply: args.includes('--apply'), signal: abort.signal, policy,
    ...(expire === undefined ? {} : { expireMs: expire * day }), ...(number('--keep-per-domain') === undefined ? {} : { keepPerDomain: number('--keep-per-domain') as number }),
    ...(number('--max-total') === undefined ? {} : { maxTotal: number('--max-total') as number }), ...(number('--protect-priority') === undefined ? {} : { protectPriority: number('--protect-priority') as number }),
    ...(number('--batch') === undefined ? {} : { batch: number('--batch') as number }) });
  console.log(formatPrune(report));
} else {
  const out = option('--out'); if (!out) fail(USAGE); if (existsSync(out as string)) fail('refusing to overwrite an existing file');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { db.prepare('VACUUM INTO ?').run(out as string); } finally { db.close(); }
  chmodSync(out as string, 0o600); console.log(`backup written: ${out}`);
}
