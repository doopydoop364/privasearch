import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { DocumentStore } from '../src/documents.js';
import type { DocumentInput } from '../src/documents.js';
import { Searcher, STRONG_SCORE, variantKey } from '../src/ranking.js';
import { urlKey } from '../src/url.js';

const NOW = Date.UTC(2031, 0, 1); const DAY = 86400000;
let counter = 0;
const doc = (url: string, title: string, text: string, extra: Partial<DocumentInput> = {}): DocumentInput =>
  ({ urlKey: urlKey(url), url, finalUrl: url, title, description: '', canonicalUrl: null, language: 'en', text, contentSha256: (++counter).toString(16).padStart(64, '0'), fetchedAt: NOW, httpStatus: 200, ...extra });
const setup = () => { const documents = new DocumentStore(openDatabase(':memory:')); return { documents, searcher: new Searcher(documents, () => NOW) }; };
const urls = (r: { hits: Array<{ url: string }> }) => r.hits.map(h => h.url);

test('a title match outranks a body match, and a URL match helps', () => {
  const { documents, searcher } = setup();
  documents.upsert(doc('https://a.example/one', 'Gardening basics', 'Everything about compost and soil, with one mention of tomato.'));
  documents.upsert(doc('https://b.example/two', 'Tomato growing guide', 'Seeds and sunlight.'));
  documents.upsert(doc('https://tomato.example/three', 'Plants', 'A page about plants and tomato care.'));
  const result = searcher.search('tomato');
  assert.equal(urls(result)[0], 'https://b.example/two'); // title
  assert.ok(result.hits[0] && result.hits[0].signals.titleMatch && !result.hits[0].signals.urlMatch);
  assert.equal(result.hits.find(h => h.url === 'https://tomato.example/three')?.signals.urlMatch, true);
  assert.ok((result.hits.find(h => h.url === 'https://tomato.example/three')?.score ?? 0) > (result.hits.find(h => h.url === 'https://a.example/one')?.score ?? 0)); // host match beats a lone body mention
});

test('an exact phrase beats the same words scattered', () => {
  const { documents, searcher } = setup();
  documents.upsert(doc('https://a.example/1', 'Notes', 'The rust programming language has a borrow checker.'));
  documents.upsert(doc('https://b.example/1', 'Notes', 'Programming in many a language; the rust on the old gate is a different matter.'));
  const result = searcher.search('rust programming language');
  assert.deepEqual(urls(result), ['https://a.example/1', 'https://b.example/1']);
  assert.deepEqual(result.hits.map(h => h.signals.phraseMatch), [true, false]);
});

test('partial matches fill out thin results but rank below full matches and are not "strong"', () => {
  const { documents, searcher } = setup();
  documents.upsert(doc('https://full.example/1', 'Alpine hiking routes', 'Hiking routes in the Alps, with huts.'));
  documents.upsert(doc('https://half.example/1', 'Alpine flowers', 'Flowers that grow above the treeline.'));
  const result = searcher.search('alpine hiking routes');
  assert.deepEqual(urls(result), ['https://full.example/1', 'https://half.example/1']);
  assert.deepEqual(result.hits.map(h => [h.signals.matchedTerms, h.signals.totalTerms]), [[3, 3], [1, 3]]);
  assert.equal(result.strong, 1); assert.ok((result.hits[1]?.score ?? 99) < STRONG_SCORE);
});

test('freshness and inbound links from other hosts break ties between otherwise equal pages', () => {
  const { documents, searcher } = setup();
  const same = 'Notes on the migration of the harbour porpoise in coastal waters';
  documents.upsert(doc('https://old.example/p', 'Porpoise notes', same, { fetchedAt: NOW - 900 * DAY, contentSha256: 'a'.repeat(64) }));
  documents.upsert(doc('https://new.example/p', 'Porpoise notes', same + ' ', { fetchedAt: NOW - 2 * DAY, contentSha256: 'b'.repeat(64) }));
  const fresh = searcher.search('porpoise'); assert.equal(urls(fresh)[0], 'https://new.example/p');
  assert.ok((fresh.hits[0]?.signals.freshness ?? 0) > (fresh.hits[1]?.signals.freshness ?? 1));
  // links from a few hosts are worth less than the freshness gap, but a well-linked page overtakes the fresh one
  for (const host of ['x1', 'x2', 'x3'].map(h => `${h}.example`)) documents.setLinks(urlKey(`https://${host}/`), host, [{ key: urlKey('https://old.example/p'), url: 'https://old.example/p', host: 'old.example' }]);
  assert.equal(urls(searcher.search('porpoise'))[0], 'https://new.example/p');
  for (const host of Array.from({ length: 12 }, (_, i) => `y${i}.example`)) documents.setLinks(urlKey(`https://${host}/`), host, [{ key: urlKey('https://old.example/p'), url: 'https://old.example/p', host: 'old.example' }]);
  documents.setLinks(urlKey('https://old.example/q'), 'old.example', [{ key: urlKey('https://old.example/p'), url: 'https://old.example/p', host: 'old.example' }]); // its own site does not count
  const linked = searcher.search('porpoise'); assert.equal(urls(linked)[0], 'https://old.example/p'); assert.equal(linked.hits[0]?.signals.inboundHosts, 15);
});

