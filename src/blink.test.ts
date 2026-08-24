import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blinkSwitch } from './blink.js';

function fakeRpc(initialOn: boolean) {
  const calls: { method: string; params: any }[] = [];
  let on = initialOn;
  const rpc = async (_ip: string, method: string, params: any = {}) => {
    calls.push({ method, params });
    if (method === 'Switch.GetStatus') return { id: params.id, output: on };
    if (method === 'Switch.Set') { on = params.on; return { was_on: !on }; }
    throw new Error(`unexpected rpc ${method}`);
  };
  return { rpc, calls, state: () => on };
}

const noSleep = async () => {};

test('blink from OFF goes on/off twice and ends OFF', async () => {
  const { rpc, calls, state } = fakeRpc(false);
  await blinkSwitch(rpc, '10.0.0.1', 0, { count: 2, intervalMs: 0, sleep: noSleep });
  assert.deepEqual(
    calls.filter(c => c.method === 'Switch.Set').map(c => c.params.on),
    [true, false, true, false],
  );
  assert.equal(state(), false);
});

test('blink from ON goes off/on twice and ends ON', async () => {
  const { rpc, calls, state } = fakeRpc(true);
  await blinkSwitch(rpc, '10.0.0.1', 1, { count: 2, intervalMs: 0, sleep: noSleep });
  assert.deepEqual(
    calls.filter(c => c.method === 'Switch.Set').map(c => c.params),
    [{ id: 1, on: false }, { id: 1, on: true }, { id: 1, on: false }, { id: 1, on: true }],
  );
  assert.equal(state(), true);
});

test('blink waits between every flip', async () => {
  const { rpc } = fakeRpc(false);
  const sleeps: number[] = [];
  await blinkSwitch(rpc, '10.0.0.1', 0, {
    count: 2, intervalMs: 500, sleep: async ms => { sleeps.push(ms); },
  });
  // 4 flips → 3 gaps between them; no trailing sleep after the last flip.
  assert.deepEqual(sleeps, [500, 500, 500]);
});
