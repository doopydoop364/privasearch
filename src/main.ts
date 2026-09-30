import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DocumentStore } from './documents.js';
import { createSearchServer } from './server.js';

// Serves the search API over an existing PrivaSearch database. Crawling is not wired to PrivaNet yet (see README).
const path = process.env.PRIVASEARCH_DB ?? './var/privasearch.sqlite';
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const server = createSearchServer(new DocumentStore(new DatabaseSync(path)));
server.listen(Number(process.env.PRIVASEARCH_PORT ?? 4020), process.env.PRIVASEARCH_HOST ?? '127.0.0.1', () => console.log(JSON.stringify({ event: 'search.started' })));