test('the same page under trivial URL variants or a canonical URL is one result', () => {
  const { documents, searcher } = setup();
  documents.upsert(doc('https://www.v.example/page/', 'Variant page', 'zebra crossing history'));
  documents.upsert(doc('http://v.example/page', 'Variant page', 'zebra crossing history, with an extra line'));
  documents.upsert(doc('https://c.example/a?ref=x', 'Canon page', 'giraffe neck', { canonicalUrl: 'https://c.example/a' }));
  documents.upsert(doc('https://c.example/a', 'Canon page', 'giraffe neck length'));
  assert.equal(searcher.search('zebra').total, 1); assert.equal(urls(searcher.search('zebra'))[0], 'https://www.v.example/page/'.replace('www.', 'www.')); // https wins the tie
  assert.deepEqual(urls(searcher.search('giraffe')), ['https://c.example/a']);
  assert.equal(variantKey('https://www.v.example/page/'), variantKey('http://v.example/page'));
});

test('one site cannot fill the page: its n-th result is discounted', () => {
  const { documents, searcher } = setup();
  for (let i = 0; i < 5; i++) documents.upsert(doc(`https://big.example/${i}`, 'Kayak routes', `Kayak routes number ${i} on the river.`));
  documents.upsert(doc('https://small.example/k', 'Kayak routes', 'Kayak routes on the river, a single page.'));
  const hosts = searcher.search('kayak routes').hits.map(h => h.host);
  assert.ok(hosts.indexOf('small.example') <= 2, `the other site should appear early, got ${hosts.join(',')}`);
});

test('ranking is deterministic and pagination is consistent: pages tile the ranked list without gaps or overlap', () => {
  const { documents, searcher } = setup();
  for (let i = 0; i < 25; i++) documents.upsert(doc(`https://h${i}.example/p`, i % 2 ? 'Mango recipes' : 'Recipes', `mango dessert number ${i}`));
  const a = searcher.search('mango', { limit: 100 }); const b = searcher.search('mango', { limit: 100 });
  assert.deepEqual(a.hits, b.hits); assert.equal(a.total, 25);
  const pages = [0, 10, 20].flatMap(offset => urls(searcher.search('mango', { limit: 10, offset })));
  assert.deepEqual(pages, urls(a)); assert.equal(new Set(pages).size, 25);
  assert.equal(searcher.search('mango', { limit: 10, offset: 20 }).hits.length, 5); assert.equal(searcher.search('mango', { limit: 10, offset: 500 }).hits.length, 0);
  assert.equal(searcher.search('mango', { limit: 9999 }).limit, 50); // bounded
});

test('snippets come from the text around the match, are bounded and plain, and hostile markup stays inert text', () => {
  const { documents, searcher } = setup();
  const filler = 'lorem ipsum '.repeat(60);
  documents.upsert(doc('https://s.example/1', 'Long page', `${filler}the needle is here <script>alert(1)</script>\u0000\u0007 and then ${filler}`));
  const hit = searcher.search('needle').hits[0]; assert.ok(hit);
  assert.ok(hit.snippet.includes('needle') && hit.snippet.length <= 260);
  assert.equal(/[\u0000-\u001f]/.test(hit.snippet), false); // eslint-disable-line no-control-regex
  assert.ok(hit.snippet.includes('<script>')); // data, never interpreted; consumers escape it
  const bare = setup(); bare.documents.upsert(doc('https://s.example/2', '', 'nothing but a nameless page about quasars')); assert.equal(bare.searcher.search('quasars').hits[0]?.title, 's.example/2'); // an untitled page falls back to its address
});

test('queries are normalised: case, punctuation, diacritics; nothing searchable yields an empty result, never an error', () => {
  const { documents, searcher } = setup();
  documents.upsert(doc('https://d.example/1', 'Café guide', 'The best cafe in town, naïve opinions included.'));
  assert.equal(searcher.search('CAFÉ!!').total, 1); assert.equal(searcher.search('naive').total, 1);
  for (const q of ['', '   ', '!!! ??? ***', '"" OR NEAR(']) assert.deepEqual([searcher.search(q).total, searcher.search(q).terms === 0 || searcher.search(q).total === 0], [0, true]);
  assert.equal(searcher.search('cafe OR title:evil* NEAR').total >= 0, true); // operators are inert text
});
