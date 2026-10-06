import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { autoLockOf, registerLock, setLockAutoLock, unregisterLock } from './lockRegistry.js';

const AUTO_LOCK = { commandClass: 112, endpoint: 0, property: 15, propertyName: 'Auto Lock' };

// A Schlage: the Auto Lock parameter with the device database's on/off values.
// `stored` is what the lock itself holds; `cached` what the driver last saw.
function schlage(id: number) {
  const state = { cached: 0 as number | undefined, stored: 0 as number | undefined, writes: [] as number[], acceptWrite: true };
  const lock = {
    id,
    getDefinedValueIDs: () => [AUTO_LOCK, { commandClass: 99, endpoint: 0, property: 'userCode', propertyName: 'userCode', propertyKey: 2 }],
    getValueMetadata: () => ({ type: 'number', states: { 0: 'Disable', 255: 'Enable' } }),
    getValue: (v: { property: unknown }) => v.property === 15 ? state.cached : undefined,
    setValue: async (_v: unknown, value: number) => {
      state.writes.push(value);
      if (state.acceptWrite) state.stored = value;
      return { status: 255 /* Success */ };
    },
    commandClasses: { Configuration: { get: async () => { state.cached = state.stored; return state.stored; } } },
  };
  return { lock: lock as any, state };
}

// A Kwikset: no configuration parameters at all.
function kwikset(id: number) {
  return { id, getDefinedValueIDs: () => [], getValueMetadata: () => ({ type: 'any' }), getValue: () => undefined } as any;
}

beforeEach(() => { for (const id of [11, 13]) unregisterLock(id); });

test('the cached parameter reads as on, off, or unknown', () => {
  const { lock, state } = schlage(13);
  assert.equal(autoLockOf(lock), false);
  state.cached = 255;
  assert.equal(autoLockOf(lock), true);
  state.cached = undefined;
  assert.equal(autoLockOf(lock), null);
});

test('a lock without the parameter has no setting and refuses to change it', async () => {
  registerLock(kwikset(11));
  assert.equal(autoLockOf(kwikset(11)), null);
  const r = await setLockAutoLock(11, true);
  assert.equal(r.ok, false);
  assert.match(r.error!, /no auto-lock setting/);
});

test('turning auto-lock on writes the on value and is confirmed by the lock', async () => {
  const { lock, state } = schlage(13);
  registerLock(lock);
  assert.deepEqual(await setLockAutoLock(13, true), { ok: true });
  assert.deepEqual(state.writes, [255]);
  assert.equal(autoLockOf(lock), true);
  assert.deepEqual(await setLockAutoLock(13, false), { ok: true });
  assert.deepEqual(state.writes, [255, 0]);
  assert.equal(autoLockOf(lock), false);
});

test('a write the lock does not store is reported as unconfirmed', async () => {
  const { lock, state } = schlage(13);
  state.acceptWrite = false;
  registerLock(lock);
  const r = await setLockAutoLock(13, true);
  assert.equal(r.ok, false);
  assert.match(r.error!, /did not confirm/);
  assert.equal(autoLockOf(lock), false);
});

test('an unmanaged node is refused', async () => {
  const r = await setLockAutoLock(99, true);
  assert.equal(r.ok, false);
  assert.match(r.error!, /not managed/);
});
