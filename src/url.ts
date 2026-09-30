import { createHash } from 'node:crypto';

/**
 * URL normalisation and admission policy. This is PrivaSearch policy, applied before anything reaches
 * the frontier or PrivaNet. PrivaNet's node re-validates independently and is the security boundary;
 * this module exists so the frontier never stores or wastes jobs on URLs the node would refuse.
 */
export type UrlRejection = 'TOO_LONG' | 'MALFORMED' | 'SCHEME' | 'CREDENTIALS' | 'IP_LITERAL' | 'INTERNAL_HOST' | 'PORT' | 'CONTROL_CHARS';
export type Parsed = { ok: true; url: string; host: string; origin: string } | { ok: false; reason: UrlRejection };

const MAX_URL = 2048;
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|yclid|_hsenc|_hsmi)$/i;

/** Uppercase the hex of percent escapes and decode escapes of unreserved characters (RFC 3986 section 6.2.2). */
function normalisePercent(text: string): string {
  return text.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => {
    const code = parseInt(hex, 16); const char = String.fromCharCode(code);
    return /[A-Za-z0-9\-._~]/.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

export function parseCrawlUrl(raw: string, base?: string): Parsed {
  if (raw.length > MAX_URL * 2) return { ok: false, reason: 'TOO_LONG' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw.trim())) return { ok: false, reason: 'CONTROL_CHARS' };
  let url: URL;
  try { url = new URL(raw.trim(), base); } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'SCHEME' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'CREDENTIALS' };
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'IP_LITERAL' };
  // WHATWG URL already folds 0x7f.1, 2130706433, 017700000001 and similar into dotted decimal, so one check covers them.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host)) return { ok: false, reason: 'IP_LITERAL' };
  if (!host.includes('.') || host === 'localhost' || INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix))) return { ok: false, reason: 'INTERNAL_HOST' };
  if (url.port !== '') return { ok: false, reason: 'PORT' }; // WHATWG URL empties the default port, so any explicit port is non-default
  url.hash = '';
  url.hostname = host;
  const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING.test(key));
  if (kept.length !== [...url.searchParams.keys()].length) url.search = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';
  const path = normalisePercent(url.pathname === '' ? '/' : url.pathname);
  const search = url.search === '' ? '' : normalisePercent(url.search);
  const canonical = `${url.protocol}//${host}${path}${search}`;
  if (canonical.length > MAX_URL) return { ok: false, reason: 'TOO_LONG' };
  return { ok: true, url: canonical, host, origin: `${url.protocol}//${host}` };
}

export const urlKey = (canonicalUrl: string): string => createHash('sha256').update(canonicalUrl).digest('hex');
/** The idempotency key from the integration contract: crawl:<sha256(url)[0:32]>:<generation>. */
export const idempotencyKeyFor = (canonicalUrl: string, generation: number): string => `crawl:${urlKey(canonicalUrl).slice(0, 32)}:${generation}`;
export const sameOrigin = (a: string, b: string): boolean => { const pa = parseCrawlUrl(a); const pb = parseCrawlUrl(b); return pa.ok && pb.ok && pa.origin === pb.origin; };
