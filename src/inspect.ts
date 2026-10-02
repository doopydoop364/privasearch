import { DatabaseSync } from 'node:sqlite';
import { DomainModel } from './domain.js';

/**
 * Read-only operator views over a schema 4 database: seed health and one domain in detail. Neither writes anything, and neither makes a request.
 */
export type SeedVerdict = 'HEALTHY' | 'NOT_YET_FETCHED' | 'REDIRECTED' | 'BLOCKED' | 'DEGRADED' | 'STALE';
export interface SeedHealth { url: string; domain: string; seedClass: string | null; state: string; verdict: SeedVerdict; lastOutcome: string | null; lastHttp: number | null; attempts: number; fetchedAgoSec: number | null; domainPending: number; domainCrawled: number; domainYield: number }
export interface DomainDetail {
  domain: string; family: string; seedClass: string | null; pending: number; inFlight: number; crawled: number; failed: number; rows: number; fetched: number; useful: number; duplicates: number; lowValue: number; errors: number;
  yield: number; referringDomains: number; hosts: Array<{ host: string; rows: number; failures: number; backoffSec: number; delaySec: number }>; topPending: Array<{ url: string; priority: number; depth: number; source: string; external: boolean }>;
  outcomes: Record<string, number>; documents: number; sources: Record<string, number>;
}
const open = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path, { readOnly: true }); db.exec('PRAGMA query_only=ON;');
  if (Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) < 4) { db.close(); throw new Error('this database is older than schema 4: start PrivaSearch once (it migrates the database) and run this again'); }
  return db;
};

export function seedHealth(dbPath: string, now: number, model: DomainModel = new DomainModel()): SeedHealth[] {
  const db = open(dbPath);
  try {
    const rows = db.prepare(`SELECT u.url, u.domain, u.state, u.last_outcome, u.last_http, u.attempts, u.fetched_at, d.seed_class, d.pending, d.done, d.yield FROM urls u JOIN domains d ON d.domain = u.domain WHERE u.source='seed' ORDER BY u.domain, u.url`).all() as unknown as Array<Record<string, number | string | null>>;
    void model;
    return rows.map(r => {
      const outcome = r.last_outcome === null ? null : String(r.last_outcome); const http = r.last_http === null ? null : Number(r.last_http); const state = String(r.state);
      const verdict: SeedVerdict = outcome === null ? 'NOT_YET_FETCHED' : outcome === 'REDIRECT' ? 'REDIRECTED' : outcome === 'ROBOTS_DISALLOWED' || outcome === 'BLOCKED_TARGET' ? 'BLOCKED'
        : state === 'FAILED' || outcome === 'FETCH_FAILED' || outcome === 'ROBOTS_UNAVAILABLE' || (outcome === 'HTTP_ERROR' && (http ?? 0) >= 400) || outcome === 'UNSUPPORTED_CONTENT_TYPE' || outcome === 'TOO_LARGE' ? 'DEGRADED'
        : r.fetched_at !== null && now - Number(r.fetched_at) > 90 * 86400000 ? 'STALE' : 'HEALTHY';
      return { url: String(r.url), domain: String(r.domain), seedClass: r.seed_class === null ? null : String(r.seed_class), state, verdict, lastOutcome: outcome, lastHttp: http, attempts: Number(r.attempts), fetchedAgoSec: r.fetched_at === null ? null : Math.round((now - Number(r.fetched_at)) / 1000),
        domainPending: Number(r.pending), domainCrawled: Number(r.done), domainYield: Math.round(Number(r.yield) * 1000) / 1000 };
    });
  } finally { db.close(); }
}

