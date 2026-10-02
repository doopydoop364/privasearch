import { closeSync, constants, openSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Create a private, verified snapshot without overwriting an existing path. */
export function backupDatabase(source: string, destination: string): void {
  // SQLite accepts an empty existing file. Reserve it privately before any
  // database bytes are written; chmod after VACUUM leaves an exposure window.
  closeSync(openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
  try {
    const db = new DatabaseSync(source, { readOnly: true });
    try { db.prepare('VACUUM INTO ?').run(destination); } finally { db.close(); }
    const copy = new DatabaseSync(destination, { readOnly: true });
    try { if (copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('backup integrity check failed'); }
    finally { copy.close(); }
  } catch (error) {
    try { unlinkSync(destination); } catch { /* keep the original failure */ }
    throw error;
  }
}
