import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseLinks } from '../src/driver.js';
import type { LinkCandidate } from '../src/driver.js';
import { languagePreferred, looksLikeSoft404, looksThin, lowValueUrl, urlLanguageHint } from '../src/language.js';
import { DEFAULT_POLICY, resolvePolicy } from '../src/policy-options.js';
import { Searcher } from '../src/ranking.js';
import { domainWeight, pathShares, priorityOf, words } from '../src/scoring.js';
import { outcomeResult, pageResult } from '../src/privanet/fake-transport.js';
import { rig } from './helpers.js';
import { simulate } from './sim/simulate.js';

const never = () => { throw new Error('no fetch expected'); };
const wikiSeed = ['https://en.wiki.test/wiki/Main_Page'];

test('synthetic web, one giant multi-edition site: no site takes the crawl, independent sites are found at once (measured against 95.9% before)', async () => {
  const m = await simulate({ fetches: 500, seeds: wikiSeed });
  assert.ok(m.topSiteShare < 0.5, `top site share ${m.topSiteShare}`); assert.ok(m.giantShareFirst100 < 0.5);
  assert.ok(m.independentSites >= 8); assert.ok((m.firstIndependentFetch ?? 99) <= 5, `first independent fetch at ${m.firstIndependentFetch}`);
  assert.ok(m.pendingTotal < 5000);
});

test('with every language allowed and a second giant site, the two giants together stay a minority and the scheduler is deterministic', async () => {
  const options = { fetches: 500, seeds: [...wikiSeed, 'https://mega.test/item/1'], frontier: { preferredLanguages: ['*'] } };
  const a = await simulate(options); const b = await simulate(options);
  assert.deepEqual(a.siteCounts, b.siteCounts); assert.deepEqual(a.hostCounts, b.hostCounts); // same inputs, same crawl, bit for bit
  assert.ok(a.topSiteShare < 0.35, `top site ${a.topSite} ${a.topSiteShare}`); assert.ok(a.giantShareFirst100 < 0.5);
  assert.ok(a.pendingTopShare < 0.7); assert.ok(a.independentSites >= 8);
});

test('pipelined like the service (8 in flight, 2 s per fetch, a lease attempt every 25 ms) the giants still do not crowd out single-host independent sites', async () => {
  const m = await simulate({ fetches: 400, seeds: [...wikiSeed, 'https://mega.test/item/1'], frontier: { preferredLanguages: ['*'] }, tickMs: 25, latencyMs: 2000, concurrency: 8 });
  assert.ok(m.topSiteShare < 0.4, `top ${m.topSite} ${m.topSiteShare}`); assert.ok((m.siteCounts['official.test'] ?? 0) >= 15); assert.ok((m.siteCounts['docs.test'] ?? 0) >= 15);
});

test('a search for the query schedules demand work from the wiki hit, which jumps the queue without letting the wiki take over', async () => {
  const m = await simulate({ fetches: 300, seeds: wikiSeed, query: 'chatgpt', demandAfter: 2 });
  assert.ok(m.topSiteShare < 0.5); assert.ok(m.independentSites >= 8);
});

