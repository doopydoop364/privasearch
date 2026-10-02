import { outcomeResult, pageResult } from '../../src/privanet/fake-transport.js';
import type { FetchResult } from '../../src/privanet/contract.js';

/**
 * A deterministic synthetic web for crawl-quality measurements. Everything is generated from a fixed seed, and every page obeys the real web.fetch.v1
 * limits (at most 100 links in document order, at most 10 KiB of text, a cross-origin redirect is an outcome rather than a followed hop).
 *
 *   wiki.test       a giant, densely interlinked encyclopedia: one host per language edition (en, de, fr, ... 50 hosts). Every article carries site
 *                   navigation, a language switcher (the same article in many editions) and internal links first; its references (external links)
 *                   come after the 100-link cap, as on a real encyclopedia. The English "ChatGPT" article carries a few external links early (infobox).
 *   official.test   the product's own site; docs.test the documentation; news.test news with a calendar trap; forum.test with disallowed paths;
 *   blogN.test      small independent blogs that link to each other and to the official site; spam.test a mirror of the wiki text; old.test redirects
 *                   to another site; every site has some soft-404 pages (HTTP 200 saying "not found").
 */
export const LANGS = ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'zh', 'ar', 'sv', 'uk', 'ca', 'fa', 'no', 'ko', 'fi', 'hu', 'id', 'cs', 'tr', 'ro', 'vi', 'he', 'da', 'bg', 'el', 'sr', 'hr', 'sk', 'lt', 'th', 'sl', 'hi', 'et', 'lv', 'ms', 'az', 'ka', 'kk', 'eu', 'ta', 'ur', 'bn', 'gl', 'mk', 'be', 'af'];
export const ARTICLES_PER_LANG = 300;

/** The site a host belongs to in this test world: the last two DNS labels (every host here ends in .test). */
export const siteOf = (host: string): string => host.split('.').slice(-2).join('.');
export const GIANT = ['wiki.test', 'mega.test'];
export const INDEPENDENT = ['official.test', 'docs.test', 'news.test', 'forum.test', 'blog1.test', 'blog2.test', 'blog3.test', 'blog4.test', 'blog5.test', 'blog6.test'];

class Random { constructor(private s: number) {} next(): number { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s / 4294967296; } int(n: number): number { return Math.floor(this.next() * n); } }

const VOCAB = ['Apple', 'Bridge', 'Castle', 'Delta', 'Engine', 'Forest', 'Garden', 'Harbor', 'Island', 'Jungle', 'Kernel', 'Lagoon', 'Market', 'Nebula', 'Orchard', 'Planet', 'Quarry', 'River', 'Summit', 'Tunnel', 'Valley', 'Window', 'Yacht', 'Zephyr', 'Anchor', 'Beacon', 'Canyon', 'Dynamo', 'Ember', 'Fjord', 'Glacier', 'Hollow', 'Isthmus', 'Jetty', 'Kiln', 'Ledge', 'Meadow', 'Nook', 'Oasis', 'Prairie'];
/** An article's path in an edition: the same article has a different (translated) title in every language, as on a real encyclopedia, so no two editions share a path. */
const wiki = (lang: string, n: number) => `https://${lang}.wiki.test/wiki/${n === 0 ? 'ChatGPT' : `${VOCAB[n % VOCAB.length]}_${lang === 'en' ? '' : `${lang}_`}${n}`}`;
const links = (urls: string[]) => urls.slice(0, 100).map(url => ({ url }));

function wikiPage(url: URL): { title: string; text: string; links: Array<{ url: string }>; lang: string } {
  const lang = url.hostname.split('.')[0] ?? 'en'; const name = decodeURIComponent(url.pathname.slice('/wiki/'.length));
  const n = name === 'ChatGPT' ? 0 : Number(/(\d+)$/.exec(name)?.[1] ?? 0);
  const rand = new Random(n * 7919 + lang.charCodeAt(0) * 31 + lang.charCodeAt(1));
  const out: string[] = [`https://${lang}.wiki.test/wiki/Main_Page`, `https://${lang}.wiki.test/wiki/Portal`, `https://${lang}.wiki.test/wiki/Help`, `https://${lang}.wiki.test/wiki/Contents`];
  if (n === 0 && lang === 'en') out.push('https://official.test/chatgpt', 'https://docs.test/chatgpt/intro', 'https://news.test/story/1');
  for (let i = 0; i < 38 && i < LANGS.length; i++) out.push(wiki(LANGS[(i + n) % LANGS.length]!, n)); // language switcher: the same article in other editions, under other titles
  for (let i = 0; i < 56; i++) out.push(wiki(lang, rand.int(ARTICLES_PER_LANG)));
  for (let i = 0; i < 12; i++) out.push(`https://blog${1 + rand.int(6)}.test/post/${rand.int(30)}`); // references: past the 100-link cap, so never seen
  const title = n === 0 ? 'ChatGPT' : `${VOCAB[n % VOCAB.length]} ${n}`;
  const topical = n === 0 || n % 7 === 0 ? 'chatgpt language model assistant ' : '';
  return { title, lang, links: links(out), text: `${title} ${lang} ${topical}encyclopedia article text number ${n} in the ${lang} edition. `.repeat(8) };
}

