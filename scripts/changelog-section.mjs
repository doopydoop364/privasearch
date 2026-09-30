// Prints the CHANGELOG.md section for a version (e.g. "0.1.0"); fails if it is missing or empty.
import { readFileSync } from 'node:fs';
const version = process.argv[2]?.replace(/^v/, '');
if (!version) throw new Error('Usage: changelog-section.mjs <version>');
const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/);
const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
let end = lines.findIndex((line, index) => index > start && line.startsWith('## ['));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) throw new Error(`CHANGELOG.md section for ${version} is empty`);
console.log(body);