test('the domain, not the host, is the unit of scheduling: 30 language hosts of one domain get what one single-host domain gets', () => {
  const r = rig(never, { hostDelayMs: 0, preferredLanguages: ['*'], domainConcurrency: 64, familyConcurrency: 64 });
  const langs = ['de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'zh', 'ar', 'sv', 'uk', 'ca', 'fa', 'no', 'ko', 'fi', 'hu', 'id', 'cs', 'tr', 'ro', 'vi', 'he', 'da', 'bg', 'el', 'sr', 'hr'];
  for (const l of langs) for (let i = 0; i < 20; i++) r.frontier.add(`https://${l}.big.org/wiki/${i}`, { queue: 'PUBLIC', priority: 44, depth: 1, source: 'discovered' }, r.time.now);
  for (let i = 0; i < 20; i++) r.frontier.add(`https://small.net/p/${i}`, { queue: 'PUBLIC', priority: 44, depth: 1, source: 'discovered' }, r.time.now);
  const got: string[] = [];
  for (let round = 0; round < 20; round++) { for (const l of r.frontier.lease(r.time.now, 2)) { got.push(l.host.endsWith('big.org') ? 'big' : 'small'); r.frontier.complete(l.urlKey, pageResult(l.url, r.time.now, { title: 't', text: 'x'.repeat(50 + got.length) }), r.time.now); } r.advance(10); }
  const share = got.filter(g => g === 'big').length / got.length; assert.ok(share > 0.35 && share < 0.65, `big.org share ${share}`); // 600 pending vs 20: equal turns (the 20 small pages last exactly this long)
});

test('saturation is gradual: weight halves at saturationPages, never reaches zero; yield below neutral backs off and decays back', () => {
  const weight = (done: number, yieldValue = 0.5, age = 0) => domainWeight({ done, yield: yieldValue, yield_at: 1000, ref_domains: 0 }, 1000 + age, DEFAULT_POLICY);
  assert.equal(weight(0).saturation, 1); assert.ok(Math.abs(weight(200).saturation - 0.5) < 1e-9);
  assert.ok(weight(50).saturation > weight(100).saturation && weight(100).saturation > weight(400).saturation); assert.equal(weight(10_000_000).saturation, DEFAULT_POLICY.minWeight);
  assert.ok(weight(10, 0.05).weight < weight(10, 0.5).weight && weight(10, 0.95).weight > weight(10, 0.5).weight);
  const day = 86400000; assert.ok(weight(10, 0.05, 30 * day).weight > weight(10, 0.05, 0).weight); assert.ok(Math.abs(weight(10, 0.05, 365 * day).yieldEff - 0.5) < 0.001); // the verdict fades
  const farm = (n: number) => domainWeight({ done: 0, yield: 0.5, yield_at: 0, ref_domains: n }, 0, DEFAULT_POLICY).weight;
  assert.ok(farm(3) > farm(0)); assert.ok(farm(1_000_000) <= farm(15) * 1.0001); // authority from independent domains is capped: a link farm gains nothing past 15
});

test('priority is a decomposable sum with named parts; demand and seeds are fixed', () => {
  const base = { source: 'discovered' as const, depth: 2, external: false, relevant: false, languageHintAllowed: true, hasQuery: false };
  assert.deepEqual(priorityOf(base), { total: 38, base: 38, external: 0, relevance: 0, language: 0, query: 0 });
  const rich = priorityOf({ ...base, external: true, relevant: true, languageHintAllowed: false, hasQuery: true });
  assert.equal(rich.total, 38 + 12 + 6 - 20 - 6); assert.equal(rich.external, 12); assert.equal(rich.language, -20);
  assert.equal(priorityOf({ ...base, source: 'demand' }).total, 100); assert.equal(priorityOf({ ...base, source: 'seed' }).total, 60); assert.equal(priorityOf({ ...base, depth: 0, external: true, relevant: true }).total, 68);
  assert.equal(priorityOf({ ...base, depth: 0, external: true, relevant: true }, { ...DEFAULT_POLICY, externalBonus: 50, relevanceBonus: 50 }).total, 99); // clamped below demand
});

test('explicit demand is served before a saturated, low-yield domain regardless of its size, and still obeys the domain concurrency cap', () => {
  const r = rig(never, { hostDelayMs: 5000, domainConcurrency: 1, preferredLanguages: ['*'] });
  for (let i = 0; i < 50; i++) r.frontier.add(`https://big.example.org/p/${i}`, { queue: 'PUBLIC', priority: 44, depth: 1, source: 'discovered' }, r.time.now);
  r.db.prepare(`UPDATE domains SET done = 100000, yield = 0.0, yield_at = ? WHERE domain='example.org'`).run(r.time.now);
  r.frontier.add('https://other.example.org/asked', { queue: 'DEMAND', priority: 100, source: 'demand' }, r.time.now);
  const first = r.frontier.lease(r.time.now, 4); assert.equal(first[0]?.url, 'https://other.example.org/asked'); assert.equal(first.length, 1, 'one in flight per domain: big.example.org waits'); // domainConcurrency 1
  r.frontier.complete(first[0]!.urlKey, pageResult(first[0]!.url, r.time.now, { title: 't' }), r.time.now);
  const next = r.frontier.lease(r.time.now, 4); assert.deepEqual(next.map(l => l.host), ['big.example.org']); // the saturated domain is served after demand, not instead of it; demand's own host is still in its delay
});

test('domain concurrency: the second host of a domain is not leased while the first is in flight (cap 1); family cap spans domains', () => {
  const r = rig(never, { hostDelayMs: 0, domainConcurrency: 1, familyConcurrency: 1, families: { fam: ['one.org', 'two.org'] }, preferredLanguages: ['*'] });
  r.frontier.add('https://a.one.org/x', { queue: 'PUBLIC', priority: 40, source: 'discovered', depth: 1 }, r.time.now); r.frontier.add('https://b.one.org/x', { queue: 'PUBLIC', priority: 40, source: 'discovered', depth: 1 }, r.time.now);
  r.frontier.add('https://c.two.org/x', { queue: 'PUBLIC', priority: 40, source: 'discovered', depth: 1 }, r.time.now); r.frontier.add('https://solo.net/x', { queue: 'PUBLIC', priority: 40, source: 'discovered', depth: 1 }, r.time.now);
  const hosts = r.frontier.lease(r.time.now, 10).map(l => l.host); assert.equal(hosts.length, 2); assert.ok(hosts.includes('solo.net')); assert.ok(hosts.some(h => h.endsWith('one.org') || h.endsWith('two.org')));
});

test('admission reasons: every refusal is named, counted, and writes nothing', () => {
  const r = rig(never, { maxPendingPerDomain: 3, maxPendingPerFamily: 5, maxPendingTotal: 9, maxUrlsPerHost: 2, maxDepth: 3, families: { fam: ['f1.org', 'f2.org'] }, preferredLanguages: ['en'], languageMode: 'filter' });
  const add = (url: string, depth = 1) => r.frontier.add(url, { queue: 'PUBLIC', depth, source: 'discovered' }, r.time.now);
  assert.equal(add('https://a.org/1'), 'ADDED'); assert.equal(add('https://a.org/1'), 'EXISTS'); assert.equal(add('https://a.org/deep', 4), 'TOO_DEEP'); assert.equal(add('ftp://a.org/x'), 'SCHEME');
  assert.equal(add('https://a.org/logo.png'), 'LOW_VALUE'); assert.equal(add('https://a.org/w?action=edit'), 'LOW_VALUE'); assert.equal(add('https://de.a.org/x'), 'LANGUAGE_FILTERED'); assert.equal(add('https://a.org/de/x'), 'LANGUAGE_FILTERED');
  assert.equal(add('https://a.org/calendar/2020/05/01'), 'TRAP:CALENDAR');
  assert.equal(add('https://a.org/2'), 'ADDED'); assert.equal(add('https://a.org/3'), 'HOST_BUDGET'); // two URLs per host
  assert.equal(add('https://b.a.org/1'), 'ADDED'); assert.equal(add('https://c.a.org/1'), 'DOMAIN_BUDGET'); // three pending in a.org
  for (const u of ['https://x.f1.org/1', 'https://y.f1.org/1']) assert.equal(add(u), 'ADDED'); // f1: 2 of family 5
  assert.equal(add('https://z.f1.org/1'), 'ADDED'); assert.equal(add('https://q.f2.org/1'), 'ADDED'); assert.equal(add('https://q.f2.org/2'), 'ADDED'); // a domain may hold 3; family now 5
  assert.equal(add('https://w.f2.org/1'), 'FAMILY_BUDGET');
  for (const u of ['https://g1.net/', 'https://g2.net/', 'https://g3.net/']) add(u); assert.equal(add('https://g4.net/'), 'GLOBAL_BUDGET');
  const a = r.frontier.admission; assert.deepEqual([a.EXISTS, a.TOO_DEEP, a.REJECTED_URL, a.LOW_VALUE, a.LANGUAGE_FILTERED, a.TRAP, a.HOST_BUDGET, a.DOMAIN_BUDGET, a.FAMILY_BUDGET, a.GLOBAL_BUDGET], [1, 1, 1, 2, 2, 1, 1, 1, 1, 3]); // eight pending when g1 arrives, so g1 fills the last slot and g2..g4 are refused
  assert.equal(r.frontier.getByUrl('https://a.org/logo.png'), undefined); assert.equal(r.frontier.getByUrl('https://g4.net/'), undefined);
  // seeds, redirects and demand are never judged by budgets, language or low-value rules
  assert.equal(r.frontier.add('https://de.a.org/seed.png', { queue: 'PUBLIC', source: 'seed' }, r.time.now), 'ADDED'); assert.equal(r.frontier.add('https://a.org/asked', { queue: 'DEMAND', source: 'demand' }, r.time.now), 'ADDED');
});

test('deprioritize mode (the default) never refuses a hinted URL, it ranks it lower; page language decides what a fetched foreign page may open', () => {
  const r = rig(never, {});
  assert.equal(r.frontier.add('https://de.example.org/x', { queue: 'PUBLIC', depth: 1, source: 'discovered' }, r.time.now), 'ADDED');
  assert.equal(r.frontier.getByUrl('https://de.example.org/x')?.priority, 44 - 20); assert.equal(r.frontier.getByUrl('https://de.example.org/x')?.source, 'discovered');
  assert.equal(languagePreferred('en-GB', ['en']), true); assert.equal(languagePreferred('de', ['en']), false); assert.equal(languagePreferred('de', ['en', 'de']), true); assert.equal(languagePreferred(undefined, ['en']), true); assert.equal(languagePreferred('de', ['*']), true);
});

test('language hints: editions are hinted, countries and service names are not', () => {
  for (const [url, hint] of [['https://de.wikipedia.org/wiki/X', 'de'], ['https://fr.example.org/', 'fr'], ['https://example.org/ja/page', 'ja'], ['https://example.org/pt-br/page', 'pt'], ['https://es.m.wikipedia.org/x', 'es'],
    ['https://uk.reuters.com/x', undefined], ['https://ca.example.com/x', undefined], ['https://www.example.com/x', undefined], ['https://my.example.com/x', undefined], ['https://example.org/it/', undefined], ['https://example.org/no/', undefined], ['https://example.org/about/', undefined], ['https://example.org/en/page', 'en']] as const)
    assert.equal(urlLanguageHint(url), hint, url);
  assert.equal(lowValueUrl('https://a.org/wiki/Special:Search?q=x'), 'NOISE_PATH'); assert.equal(lowValueUrl('https://a.org/files/report.pdf'), 'NON_HTML_FILE'); assert.equal(lowValueUrl('https://a.org/article/pdf-guide'), undefined);
  assert.equal(lowValueUrl('https://a.org/w/index.php?title=X&oldid=5'), 'NOISE_PARAM'); assert.equal(lowValueUrl('https://a.org/cart'), 'NOISE_PATH');
});

test('link fanout is bounded, deterministic, widens to new domains first and follows nothing internal from a foreign-language page', () => {
  const link = (url: string, domain: string, kind: LinkCandidate['kind'], relevant = false): LinkCandidate => ({ url, domain, kind, relevant });
  const page: LinkCandidate[] = [];
  for (let i = 0; i < 60; i++) page.push(link(`https://wiki.org/n${i}`, 'wiki.org', 'internal', i === 50));
  for (let i = 0; i < 30; i++) page.push(link(`https://de${i}.wiki.org/x`, 'wiki.org', 'sibling'));
  for (let i = 0; i < 10; i++) page.push(link(`https://ref${i % 4}.example/r${i}`, `ref${i % 4}.example`, 'external'));
  const policy = { ...DEFAULT_POLICY, maxInternalLinksPerPage: 10, maxExternalLinksPerPage: 5, maxSiblingLinksPerPage: 2 };
  const out = chooseLinks(page, policy, false);
  assert.equal(out.length, 5 + 10 + 2); assert.deepEqual(out, chooseLinks([...page], policy, false)); // pure
  assert.deepEqual(out.slice(0, 5).map(l => l.domain), ['ref0.example', 'ref1.example', 'ref2.example', 'ref3.example', 'ref0.example']); // one per domain first
  assert.equal(out[5]?.url, 'https://wiki.org/n50'); // the relevant internal link goes first
  assert.equal(out.filter(l => l.kind === 'sibling').length, 2);
  assert.deepEqual(chooseLinks(page, policy, true).map(l => l.kind), ['external', 'external', 'external', 'external', 'external']);
  assert.deepEqual(chooseLinks([link('https://a.org/x', 'a.org', 'internal'), link('https://a.org/x', 'a.org', 'internal')], policy, false).length, 1); // duplicates collapse
});

test('through the Crawler: a foreign-language page is indexed but opens only its external links; external links outrank internal ones; the link graph is complete', async () => {
  const links = [{ url: 'https://wiki.org/a' }, { url: 'https://wiki.org/b' }, { url: 'https://other.example/' }];
  const r = rig((input: { url: string }) => input.url === 'https://de.wiki.org/start'
    ? pageResult(input.url, r.time.now, { title: 'Start', text: 'deutscher text '.repeat(10), links }, { page: { title: 'Start', text: 'deutscher text '.repeat(10), links: links.map(l => ({ ...l, nofollow: false })), linksTruncated: false, language: 'de' } })
    : outcomeResult('HTTP_ERROR', input.url, r.time.now, { httpStatus: 404 }), { hostDelayMs: 0 });
  r.frontier.add('https://de.wiki.org/start', { queue: 'PUBLIC', source: 'seed' }, r.time.now);
  await r.crawler.runOnce();
  assert.ok(r.frontier.getByUrl('https://other.example/')); assert.equal(r.frontier.getByUrl('https://wiki.org/a'), undefined); assert.equal(r.frontier.getByUrl('https://wiki.org/b'), undefined);
  assert.equal(r.frontier.getByUrl('https://other.example/')?.external, 1); assert.equal(r.frontier.getByUrl('https://other.example/')?.priority, 56);
  assert.equal(Number((r.db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }).n), 3);
});

