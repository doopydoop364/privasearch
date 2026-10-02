import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { waitForWake } from '../src/wait.js';
import { rig } from './helpers.js';

test('idle crawler releases abort listeners after every wait and on exit', async () => {
  const r = rig(() => { throw new Error('empty frontier must not fetch'); });
  const controller = new AbortController(); let cycles = 0;
  try {
    await r.crawler.run({ signal: controller.signal, idleMs: 1, until: () => ++cycles > 50 });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { r.db.close(); }
});

test('completed work, rejected work, and shutdown all clean up wait resources', async () => {
  const controller = new AbortController();
  for (let i = 0; i < 50; i++) await waitForWake([Promise.resolve()], 60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(waitForWake([Promise.reject(new Error('work failed'))], 60_000, controller.signal), /work failed/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const waiting = waitForWake([], 60_000, controller.signal);
  controller.abort(); await waiting;
  await waitForWake([], 60_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
