import { DatabaseSync } from 'node:sqlite';
import { DomainModel } from './domain.js';

/**
 * Read-only frontier analysis. It opens the database read-only (no migration, no schema creation, no write of any kind), works on a schema as old as
 * version 3, and derives every domain from the stored host on the fly, so it is safe to run against a live production database or a copy of one.
 * Aggregation is by host first (one pass over `urls`, grouped), then by domain in memory, so the cost is one index-friendly scan, not per-URL work.
 */
export interface Share { key: string; count: number; share: number }
export interface FrontierAnalysis {
  totals: Record<string, number>;
  hosts: number; domains: number; families: number;
  pending: { total: number; topHosts: Share[]; topDomains: Share[]; topFamilies: Share[]; top1DomainShare: number; top5DomainShare: number; top10DomainShare: number; herfindahlDomains: number; effectiveDomains: number };
  done: { total: number; topDomains: Share[]; herfindahlDomains: number; effectiveDomains: number };
  depth: Record<string, number>;
  /** v3 stores no discovery source; rows are classified by queue and depth (an approximation, labelled as such). */
  sourceInferred: Record<string, number>;
  queues: Record<string, number>;
  outcomes: Record<string, number>;
  failureRate: number;
  links: { total: number; internalHost: number; internalDomain: number; externalDomain: number; externalDomainShare: number; distinctExternalDomainsLinkedTo: number } | null;
  documents: { total: number; duplicates: number; duplicateRate: number; languages: Share[]; topDomains: Share[] };
  warnings: string[];
}

const share = (entries: Array<[string, number]>, total: number, n: number): Share[] =>
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([key, count]) => ({ key, count, share: total === 0 ? 0 : round(count / total) }));
const round = (x: number): number => Math.round(x * 10000) / 10000;
const herfindahl = (counts: number[]): number => { const total = counts.reduce((a, b) => a + b, 0); return total === 0 ? 0 : round(counts.reduce((a, c) => a + (c / total) ** 2, 0)); };
const tableExists = (db: DatabaseSync, name: string): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;

export function analyzeFrontier(dbPath: string, options: { top?: number; model?: DomainModel } = {}): FrontierAnalysis {
  const db = new DatabaseSync(dbPath, { readOnly: true }); const top = options.top ?? 10; const model = options.model ?? new DomainModel();
  try {
    db.exec('PRAGMA query_only=ON;');
    const all = (sql: string) => db.prepare(sql).all() as unknown as Array<Record<string, number | string | null>>;
    const totals: Record<string, number> = {}; for (const r of all('SELECT state, COUNT(*) AS n FROM urls GROUP BY state')) totals[String(r.state)] = Number(r.n);
    const byHost = (state: string) => all(`SELECT host, COUNT(*) AS n FROM urls WHERE state='${state}' GROUP BY host`).map(r => [String(r.host), Number(r.n)] as [string, number]);
    const rollup = (rows: Array<[string, number]>, key: (host: string) => string): Array<[string, number]> => {
      const m = new Map<string, number>(); for (const [host, n] of rows) m.set(key(host), (m.get(key(host)) ?? 0) + n); return [...m.entries()];
    };
    const pendingHosts = byHost('PENDING'); const doneHosts = byHost('DONE');
    const pendingTotal = totals.PENDING ?? 0; const doneTotal = totals.DONE ?? 0;
    const pendingDomains = rollup(pendingHosts, h => model.domainOf(h)); const pendingFamilies = rollup(pendingHosts, h => model.familyOf(h)); const doneDomains = rollup(doneHosts, h => model.domainOf(h));
    const sortedDomains = [...pendingDomains].sort((a, b) => b[1] - a[1]); const cum = (n: number) => round(sortedDomains.slice(0, n).reduce((a, [, c]) => a + c, 0) / Math.max(1, pendingTotal));
    const allHosts = all('SELECT DISTINCT host FROM urls').map(r => String(r.host));
    const hh = herfindahl(pendingDomains.map(([, n]) => n)); const hhDone = herfindahl(doneDomains.map(([, n]) => n));

    const depth: Record<string, number> = {}; for (const r of all(`SELECT depth, COUNT(*) AS n FROM urls WHERE state='PENDING' GROUP BY depth ORDER BY depth`)) depth[String(r.depth)] = Number(r.n);
    const queues: Record<string, number> = {}; for (const r of all(`SELECT queue, COUNT(*) AS n FROM urls WHERE state='PENDING' GROUP BY queue`)) queues[String(r.queue)] = Number(r.n);
    const sourceInferred: Record<string, number> = {}; for (const r of all(`SELECT CASE WHEN queue='DEMAND' THEN 'demand' WHEN depth=0 THEN 'seed_or_redirect' ELSE 'discovered' END AS s, COUNT(*) AS n FROM urls GROUP BY s`)) sourceInferred[String(r.s)] = Number(r.n);
    const outcomes: Record<string, number> = {}; for (const r of all(`SELECT COALESCE(last_outcome,'NONE') AS o, COUNT(*) AS n FROM urls WHERE state<>'PENDING' OR attempts>0 GROUP BY o`)) outcomes[String(r.o)] = Number(r.n);
    const attempted = Object.values(outcomes).reduce((a, b) => a + b, 0); const failed = (totals.FAILED ?? 0) + (outcomes.FETCH_FAILED ?? 0) + (outcomes.HTTP_ERROR ?? 0) + (outcomes.ROBOTS_UNAVAILABLE ?? 0);

    let links: FrontierAnalysis['links'] = null;
    if (tableExists(db, 'links')) {
      let total = 0; let internalHost = 0; let internalDomain = 0; const externalTargets = new Set<string>();
      for (const r of all('SELECT src_host, dst_host, COUNT(*) AS n FROM links GROUP BY src_host, dst_host')) {
        const n = Number(r.n); total += n; const s = String(r.src_host); const d = String(r.dst_host);
        if (s === d) { internalHost += n; internalDomain += n; } else if (model.domainOf(s) === model.domainOf(d)) internalDomain += n; else externalTargets.add(model.domainOf(d));
      }
      links = { total, internalHost, internalDomain, externalDomain: total - internalDomain, externalDomainShare: total === 0 ? 0 : round((total - internalDomain) / total), distinctExternalDomainsLinkedTo: externalTargets.size };
    }
    const docTotal = tableExists(db, 'documents') ? Number((all('SELECT COUNT(*) AS n FROM documents')[0] as { n: number }).n) : 0;
    const dupes = tableExists(db, 'documents') ? Number((all('SELECT COUNT(*) AS n FROM documents WHERE duplicate_of IS NOT NULL')[0] as { n: number }).n) : 0;
    const languages = tableExists(db, 'documents') ? all(`SELECT COALESCE(NULLIF(language,''),'unknown') AS l, COUNT(*) AS n FROM documents GROUP BY l`).map(r => [String(r.l), Number(r.n)] as [string, number]) : [];
    const docDomains = tableExists(db, 'documents') ? rollup(all(`SELECT COALESCE(host,'') AS host, COUNT(*) AS n FROM documents GROUP BY host`).map(r => [String(r.host), Number(r.n)] as [string, number]), h => model.domainOf(h)) : [];

    const warnings: string[] = []; const topDomain = sortedDomains[0];
    if (pendingTotal > 0 && topDomain && topDomain[1] / pendingTotal >= 0.5) warnings.push(`one domain (${topDomain[0]}) holds ${Math.round(100 * topDomain[1] / pendingTotal)}% of the pending frontier`);
    if (pendingTotal > 0 && hh >= 0.25) warnings.push(`pending frontier is concentrated (Herfindahl index ${hh}; about ${round(1 / hh)} equally sized domains)`);
    if (links && links.total > 0 && links.externalDomainShare < 0.05) warnings.push(`only ${Math.round(100 * links.externalDomainShare)}% of stored links leave their domain: discovery of new domains is starved`);
    return {
      totals, hosts: allHosts.length, domains: new Set(allHosts.map(h => model.domainOf(h))).size, families: new Set(allHosts.map(h => model.familyOf(h))).size,
      pending: { total: pendingTotal, topHosts: share(pendingHosts, pendingTotal, top), topDomains: share(pendingDomains, pendingTotal, top), topFamilies: share(pendingFamilies, pendingTotal, top),
        top1DomainShare: cum(1), top5DomainShare: cum(5), top10DomainShare: cum(10), herfindahlDomains: hh, effectiveDomains: hh === 0 ? 0 : round(1 / hh) },
      done: { total: doneTotal, topDomains: share(doneDomains, doneTotal, top), herfindahlDomains: hhDone, effectiveDomains: hhDone === 0 ? 0 : round(1 / hhDone) },
      depth, sourceInferred, queues, outcomes, failureRate: attempted === 0 ? 0 : round(failed / attempted), links,
      documents: { total: docTotal, duplicates: dupes, duplicateRate: docTotal === 0 ? 0 : round(dupes / docTotal), languages: share(languages, docTotal, top), topDomains: share(docDomains, docTotal, top) },
      warnings,
    };
  } finally { db.close(); }
}

