import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Offline guard for how PrivaSearch consumes PrivaNet: public npm packages at one exact version, never a release-asset URL
// or a sibling `file:` link. It reads package.json and package-lock.json only, so it never depends on the network.
const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('@privanet packages are exact npm versions, and @privanet/shared is only a transitive dependency of the SDK', () => {
  const pkg = read('package.json'); const dependencies = pkg.dependencies as Record<string, string>;
  const privanet = Object.entries(dependencies).filter(([name]) => name.startsWith('@privanet/'));
  assert.deepEqual(privanet.map(([name]) => name).sort(), ['@privanet/protocol', '@privanet/sdk'], 'only what PrivaSearch imports is a direct dependency');
  for (const [name, spec] of privanet) assert.match(spec, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `${name} must be an exact registry version, not ${spec}`);
  assert.equal(new Set(privanet.map(([, spec]) => spec)).size, 1, 'protocol and sdk must be the same PrivaNet release');
});

test('the lockfile resolves every @privanet package from the npm registry at that version, as one matching set', () => {
  const pkg = read('package.json'); const lock = read('package-lock.json'); const version = (pkg.dependencies as Record<string, string>)['@privanet/sdk'];
  const entries = Object.entries(lock.packages as Record<string, { version: string; resolved?: string; dependencies?: Record<string, string> }>).filter(([path]) => /(^|\/)node_modules\/@privanet\//.test(path));
  assert.deepEqual(entries.map(([path]) => path).sort(), ['node_modules/@privanet/protocol', 'node_modules/@privanet/sdk', 'node_modules/@privanet/shared']);
  for (const [path, entry] of entries) {
    assert.equal(entry.version, version, path);
    assert.match(entry.resolved ?? '', /^https:\/\/registry\.npmjs\.org\/@privanet\/[a-z]+\/-\/[a-z]+-[^/]+\.tgz$/, `${path} must resolve from the npm registry`);
  }
  assert.doesNotMatch(JSON.stringify(lock), /github\.com\/[^"]*\/releases\/|"file:|"link": true/, 'no release-asset URL and no sibling link anywhere in the lockfile');
});
