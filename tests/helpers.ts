import { DatabaseSync } from 'node:sqlite';
import { Crawler } from '../src/driver.js';
import { DocumentStore } from '../src/documents.js';
import { Frontier } from '../src/frontier.js';
import type { FrontierOptions } from '../src/frontier.js';
import { FakeTransport } from '../src/privanet/fake-transport.js';
import type { Responder } from '../src/privanet/fake-transport.js';

/** An in-memory crawl rig around the fake transport: no network, no files, controllable time. */
export function rig(respond: Responder, options: FrontierOptions = {}) {
  const db = new DatabaseSync(':memory:');
  const time = { now: 1_000_000_000 };
  const frontier = new Frontier(db, { hostDelayMs: 1000, backoffBaseMs: 1000, ...options });
  const documents = new DocumentStore(db);
  const transport = new FakeTransport(respond);
  const crawler = new Crawler({ frontier, documents, transport, clock: () => time.now, batch: 16 });
  return { db, time, frontier, documents, transport, crawler, advance(ms: number) { time.now += ms; } };
}
