import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface Identity { product: string; infoUrl: string }
export interface CoreRig {
  url: string; tokens: { DEMAND: string; PUBLIC: string }; identity: Identity; logs: string[];
  /** Every PrivaNode log line, so metrics such as fetch outcomes can be read back. */
  stop(): Promise<void>;
}

async function unusedPort(): Promise<number> {
  const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port; await new Promise<void>(r => s.close(() => r())); return port;
}
async function until(child: ChildProcess, logs: string[], event: string, ms = 15000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const check = () => { if (logs.join('').includes(`"event":"${event}"`)) { clearTimeout(deadline); resolve(); } };
    child.once('exit', () => { clearTimeout(deadline); reject(new Error(`process exited before ${event}`)); });
    child.stdout?.on('data', check); check();
  });
}

/**
 * A black-box PrivaNet: the real Coordinator and a real authenticated PrivaNode, run as separate processes from a
 * built PrivaNet-Core checkout. PrivaSearch touches it only through @privanet/sdk and the admin CLI, exactly as an
 * operator would; no Core internals are imported.
 *
 * `hostMap` is the node OWNER's local policy (name → address) so the fetch capability can reach a local test site
 * without weakening SSRF protection for anything else; in production it does not exist.
 */
export async function startCore(coreDir: string, options: { identity?: Identity; hostMap?: Record<string, string>; minHostDelayMs?: number } = {}): Promise<CoreRig> {
  const dir = await mkdtemp(join(tmpdir(), 'privasearch-core-')); const logs: string[] = []; const children: ChildProcess[] = [];
  const port = await unusedPort(); const url = `http://127.0.0.1:${port}`;
  const identity = options.identity ?? { product: 'PrivaSearchBot', infoUrl: 'https://privasearch.example/bot' };
  const policy = join(dir, 'policy.json');
  await writeFile(policy, JSON.stringify({
    reserveMemoryBytes: 0, safetyMarginBytes: 0, maxMemoryBytes: 1024 ** 3, maxCpuPercent: 100, reserveCpuPercent: 0, onBattery: 'normal',
    fetch: { minHostDelayMs: options.minHostDelayMs ?? 0, maxRequestsPerMinute: 6000, ...(options.hostMap ? { unsafeLocal: { allowedCidrs: ['127.0.0.0/8'], allowedPorts: [], hostMap: options.hostMap } } : {}) },
  }));
  const admin = randomBytes(32).toString('hex');
  const env: NodeJS.ProcessEnv = { ...process.env, PRIVANET_ADMIN_SECRET: admin, PRIVANET_COORDINATOR_URL: url, PRIVANET_HOST: '127.0.0.1', PRIVANET_PORT: String(port),
    PRIVANET_DATA_DIR: join(dir, 'coordinator'), PRIVANET_LEASE_MS: '30000', PRIVANET_MAINTENANCE_MS: '200', PRIVANET_MAX_PENDING_PER_APP: '100000',
    PRIVANODE_COORDINATOR_URL: url, PRIVANODE_STATE_DIR: join(dir, 'node'), PRIVANODE_ALLOW_INSECURE_LOOPBACK: 'true', PRIVANODE_CAPABILITIES: 'web.fetch.v1',
    PRIVANODE_POLICY_FILE: policy, PRIVANODE_HEARTBEAT_MS: '1000', PRIVANODE_POLL_MS: '50' };
  const start = async (script: string, extra: NodeJS.ProcessEnv, event: string) => {
    const child = spawn(process.execPath, [join(coreDir, script)], { cwd: coreDir, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.stdout?.on('data', (c: Buffer) => logs.push(c.toString())); child.stderr?.on('data', (c: Buffer) => logs.push(c.toString()));
    await until(child, logs, event); return child;
  };
  const stop = async () => {
    for (const child of children) if (child.exitCode === null) await new Promise<void>(resolve => { const t = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('close', () => { clearTimeout(t); resolve(); }); child.kill('SIGTERM'); });
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
  try {
    await start('apps/coordinator/dist/main.js', {}, 'coordinator.started');
    const tool = async (args: string[], extra: NodeJS.ProcessEnv = {}) => JSON.parse((await exec(process.execPath, [join(coreDir, 'scripts/admin.mjs'), ...args], { cwd: coreDir, env: { ...env, ...extra }, timeout: 20000 })).stdout) as { token: string };
    const app = (name: string) => tool(['application', name], { PRIVANET_JOB_TYPES: 'web.fetch.v1', PRIVANET_FETCH_PRODUCT: identity.product, PRIVANET_FETCH_INFO_URL: identity.infoUrl });
    const demand = await app('privasearch-demand'); const pub = await app('privasearch-public');
    const grant = await tool(['enrollment'], { PRIVANET_JOB_TYPES: 'web.fetch.v1' });
    await start('apps/node/dist/main.js', { PRIVANODE_ENROLLMENT_TOKEN: grant.token }, 'node.enrolled');
    return { url, tokens: { DEMAND: demand.token, PUBLIC: pub.token }, identity, logs, stop };
  } catch (error) { await stop(); throw error; }
}

/** A local site for the crawl, addressed by name through the node owner's hostMap. It must listen on port 80 because PrivaSearch only crawls default ports. */
export interface Site { requests: Array<{ host: string; path: string; ua: string }>; close(): Promise<void> }
export async function startSite(pages: (host: string, path: string) => { status?: number; type?: string; body: string; headers?: Record<string, string> } | undefined): Promise<Site> {
  const requests: Site['requests'] = [];
  const server: Server = createServer((req, res) => {
    const host = (req.headers.host ?? '').toLowerCase(); const path = req.url ?? '/';
    requests.push({ host, path, ua: String(req.headers['user-agent'] ?? '') });
    const page = pages(host, path);
    if (!page) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(page.status ?? 200, { 'Content-Type': page.type ?? 'text/html; charset=utf-8', ...(page.headers ?? {}) }); res.end(page.body);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(80, '127.0.0.1', resolve); });
  return { requests, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
export async function canBindPort80(): Promise<boolean> {
  try { const s = await startSite(() => undefined); await s.close(); return true; } catch { return false; }
}
