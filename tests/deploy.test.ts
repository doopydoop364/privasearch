import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseServiceConfig } from '../src/service-config.js';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

test('the shipped environment example parses once its placeholders are replaced, and every setting it names exists', () => {
  const text = read('deploy/env/privasearch.env.example');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) { const m = /^#?\s*([A-Z][A-Z0-9_]+)=(.*)$/.exec(line); if (m?.[1] && m[2] !== undefined && /^(PRIVASEARCH|PRIVANET|NODE)_/.test(m[1]) && !line.startsWith('# ')) env[m[1]] = m[2]; }
  assert.ok(env.PRIVANET_COORDINATOR_URL && env.PRIVASEARCH_DISCOVERY_TEMPLATES);
  env.PRIVANET_DEMAND_TOKEN = 'a'.repeat(64); env.PRIVANET_PUBLIC_TOKEN = 'b'.repeat(64);
  const config = parseServiceConfig(env, 'https://seed.example/');
  assert.deepEqual([config.privanet?.coordinatorUrl, config.templates, config.host, config.port, config.concurrency], ['https://coordinator.example', ['https://en.wikipedia.org/wiki/{title}'], '127.0.0.1', 4020, 8]);
  // every optional tuning line (commented) is a setting the parser actually reads
  const source = read('src/service-config.ts') + read('src/main.ts'); // the seed file is read by the entry point
  for (const name of Object.keys(env)) if (name.startsWith('PRIVASEARCH_')) assert.ok(source.includes(name), `${name} is not read by the service`);
  // no real-looking credential is shipped
  assert.equal(/[a-f0-9]{64}/.test(text), false);
});

test('the systemd unit keeps secrets out, never restarts on a configuration error, stops gracefully, and is sandboxed', () => {
  const unit = read('deploy/systemd/privasearch.service');
  assert.match(unit, /^EnvironmentFile=\/etc\/privasearch\/privasearch\.env$/m); assert.match(unit, /^RestartPreventExitStatus=78$/m); assert.match(unit, /^User=privasearch$/m);
  assert.equal(/^Environment=.*(TOKEN|SECRET)/im.test(unit), false, 'no secret in the unit');
  for (const hardening of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'CapabilityBoundingSet=', 'ReadWritePaths=/var/lib/privasearch']) assert.ok(unit.includes(hardening), hardening);
  const stop = Number(/^TimeoutStopSec=(\d+)$/m.exec(unit)?.[1]); assert.ok(stop > 15, 'the stop timeout must exceed the default graceful-shutdown window (15 s)');
  assert.equal(parseServiceConfig({}).shutdownMs, 15000);
});

test('the seed example lists only admissible URLs', async () => {
  const { parseCrawlUrl } = await import('../src/url.js');
  const seeds = read('deploy/seeds.example.txt').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')); assert.ok(seeds.length >= 1);
  for (const seed of seeds) assert.equal(parseCrawlUrl(seed).ok, true, seed);
});
