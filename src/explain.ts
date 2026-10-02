import { DatabaseSync } from 'node:sqlite';
import { Frontier } from './frontier.js';
import type { AddOptions, Evaluation, FrontierOptions, UrlRow } from './frontier.js';
import { languagePreferred, urlLanguageHint } from './language.js';
import { domainWeight, priorityOf } from './scoring.js';
import type { PriorityBreakdown, WeightBreakdown } from './scoring.js';

/**
 * `frontier explain <url>`: why is this URL where it is? Read-only. For a known URL it shows the stored priority next to the same priority recomputed from the
 * stored facts (depth, source, external, language hint, query string), the domain's schedule position and weight, and everything that stops it being leased
 * right now. For an unknown URL it shows what admission would say, without writing anything.
 */
export interface Explanation {
  input: string; normalized?: string; found: boolean;
  admission?: { verdict: Evaluation['verdict']; priority: PriorityBreakdown; languageHint: string | undefined };
  row?: { state: string; queue: string; source: string; depth: number; external: boolean; attempts: number; lastOutcome: string | null; nextAt: number; discoveredAt: number };
  priority?: { stored: number; recomputed: PriorityBreakdown; unexplained: number; note: string };
  domain?: { name: string; family: string; host: string; pending: number; inFlight: number; done: number; urls: number; fetched: number; useful: number; duplicates: number; lowValue: number; errors: number; yield: number; referringDomains: number; vtime: number; scheduleRank: number; readyDomains: number; weight: WeightBreakdown };
  blockers: string[];
}

export function explainUrl(dbPath: string, raw: string, now: number, options: FrontierOptions = {}): Explanation {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON;');
    if (Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) < 4) throw new Error('this database is older than schema 4: start PrivaSearch once (it migrates the database) and run explain again');
    const frontier = new Frontier(db, { ...options, readOnly: true }); const policy = frontier.policy;
    const probe: AddOptions = { queue: 'PUBLIC', source: 'discovered', depth: 1 };
    const e = frontier.evaluate(raw, probe);
    if (!e.parsed) return { input: raw, found: false, admission: { verdict: e.verdict, priority: e.priority, languageHint: undefined }, blockers: [`the address is not admissible: ${e.verdict}`] };
    const row = frontier.getByUrl(e.parsed.url);
    const out: Explanation = { input: raw, normalized: e.parsed.url, found: row !== undefined, blockers: [] };
    const domainRow = db.prepare('SELECT * FROM domains WHERE domain=?').get(e.domain) as Record<string, number | string> | undefined;
    if (domainRow) {
      const w = domainWeight({ done: Number(domainRow.done), yield: Number(domainRow.yield), yield_at: Number(domainRow.yield_at), ref_domains: Number(domainRow.ref_domains) }, now, policy);
      const rank = Number((db.prepare('SELECT COUNT(*) AS n FROM domains WHERE pending > 0 AND vtime < ?').get(Number(domainRow.vtime)) as { n: number }).n);
      const ready = Number((db.prepare('SELECT COUNT(*) AS n FROM domains WHERE pending > 0').get() as { n: number }).n);
      out.domain = { name: e.domain, family: String(domainRow.family), host: e.parsed.host, pending: Number(domainRow.pending), inFlight: Number(domainRow.in_flight), done: Number(domainRow.done), urls: Number(domainRow.urls), fetched: Number(domainRow.fetched),
        useful: Number(domainRow.useful), duplicates: Number(domainRow.duplicates), lowValue: Number(domainRow.low_value), errors: Number(domainRow.errors), yield: Math.round(Number(domainRow.yield) * 1000) / 1000, referringDomains: Number(domainRow.ref_domains),
        vtime: Math.round(Number(domainRow.vtime) * 1000) / 1000, scheduleRank: rank + 1, readyDomains: ready, weight: w };
    }
    if (!row) {
      out.admission = { verdict: e.verdict, priority: e.priority, languageHint: e.languageHint };
      out.blockers.push(e.verdict === 'WOULD_ADD' ? 'not in the frontier; a discovered link to it would be admitted' : `not in the frontier; a discovered link to it would be refused: ${e.verdict}`);
      return out;
    }
    const hint = urlLanguageHint(row.url); const recomputed = priorityOf({ source: row.source, depth: row.depth, external: row.external === 1, relevant: false, languageHintAllowed: languagePreferred(hint, policy.preferredLanguages), hasQuery: row.url.includes('?') }, policy);
    out.row = { state: row.state, queue: row.queue, source: row.source, depth: row.depth, external: row.external === 1, attempts: row.attempts, lastOutcome: row.last_outcome, nextAt: row.next_at, discoveredAt: Number((db.prepare('SELECT discovered_at AS d FROM urls WHERE url_key=?').get(row.url_key) as { d: number }).d) };
    out.priority = { stored: row.priority, recomputed, unexplained: row.priority - recomputed.total, note: 'unexplained = stored priority minus the recomputation from stored facts: the link-relevance bonus, an explicit priority, or a later promotion (demand, seed)' };
    blockers(db, frontier, row, now, out);
    return out;
  } finally { db.close(); }
}

