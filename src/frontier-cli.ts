import { existsSync } from 'node:fs';
import { analyzeFrontier, formatAnalysis } from './analyze.js';

/**
 * Operator commands for the frontier. `analyze` is read-only and never migrates; run it against a copy or the live file.
 *   node dist/src/frontier-cli.js analyze [--db PATH] [--top N] [--json]
 */
const USAGE = 'usage: frontier-cli analyze [--db PATH] [--top N] [--json]';
const args = process.argv.slice(2); const command = args.shift();
const option = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dbPath = option('--db') ?? process.env.PRIVASEARCH_DB ?? '';
if (command === 'analyze') {
  if (dbPath === '' || !existsSync(dbPath)) { console.error('the database file was not found; pass --db PATH or set PRIVASEARCH_DB'); process.exit(2); }
  const top = Math.min(100, Math.max(1, Number(option('--top') ?? 10) || 10));
  const report = analyzeFrontier(dbPath, { top });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatAnalysis(report));
} else { console.error(USAGE); process.exit(2); }
