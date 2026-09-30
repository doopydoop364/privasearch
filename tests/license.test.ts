import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('licensing: Apache-2.0, the standard unedited text, declared in package.json and stated in the README', () => {
  const text = read('LICENSE');
  assert.match(text, /^\s+Apache License\r?\n\s+Version 2\.0, January 2004/); assert.match(text, /END OF TERMS AND CONDITIONS/);
  assert.match(text, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard appendix stays unfilled: the license text is not edited');
  assert.equal((JSON.parse(read('package.json')) as { license?: string }).license, 'Apache-2.0');
  assert.match(read('README.md'), /Apache License, Version 2\.0/); assert.match(read('README.md'), /keep their own licenses/);
  assert.match(read('.github/workflows/release.yml'), /cp LICENSE /, 'the release distribution carries the license text');
});
