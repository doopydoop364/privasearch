/**
 * Language policy helpers. web.fetch.v1 reports a page's language only after the fetch (from <html lang>), so admission relies on a conservative URL HINT:
 * the first host label (de.wikipedia.org) or a leading path segment (/de/, /pt-br/) that is a language code. A hint is a heuristic: it can be wrong, which is
 * why 'deprioritize' mode exists and why a seed, a redirect target or an explicit demand request is never judged by it. hreflang alternates are not part of
 * web.fetch.v1 today (docs/crawl-quality.md, "Blocked by the contract").
 */
const HOST_CODES = new Set(('aa ab af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu simple').split(' '));
// Host labels that are far more often a service name (my.example.com, go.example.com) or a COUNTRY (uk.reuters.com) than a language edition. Language editions of
// big encyclopedias that collide with a country code (uk, ca, ar, pl, ro, hu, tr, ru, se, fi) are therefore not recognised by hint: their pages are still judged by their own <html lang> after the fetch.
const HOST_AMBIGUOUS = new Set(['my', 'me', 'to', 'go', 'do', 'as', 'so', 'or', 'in', 'us', 'am', 'be', 'hi', 'he', 'is', 'la', 'na', 'on', 'se', 'st', 'wa', 'ha',
  // country codes that are not languages (uk.reuters.com, ca.example.com, ch., tw., sg., kr., ie., lu., za., cs.) and so never a hint:
  'uk', 'ca', 'ch', 'tw', 'sg', 'kr', 'ie', 'lu', 'za', 'cs', 'au', 'nz', 'in', 'us', 'eu', 'cn', 'br', 'mx', 'ar', 'sa', 'ae', 'il', 'gr', 'at', 'be', 'dk', 'se', 'fi', 'pl', 'ro', 'cz', 'hu', 'tr', 'ru', 'ua', 'jp', 'vn', 'ph', 'my', 'id', 'th', 'hk', 'pk', 'ng', 'ke', 'eg']);
// Two-letter segments that are also common English words or path words: never a language hint when found in a PATH.
const PATH_AMBIGUOUS = new Set(['is', 'it', 'no', 'to', 'my', 'me', 'be', 'am', 'as', 'so', 'or', 'id', 'in', 'us', 'he', 'hi', 'do', 'go', 'ha', 'la', 'na', 'on', 'se', 'st', 'ti', 'ty', 'wa', 'ye', 'nd', 'ng', 'li', 'lo', 'mi', 'ne', 'oc', 'os', 'pa', 'pi', 'ps', 'qu', 're', 'ss', 'ts', 'tt', 'tw', 'ug', 'za']);

/** The primary language subtag the URL hints at, or undefined. */
export function urlLanguageHint(url: string): string | undefined {
  let parsed: URL; try { parsed = new URL(url); } catch { return undefined; }
  const labels = parsed.hostname.split('.');
  if (labels.length >= 3) { const first = labels[0] ?? ''; const base = first.split('-')[0] ?? ''; if ((HOST_CODES.has(first) && !HOST_AMBIGUOUS.has(first)) || (first.includes('-') && HOST_CODES.has(base) && /^[a-z]{2}-[a-z]{2,}$/.test(first))) return base === 'simple' || first === 'simple' ? 'en' : base; }
  const segment = (parsed.pathname.split('/')[1] ?? '').toLowerCase(); const primary = segment.split(/[-_]/)[0] ?? '';
  if (/^[a-z]{2}([-_][a-z]{2})?$/.test(segment) && HOST_CODES.has(primary) && !PATH_AMBIGUOUS.has(primary)) return primary;
  return undefined;
}
/** True when `language` (a tag such as "en-GB", or a hint) is acceptable under the preferred list. Unknown languages are always acceptable. */
export function languagePreferred(language: string | null | undefined, preferred: string[]): boolean {
  if (preferred.includes('*') || !language) return true;
  const primary = language.toLowerCase().split(/[-_]/)[0] ?? ''; return primary === '' || preferred.includes(primary);
}

const BINARY_EXT = /\.(jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp3|mp4|m4a|ogg|ogv|webm|avi|mov|wav|flac|zip|gz|tgz|bz2|xz|7z|rar|tar|iso|dmg|exe|msi|apk|deb|rpm|pdf|docx?|xlsx?|pptx?|odt|ods|epub|woff2?|ttf|otf|eot|css|js|json|xml|rss|atom)$/i;
const NOISE_PARAM = /^(action|oldid|diff|veaction|printable|redirect|useskin|uselang|mobileaction|do|replytocom|share|print)$/i;
const NOISE_PATH = /(^|\/)(special:[^/]*|spezial:[^/]*|login|logout|signin|signup|register|cart|checkout|wp-admin|wp-login\.php|feed|rss|print|raw|share)(\/|$)/i;
/** Obvious non-content: media/binary files (web.fetch.v1 only returns HTML and plain text), edit/history/diff views, login and cart pages. */
export function lowValueUrl(url: string): string | undefined {
  let parsed: URL; try { parsed = new URL(url); } catch { return undefined; }
  if (BINARY_EXT.test(parsed.pathname)) return 'NON_HTML_FILE';
  for (const key of parsed.searchParams.keys()) if (NOISE_PARAM.test(key)) return 'NOISE_PARAM';
  if (NOISE_PATH.test(decodeURIComponentSafe(parsed.pathname))) return 'NOISE_PATH';
  return undefined;
}
const decodeURIComponentSafe = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

const SOFT404 = /\b(page not found|not found|404|no longer available|does not exist|doesn['’]t exist|nothing (was )?found|error 404|page you (are looking for|requested))\b/i;
/** A page that returned HTTP 200 but is an error page: a short body saying "not found" (title or text). Conservative: long pages are never soft 404s. */
export function looksLikeSoft404(title: string, text: string, linkCount: number): boolean {
  if (text.length > 600 || linkCount > 12) return false;
  return SOFT404.test(title) || SOFT404.test(text.slice(0, 300));
}
/** A page with almost nothing to index. */
export const looksThin = (text: string, linkCount: number): boolean => text.trim().length < 40 && linkCount < 3;