export function domainDetail(dbPath: string, domain: string, now: number): DomainDetail | undefined {
  const db = open(dbPath);
  try {
    const d = db.prepare('SELECT * FROM domains WHERE domain=?').get(domain.toLowerCase()) as Record<string, number | string | null> | undefined; if (!d) return undefined;
    const all = (sql: string, ...a: Array<string | number>) => db.prepare(sql).all(...a) as unknown as Array<Record<string, number | string | null>>;
    const hosts = all(`SELECT u.host, COUNT(*) AS rows, COALESCE(h.failures,0) AS failures, COALESCE(h.backoff_until,0) AS backoff, COALESCE(h.next_allowed_at,0) AS delay FROM urls u LEFT JOIN hosts h ON h.host = u.host WHERE u.domain = ? GROUP BY u.host ORDER BY rows DESC, u.host LIMIT 25`, String(d.domain))
      .map(h => ({ host: String(h.host), rows: Number(h.rows), failures: Number(h.failures), backoffSec: Math.max(0, Math.round((Number(h.backoff) - now) / 1000)), delaySec: Math.max(0, Math.round((Number(h.delay) - now) / 1000)) }));
    const topPending = all(`SELECT url, priority, depth, source, external FROM urls WHERE domain = ? AND state='PENDING' ORDER BY priority DESC, url_key LIMIT 10`, String(d.domain)).map(r => ({ url: String(r.url), priority: Number(r.priority), depth: Number(r.depth), source: String(r.source), external: Number(r.external) === 1 }));
    const tally = (sql: string): Record<string, number> => Object.fromEntries(all(sql, String(d.domain)).map(r => [String(r.k), Number(r.n)]));
    return { domain: String(d.domain), family: String(d.family), seedClass: d.seed_class === null ? null : String(d.seed_class), pending: Number(d.pending), inFlight: Number(d.in_flight), crawled: Number(d.done), failed: Number(d.failed), rows: Number(d.urls),
      fetched: Number(d.fetched), useful: Number(d.useful), duplicates: Number(d.duplicates), lowValue: Number(d.low_value), errors: Number(d.errors), yield: Math.round(Number(d.yield) * 1000) / 1000, referringDomains: Number(d.ref_domains), hosts, topPending,
      outcomes: tally(`SELECT COALESCE(last_outcome,'NONE') AS k, COUNT(*) AS n FROM urls WHERE domain = ? GROUP BY k`), sources: tally(`SELECT source AS k, COUNT(*) AS n FROM urls WHERE domain = ? GROUP BY k`),
      documents: Number((db.prepare('SELECT COUNT(*) AS n FROM documents WHERE host = ? OR host LIKE ?').get(String(d.domain), `%.${String(d.domain)}`) as { n: number }).n) };
  } finally { db.close(); }
}

export function formatSeeds(list: SeedHealth[]): string {
  if (list.length === 0) return 'No seeds recorded. Seeds are the URLs in PRIVASEARCH_SEEDS; start the service once to record them.';
  const counts: Record<string, number> = {}; for (const s of list) counts[s.verdict] = (counts[s.verdict] ?? 0) + 1;
  return [`${list.length} seed(s): ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`, ...list.map(s => `${s.verdict.padEnd(15)} ${(s.seedClass ?? '-').padEnd(10)} ${s.lastOutcome ?? 'never fetched'}${s.lastHttp ? ` (${s.lastHttp})` : ''}  pending ${s.domainPending}, crawled ${s.domainCrawled}, yield ${s.domainYield}  ${s.url}`)].join('\n');
}
export function formatDomain(d: DomainDetail): string {
  return [`Domain ${d.domain} (family ${d.family}${d.seedClass ? `, seed class ${d.seedClass}` : ''})`, `Rows ${d.rows}: pending ${d.pending}, in flight ${d.inFlight}, crawled ${d.crawled}, failed ${d.failed}; ${d.documents} stored page(s)`,
    `Fetched ${d.fetched}: useful ${d.useful}, duplicate ${d.duplicates}, low-value ${d.lowValue}, errors ${d.errors}; yield ${d.yield}; ${d.referringDomains} independent referring domain(s)`, `Sources: ${JSON.stringify(d.sources)}`, `Last outcomes: ${JSON.stringify(d.outcomes)}`,
    'Hosts:', ...d.hosts.map(h => `  ${String(h.rows).padStart(7)} rows  failures ${h.failures}${h.backoffSec ? `, backing off ${h.backoffSec}s` : ''}${h.delaySec ? `, delay ${h.delaySec}s` : ''}  ${h.host}`),
    'Top pending:', ...d.topPending.map(p => `  ${String(p.priority).padStart(3)}  depth ${p.depth}  ${p.source}${p.external ? ' (external)' : ''}  ${p.url}`)].join('\n');
}