test('soft 404s and thin pages are kept but down-ranked, and count against the domain yield instead of boosting it', async () => {
  assert.equal(looksLikeSoft404('Page not found', 'Sorry, the page you requested does not exist.', 2), true); assert.equal(looksLikeSoft404('Guide', 'long '.repeat(200) + 'not found', 2), false);
  assert.equal(looksLikeSoft404('Errors', 'x'.repeat(100), 50), false); assert.equal(looksThin('  ', 0), true); assert.equal(looksThin('a real sentence that is long enough to index properly', 0), false);
  const r = rig((input: { url: string }) => input.url.endsWith('/missing')
    ? pageResult(input.url, r.time.now, { title: 'Not found', text: 'Sorry, page not found. 404 error about chatgpt.' })
    : pageResult(input.url, r.time.now, { title: 'ChatGPT guide', text: 'A real article about chatgpt and how the assistant works in practice. '.repeat(8) }), { hostDelayMs: 0 });
  r.frontier.add('https://s.example/missing', { queue: 'PUBLIC', source: 'seed' }, r.time.now); r.frontier.add('https://s.example/guide', { queue: 'PUBLIC', source: 'seed' }, r.time.now);
  await r.crawler.runOnce(); r.advance(10); await r.crawler.runOnce();
  const hits = new Searcher(r.documents, () => r.time.now).search('chatgpt').hits; assert.equal(hits[0]?.url, 'https://s.example/guide'); assert.ok(hits.some(h => h.url.endsWith('/missing')), 'down-ranked, not deleted');
  const d = r.db.prepare(`SELECT useful, low_value AS low FROM domains WHERE domain='s.example'`).get() as { useful: number; low: number }; assert.deepEqual([Number(d.useful), Number(d.low)], [1, 1]);
});

