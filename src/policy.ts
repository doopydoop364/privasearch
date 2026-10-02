/**
 * Crawl-trap defence: heuristics that keep the frontier out of effectively infinite URL spaces (calendars that link to the next month
 * forever, faceted filters, session identifiers, repeating path segments, endless pagination). They apply to URLs DISCOVERED by crawling;
 * a seed, a redirect target or a URL an operator asked for explicitly is never judged here. They are heuristics, so they can refuse a
 * legitimate URL (see docs/crawling.md, limitations); the per-host budget in the frontier is the backstop for anything they miss.
 */
export type TrapReason = 'TOO_MANY_SEGMENTS' | 'REPEATING_SEGMENTS' | 'TOO_MANY_PARAMS' | 'LONG_QUERY' | 'SESSION_OR_FILTER_PARAM' | 'CALENDAR' | 'DEEP_PAGINATION' | 'LONG_SEGMENT' | 'PATH_SESSION' | 'REPEATED_PARAM_VALUE';

const MAX_SEGMENTS = 10;
const MAX_PARAMS = 5;
const MAX_QUERY = 160;
const MAX_PAGE = 20;
const SESSION_OR_FILTER = /^(sort|sortby|sort_by|order|orderby|order_by|dir|filter|filters|facet|facets|fq|session|sessionid|session_id|sid|phpsessid|jsessionid|aspsessionid|replytocom|share|print|format)$/i;
const CALENDAR_PATH = /(^|\/)(calendar|calendars|events|event|agenda|archive|archives)(\/|$)/i;
const DATE_PARAM = /^(year|month|day|week|date|d|m|y|start|from|end|to|cal|calendar|ical|outlook-ical)$/i;
const DATE_SEGMENT = /^(\d{4}|\d{4}-\d{2}(-\d{2})?|\d{1,2})$/;

export function crawlTrap(url: string): TrapReason | undefined {
  let parsed: URL; try { parsed = new URL(url); } catch { return undefined; }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length > MAX_SEGMENTS) return 'TOO_MANY_SEGMENTS';
  const counts = new Map<string, number>();
  for (const segment of segments) { const n = (counts.get(segment) ?? 0) + 1; if (n >= 3) return 'REPEATING_SEGMENTS'; counts.set(segment, n); }
  if (segments.some(segment => segment.length > 120)) return 'LONG_SEGMENT'; // generated tokens and encoded state, not a page name
  if (/;(jsessionid|sessionid|sid|phpsessid)=/i.test(parsed.pathname)) return 'PATH_SESSION'; // session id carried in the path
  const keys = [...parsed.searchParams.keys()];
  const values = [...parsed.searchParams.values()].filter(value => value.length > 0); if (values.length >= 3 && new Set(values).size === 1) return 'REPEATED_PARAM_VALUE'; // ?a=x&b=x&c=x: a loop that appends parameters
  if (keys.length > MAX_PARAMS) return 'TOO_MANY_PARAMS';
  if (parsed.search.length > MAX_QUERY) return 'LONG_QUERY';
  if (keys.some(key => SESSION_OR_FILTER.test(key))) return 'SESSION_OR_FILTER_PARAM';
  const calendarish = CALENDAR_PATH.test(parsed.pathname);
  if (calendarish && (keys.some(key => DATE_PARAM.test(key)) || segments.filter(s => DATE_SEGMENT.test(s)).length >= 2)) return 'CALENDAR';
  if (keys.some(key => DATE_PARAM.test(key)) && keys.filter(key => DATE_PARAM.test(key)).length >= 2) return 'CALENDAR';
  for (const key of keys) if (/^(page|paged|p|start|offset)$/i.test(key) && Number(parsed.searchParams.get(key)) > MAX_PAGE * (key.toLowerCase() === 'start' || key.toLowerCase() === 'offset' ? 10 : 1)) return 'DEEP_PAGINATION';
  const pageSegment = segments.findIndex(segment => segment.toLowerCase() === 'page');
  if (pageSegment >= 0 && Number(segments[pageSegment + 1]) > MAX_PAGE) return 'DEEP_PAGINATION';
  return undefined;
}

/** Discovery priority: shallow pages first. Seeds start at 60; a link `depth` hops away starts lower, never below 0. */
export const discoveryPriority = (depth: number): number => Math.max(0, 50 - depth * 6);
export const SEED_PRIORITY = 60;
export const DEMAND_PRIORITY = 100;