function plainSite(site: string, url: URL): { title: string; text: string; links: Array<{ url: string }> } | 'MISSING' | 'SOFT404' | 'DISALLOWED' | 'REDIRECT' {
  const path = url.pathname; const host = url.hostname;
  const sizes: Record<string, number> = { 'official.test': 40, 'docs.test': 60, 'news.test': 50, 'forum.test': 80, 'spam.test': 60 };
  const count = sizes[site] ?? 25;
  if (site === 'old.test') return 'REDIRECT';
  if (site === 'mega.test') { // one giant single-language, single-host site: every page links to 60 others of itself and to nobody else
    const rand = new Random([...path].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11)); const out = Array.from({ length: 60 }, () => `https://mega.test/item/${rand.int(5000)}`);
    return { title: `mega item ${path}`, text: `mega.test item ${path} unrelated catalogue entry. `.repeat(10), links: links(out) };
  }
  if (path.startsWith('/private')) return 'DISALLOWED';
  if (path.startsWith('/missing')) return 'SOFT404';
  const rand = new Random([...path].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7));
  const page = Number(/(\d+)$/.exec(path)?.[1] ?? 0) % count;
  const base = `https://${host}`;
  const out = [`${base}/`, `${base}/about`];
  for (let i = 0; i < 8; i++) out.push(`${base}/page/${rand.int(count)}`);
  if (site === 'official.test' && page % 5 === 0) out.push('https://docs.test/chatgpt/intro', 'https://blog1.test/post/1');
  if (site === 'docs.test') out.push('https://official.test/chatgpt');
  if (site === 'news.test') { out.push(`${base}/calendar?year=2020&month=${1 + rand.int(12)}`, `${base}/story/${rand.int(count)}`, `${base}/story/${rand.int(count)}`); if (path.startsWith('/calendar')) out.push(`${base}/calendar?year=2019&month=${1 + rand.int(12)}`); }
  if (site === 'forum.test') out.push(`${base}/private/thread/${page}`, `${base}/missing/${page}`, `${base}/thread/${rand.int(count)}?sort=asc`);
  if (site.startsWith('blog')) { out.push(`https://blog${1 + rand.int(6)}.test/post/${rand.int(30)}`, 'https://official.test/chatgpt'); }
  if (site === 'spam.test') { for (let i = 0; i < 40; i++) out.push(wiki(LANGS[rand.int(LANGS.length)]!, rand.int(ARTICLES_PER_LANG))); out.push(`${base}/page/${rand.int(count)}?ref=${rand.int(100000)}`); }
  if (site === 'official.test' && path === '/chatgpt') out.push('https://old.test/start');
  const topical = site === 'spam.test' || site === 'official.test' || site === 'docs.test' || path.includes('post') || path.includes('story') || path.includes('thread') ? 'chatgpt ' : '';
  const text = site === 'spam.test' ? `ChatGPT en edition encyclopedia article text number ${page} chatgpt language model assistant `.repeat(8) : `${site} ${path} ${topical}independent page ${page}. `.repeat(10);
  return { title: site === 'spam.test' ? `ChatGPT mirror ${page}` : `${site} ${path}`, text, links: links(out) };
}

/** Counters the simulation reads back: what the "internet" was asked, per host. */
export function syntheticWeb() {
  const fetched: string[] = [];
  const respond = (input: { url: string }): FetchResult => {
    const url = new URL(input.url); const at = 1_000_000_000; fetched.push(url.hostname);
    if (siteOf(url.hostname) === 'wiki.test') {
      if (!url.pathname.startsWith('/wiki/')) return outcomeResult('HTTP_ERROR', input.url, at, { httpStatus: 404 });
      const p = wikiPage(url); return pageResult(input.url, at, p, { page: { title: p.title, text: p.text, links: p.links.map(l => ({ url: l.url, nofollow: false })), linksTruncated: false, language: p.lang } } as Partial<FetchResult>);
    }
    const site = siteOf(url.hostname); const p = plainSite(site, url);
    if (p === 'DISALLOWED') return outcomeResult('ROBOTS_DISALLOWED', input.url, at);
    if (p === 'REDIRECT') return outcomeResult('REDIRECT', input.url, at, { httpStatus: 301, redirectTarget: 'https://official.test/chatgpt' });
    if (p === 'SOFT404') return pageResult(input.url, at, { title: 'Not found', text: 'Sorry, page not found. 404 error.', links: [] });
    if (p === 'MISSING') return outcomeResult('HTTP_ERROR', input.url, at, { httpStatus: 404 });
    return pageResult(input.url, at, p);
  };
  return { respond, fetched };
}