test('independent referring domains build authority, once per pair, and only from real pages', async () => {
  const r = rig(never, { hostDelayMs: 0 });
  r.frontier.add('https://target.org/', { queue: 'PUBLIC', source: 'seed' }, r.time.now);
  r.frontier.noteDomainLink('a.com', 'target.org'); r.frontier.noteDomainLink('a.com', 'target.org'); r.frontier.noteDomainLink('b.com', 'target.org'); r.frontier.noteDomainLink('target.org', 'target.org');
  assert.equal(Number((r.db.prepare(`SELECT ref_domains AS n FROM domains WHERE domain='target.org'`).get() as { n: number }).n), 2);
});

test('policy validation: every knob has a default, a typo is an error naming the field', () => {
  assert.deepEqual(resolvePolicy().explore, { exploit: 70, explore: 20, wildcard: 10 }); assert.equal(resolvePolicy({ maxPendingPerDomain: 10, maxPendingPerFamily: 20 }).maxPendingPerDomain, 10);
  for (const bad of [{ maxPendingPerDomain: 0 }, { explore: { exploit: 50, explore: 20, wildcard: 10 } }, { minWeight: 0 }, { preferredLanguages: ['english'] }, { languageMode: 'x' as never }, { maxPendingPerDomain: 5000, maxPendingPerFamily: 10 }, { trackingParams: ['a b'] }, { domainConcurrency: 1.5 }, { yieldHalfLifeMs: 10 }])
    assert.throws(() => resolvePolicy(bad), RangeError);
  assert.deepEqual(resolvePolicy({ preferredLanguages: [' EN ', 'de'] }).preferredLanguages, ['en', 'de']);
});