export function formatAnalysis(a: FrontierAnalysis): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`; const rows = (list: Share[]) => list.map(s => `    ${String(s.count).padStart(9)}  ${pct(s.share).padStart(6)}  ${s.key}`).join('\n') || '    (none)';
  const lines = [
    `Frontier: ${Object.entries(a.totals).map(([k, v]) => `${k}=${v}`).join(' ')}   hosts=${a.hosts} domains=${a.domains} families=${a.families}`,
    `Pending ${a.pending.total}: top domain ${pct(a.pending.top1DomainShare)}, top 5 ${pct(a.pending.top5DomainShare)}, top 10 ${pct(a.pending.top10DomainShare)}; Herfindahl ${a.pending.herfindahlDomains} (~${a.pending.effectiveDomains} effective domains)`,
    '  Top pending domains:', rows(a.pending.topDomains), '  Top pending hosts:', rows(a.pending.topHosts), '  Top pending families:', rows(a.pending.topFamilies),
    `Done ${a.done.total}: Herfindahl ${a.done.herfindahlDomains} (~${a.done.effectiveDomains} effective domains)`, '  Top done domains:', rows(a.done.topDomains),
    `Pending by depth: ${JSON.stringify(a.depth)}`, `Pending by queue: ${JSON.stringify(a.queues)}`, `Rows by inferred source (schema v3 stores none): ${JSON.stringify(a.sourceInferred)}`,
    `Last outcomes: ${JSON.stringify(a.outcomes)}  failure rate ${pct(a.failureRate)}`,
    a.links ? `Links stored ${a.links.total}: same host ${a.links.internalHost}, same domain ${a.links.internalDomain}, to other domains ${a.links.externalDomain} (${pct(a.links.externalDomainShare)}), ${a.links.distinctExternalDomainsLinkedTo} distinct other domains` : 'Links: no link table',
    `Documents ${a.documents.total}: duplicates ${a.documents.duplicates} (${pct(a.documents.duplicateRate)})`, '  Languages:', rows(a.documents.languages), '  Top document domains:', rows(a.documents.topDomains),
    ...(a.warnings.length ? ['Warnings:', ...a.warnings.map(w => `  - ${w}`)] : ['Warnings: none']),
  ];
  return lines.join('\n');
}
