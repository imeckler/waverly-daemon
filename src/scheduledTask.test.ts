import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledTask } from './scheduledTask.js';

test('a task in the past runs synchronously', () => {
  let ran = 0;
  const task = new ScheduledTask(new Date(Date.now() - 1000), () => { ran++; });
  assert.equal(ran, 1);
  assert.equal(task.finalState, 'occurred');
});

test('a task more than 24.8 days out does not fire immediately', async () => {
  let ran = 0;
  const task = new ScheduledTask(new Date(Date.now() + 40 * 24 * 3600 * 1000), () => { ran++; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ran, 0);
  assert.equal(task.finalState, undefined);
  task.cancel();
  assert.equal(task.finalState, 'cancelled');
});

test('a short future task fires once and can no longer be cancelled', async () => {
  let ran = 0;
  const task = new ScheduledTask(new Date(Date.now() + 10), () => { ran++; });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(ran, 1);
  task.cancel();
  assert.equal(task.finalState, 'occurred');
});