test('extra tracking parameters are stripped on admission, so the tracked and the clean URL are one URL', () => {
  const r = rig(never, { trackingParams: ['ref', 'campaign'] });
  assert.equal(r.frontier.add('https://a.org/p?id=1&ref=mail&campaign=x', { queue: 'PUBLIC' }, r.time.now), 'ADDED'); assert.equal(r.frontier.add('https://a.org/p?id=1', { queue: 'PUBLIC' }, r.time.now), 'EXISTS');
  assert.equal(r.frontier.add('https://a.org/p?id=1&utm_source=x', { queue: 'PUBLIC' }, r.time.now), 'EXISTS');
});

test('title/path word sharing is the cheap relevance signal (no anchor text exists in web.fetch.v1)', () => {
  assert.equal(pathShares('/wiki/Large_language_model', words('Large Language Models explained')), true); assert.equal(pathShares('/wiki/Apple', words('ChatGPT')), false); assert.equal(pathShares('/x', new Set()), false);
});

test('stats are O(1) counters and detail is cached for 15 s; the counters never disagree with the table', () => {
  const r = rig(never, { hostDelayMs: 0 });
  for (let i = 0; i < 5; i++) r.frontier.add(`https://s${i}.org/`, { queue: i === 0 ? 'DEMAND' : 'PUBLIC' }, r.time.now);
  assert.deepEqual(r.frontier.stats(), { PENDING: 5, IN_FLIGHT: 0, DONE: 0, BLOCKED: 0, FAILED: 0 });
  const d = r.frontier.detail(r.time.now); assert.deepEqual([d.pendingDemand, d.pendingPublic, d.hosts, d.domains], [1, 4, 5, 5]);
  r.frontier.add('https://s9.org/', { queue: 'PUBLIC' }, r.time.now); r.advance(1000); assert.equal(r.frontier.detail(r.time.now).hosts, 5); assert.equal(r.frontier.detail(r.time.now).pendingPublic, 5); // exact backlog, cached scan
  r.advance(20000); assert.equal(r.frontier.detail(r.time.now).hosts, 6);
});
