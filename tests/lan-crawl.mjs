// Manual experiment (docs/measurements.md, experiment 9): PrivaSearch running on the DESKTOP host of a LAN deployment, crawling through the
// server's Coordinator over TLS, with the Coordinator killed and restarted mid-crawl. Linux and root. Needs a built PrivaNet-Core checkout
// (PRIVANET_CORE_DIR, v0.3.0-alpha.5 or newer, `npm run build`) for its network-namespace rig, and `npm run build` here.
//   sudo -E PRIVANET_CORE_DIR=../PrivaNet-Core node tests/lan-crawl.mjs
// PrivaSearch touches PrivaNet only through the SDK, exactly as in production; the rig only supplies hosts, TLS and firewalls.
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const core = resolve(process.env.PRIVANET_CORE_DIR ?? '../PrivaNet-Core');
const { startLan, eventually, sleep } = await import(pathToFileURL(join(core, 'tests', 'dist', 'netns-rig.js')).href);
const PAGES = Number(process.env.LAN_PAGES ?? 600); const HOSTS = 8;
const hostNames = Array.from({ length: HOSTS }, (_, i) => `h${i}.example`);

const lan = await startLan({ leaseMs: 5000, staleMs: 2500, offlineMs: 8000 });
try {
  // A small website on the "web" host: page N of each of eight names links to pages 2N+1 and 2N+2, so the frontier has something to discover.
  const siteFile = join(lan.dir, 'site.mjs');
  writeFileSync(siteFile, `import { createServer } from 'node:http'; import { setTimeout } from 'node:timers';
const pages = Number(process.env.SITE_PAGES), delay = Number(process.env.SITE_DELAY_MS);
createServer((req, res) => {
  if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
  const n = Number(/^\\/p\\/(\\d+)$/.exec(req.url ?? '')?.[1] ?? 'NaN'); if (!(n >= 0 && n < pages)) { res.writeHead(404); res.end(); return; }
  const host = req.headers.host; const links = [2 * n + 1, 2 * n + 2].filter(m => m < pages).map(m => '<a href="http://' + host + '/p/' + m + '">next ' + m + '</a>').join(' ');
  setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><head><title>Page ' + n + ' of ' + host + '</title></head><body><p>' + 'lorem ipsum '.repeat(40) + links + '</p></body></html>'); }, delay);
}).listen(8080, '0.0.0.0', () => console.log('{"event":"site.started"}'));`);
  const siteLogs = []; lan.web.spawn(process.execPath, [siteFile], { SITE_PAGES: String(PAGES), SITE_DELAY_MS: '150' }, siteLogs);
  await eventually('site', () => siteLogs.join('').includes('site.started') || undefined);

  const identity = { PRIVANET_FETCH_PRODUCT: 'PrivaSearchBot', PRIVANET_FETCH_INFO_URL: 'https://privasearch.example/bot' };
  const demand = await lan.application('privasearch-demand', 'web.fetch.v1', identity); const pub = await lan.application('privasearch-public', 'web.fetch.v1', identity);

  // The shipped example policies, reserves zeroed so a busy test machine never pauses a node, politeness off for our own synthetic site.
  const policies = {};
  for (const name of ['server-node', 'desktop-node']) {
    const p = JSON.parse(readFileSync(join(core, 'deploy', 'policy', `${name}.json`), 'utf8'));
    policies[name] = { ...p, reserveMemoryBytes: 0, safetyMarginBytes: 0, reserveCpuPercent: 0, reserveDiskBytes: 0,
      fetch: { minHostDelayMs: 0, maxRequestsPerMinute: 6000, unsafeLocal: { allowedCidrs: ['10.77.0.0/24'], allowedPorts: [8080], hostMap: Object.fromEntries(hostNames.map(h => [h, '10.77.0.3'])) } } };
  }
  const nodeLogs = {};
  for (const [name, host, policy, slots] of [['srv', lan.server, 'server-node', 8], ['dsk', lan.desktop, 'desktop-node', 24]]) {
    const file = join(lan.dir, `${name}.policy.json`); writeFileSync(file, JSON.stringify(policies[policy])); nodeLogs[name] = [];
    host.spawn(join(lan.release, 'bin', 'privanet-node'), [], lan.nodeEnv(name, { PRIVANODE_CAPABILITIES: 'web.fetch.v1', PRIVANODE_POLICY_FILE: file, PRIVANODE_JOB_SLOTS: String(slots),
      PRIVANODE_ENROLLMENT_TOKEN: await lan.enrollment('web.fetch.v1') }), nodeLogs[name]);
  }
  await eventually('both nodes online', async () => (await lan.nodeViews()).filter(v => v.status === 'ONLINE').length === 2 || undefined, 60000);

  // PrivaSearch on the desktop: the crawl command, configured only through environment variables, reaching the server through https://<server>.
  const crawlLogs = []; const db = join(lan.dir, 'privasearch.sqlite');
  const crawl = lan.desktop.spawn(process.execPath, [resolve('dist', 'src', 'crawl.js'), ...hostNames.map(h => `http://${h}:8080/p/0`)], {
    PRIVANET_COORDINATOR_URL: lan.url, NODE_EXTRA_CA_CERTS: lan.caCert, PRIVANET_DEMAND_TOKEN: demand.token, PRIVANET_PUBLIC_TOKEN: pub.token,
    PRIVASEARCH_DB: db, PRIVASEARCH_CONCURRENCY: '32', PRIVASEARCH_WAIT_TIMEOUT_MS: '120000', PRIVASEARCH_POLL_MS: '100' }, crawlLogs);
  const started = Date.now(); let exited = false; crawl.once('close', () => { exited = true; });
  const docs = () => { try { const d = new DatabaseSync(db, { readOnly: true }); try { return Number(d.prepare('SELECT COUNT(*) AS n FROM documents').get().n); } finally { d.close(); } } catch { return -1; } };
  await sleep(20000); const before = docs(); const tKill = Date.now();
  await lan.stopCoordinator('SIGKILL'); await sleep(6000); await lan.startCoordinator(); const tBack = Date.now();
  let lastDocs = before, afterFirst;
  while (!exited && Date.now() - started < Number(process.env.LAN_TIMEOUT_S ?? 600) * 1000) { await sleep(1000); const d = docs(); if (afterFirst === undefined && d > before) afterFirst = Date.now(); lastDocs = d; }
  if (process.env.LAN_DEBUG) { const tail = (l) => l.join('').trim().split('\n').slice(-6).join('\n'); console.error('CRAWL LOG\n' + tail(crawlLogs) + '\nDESKTOP NODE\n' + tail(nodeLogs.dsk) + '\nSERVER NODE\n' + tail(nodeLogs.srv) + '\nCOORDINATOR\n' + tail(lan.coordinatorLogs)); }
  const summaryLine = crawlLogs.join('').split('\n').filter(l => l.includes('crawl.stopped')).pop();
  console.log(JSON.stringify({ pagesAvailable: PAGES * HOSTS, documentsIndexedBeforeOutage: before, documentsIndexedAtEnd: lastDocs, outageSeconds: (tBack - tKill) / 1000,
    firstNewDocumentAfterRestartSeconds: afterFirst ? (afterFirst - tBack) / 1000 : null, totalSeconds: (Date.now() - started) / 1000, crawlExited: exited, summary: summaryLine ? JSON.parse(summaryLine) : null,
    desktopNodeCompleted: nodeLogs.dsk.join('').split('"event":"job.completed"').length - 1, serverNodeCompleted: nodeLogs.srv.join('').split('"event":"job.completed"').length - 1 }, null, 2));
} finally { await lan.stop(); }