function blockers(db: DatabaseSync, frontier: Frontier, row: UrlRow, now: number, out: Explanation): void {
  const b = out.blockers; const policy = frontier.policy;
  if (row.state !== 'PENDING') { b.push(`state is ${row.state}${row.state === 'DONE' ? ' (fresh until its next recrawl time)' : ''}, not PENDING`); }
  if (row.next_at > now) b.push(`not due for another ${Math.ceil((row.next_at - now) / 1000)} s (attempts ${row.attempts}, last outcome ${row.last_outcome ?? 'none'})`);
  const host = db.prepare('SELECT next_allowed_at, backoff_until, failures FROM hosts WHERE host=?').get(row.host) as { next_allowed_at: number; backoff_until: number; failures: number } | undefined;
  if (host && host.next_allowed_at > now) b.push(`its host is in its politeness delay for another ${Math.ceil((host.next_allowed_at - now) / 1000)} s`);
  if (host && host.backoff_until > now) b.push(`its host is backing off after ${host.failures} failure(s) for another ${Math.ceil((host.backoff_until - now) / 1000)} s`);
  if (db.prepare(`SELECT 1 FROM urls WHERE host=? AND state='IN_FLIGHT'`).get(row.host)) b.push('another URL of its host is in flight (one at a time per host)');
  if (out.domain && out.domain.inFlight >= policy.domainConcurrency) b.push(`its domain already has ${out.domain.inFlight} request(s) in flight (cap ${policy.domainConcurrency})`);
  if (row.queue === 'PUBLIC' && b.length === 0 && out.domain) b.push(`nothing blocks it: the domain is ${out.domain.scheduleRank} of ${out.domain.readyDomains} in the fair-share order, and within the domain it is served by priority`);
  if (row.queue === 'DEMAND' && b.length === 0) b.push('nothing blocks it: explicit demand is served before background work');
}

export function formatExplanation(x: Explanation, now: number): string {
  const lines = [`URL: ${x.normalized ?? x.input}`, x.found ? 'In the frontier: yes' : 'In the frontier: no'];
  if (x.row) lines.push(`Row: state ${x.row.state}, queue ${x.row.queue}, source ${x.row.source}, depth ${x.row.depth}, ${x.row.external ? 'found via a link from another domain' : 'not an external-link discovery'}, attempts ${x.row.attempts}, discovered ${Math.round((now - x.row.discoveredAt) / 1000)} s ago`);
  if (x.priority) {
    const p = x.priority.recomputed;
    lines.push(`Priority ${x.priority.stored} = base ${p.base} + external ${p.external} + relevance/other ${x.priority.unexplained} + language ${p.language} + query-string ${p.query}   (recomputed from stored facts: ${p.total})`);
  }
  if (x.admission) { const p = x.admission.priority; lines.push(`Admission verdict: ${x.admission.verdict}${x.admission.languageHint ? ` (language hint ${x.admission.languageHint})` : ''}; priority it would get: ${p.total} = base ${p.base} + external ${p.external} + relevance ${p.relevance} + language ${p.language} + query-string ${p.query}`); }
  if (x.domain) {
    const d = x.domain; const w = d.weight;
    lines.push(`Domain ${d.name} (family ${d.family}): pending ${d.pending}, in flight ${d.inFlight}, crawled ${d.done}, rows ${d.urls}; fetched ${d.fetched}: useful ${d.useful}, duplicate ${d.duplicates}, low-value ${d.lowValue}, errors ${d.errors}; yield ${d.yield}; ${d.referringDomains} independent referring domain(s)`);
    lines.push(`Schedule: position ${d.scheduleRank} of ${d.readyDomains} domains with pending work (virtual time ${d.vtime}); weight ${w.weight.toFixed(3)} = saturation ${w.saturation.toFixed(3)} x yield ${w.yieldFactor.toFixed(3)} (effective yield ${w.yieldEff.toFixed(3)}) x authority ${w.authorityFactor.toFixed(3)}`);
  }
  lines.push(...x.blockers.map(b => `- ${b}`)); return lines.join('\n');
}
