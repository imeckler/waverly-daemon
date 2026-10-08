import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserCodeCCValues } from '@zwave-js/cc';
import { userCodeSlots, userCodeValueId, userIdStatusValueId } from './lockSlots.js';
import { getLockCodes, registerLock, setLockCode, unregisterLock } from './lockRegistry.js';

// A Schlage that reported 30 users, whose driver cache holds only some of
// its slots (the others dropped after a "status not available" answer).
function schlage(cachedSlots: number[]) {
  const cache = new Map<string, unknown>([['supportedUsers', 30]]);
  for (const slot of cachedSlots) {
    cache.set(`userCode:${slot}`, '1234');
    cache.set(`userIdStatus:${slot}`, 1);
  }
  const writes: { property: string; slot: number; value: unknown }[] = [];
  const lock = {
    id: 6,
    label: 'BE469ZP',
    status: 4,
    ready: true,
    getDefinedValueIDs: () => cachedSlots.map(slot => ({ commandClass: 99, endpoint: 0, property: 'userCode', propertyName: 'userCode', propertyKey: slot })),
    getValue: (v: { commandClass: number; property: string; propertyKey?: number }) =>
      v.commandClass === 99 ? cache.get(v.propertyKey === undefined ? v.property : `${v.property}:${v.propertyKey}`) : undefined,
    getValueTimestamp: () => undefined,
    getHighestSecurityClass: () => 2,
    setValue: async (v: { property: string; propertyKey: number }, value: unknown) => {
      writes.push({ property: v.property, slot: v.propertyKey, value });
      return { status: 254 /* SuccessUnsupervised */ };
    },
    commandClasses: { 'User Code': { get: async (slot: number) => ({ userIdStatus: 1, userCode: writes.find(w => w.slot === slot)?.value }) } },
  };
  return { lock: lock as any, writes };
}

beforeEach(() => unregisterLock(6));

test('the built value ids are the ones zwave-js keys its cache by', () => {
  for (const slot of [1, 2, 30]) {
    assert.deepEqual(userCodeValueId(slot), UserCodeCCValues.userCode(slot).endpoint(0));
    assert.deepEqual(userIdStatusValueId(slot), UserCodeCCValues.userIdStatus(slot).endpoint(0));
  }
});

test('slots come from the reported user count, not from what the cache happens to hold', () => {
  const { lock } = schlage([2, 3, 4]);
  assert.deepEqual(userCodeSlots(lock), Array.from({ length: 30 }, (_, i) => i + 1));
});

test('a lock that never reported a count gets the cached slots', () => {
  const { lock } = schlage([2, 3]);
  lock.getValue = () => undefined;
  assert.deepEqual(userCodeSlots(lock), [2, 3]);
});

test('a dropped slot is still listed, as unknown, and can be set', async () => {
  const { lock, writes } = schlage([2, 3, 4]);
  registerLock(lock);
  const [codes] = getLockCodes();
  assert.equal(codes.slots.length, 30);
  assert.deepEqual(codes.slots[0], { slot: 1, code: null, status: 'unknown' });
  assert.deepEqual(codes.slots[1], { slot: 2, code: '1234', status: 'enabled' });
  const r = await setLockCode(6, 1, '532611');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(writes, [{ property: 'userCode', slot: 1, value: '532611' }]);
});

test('a slot beyond the lock\'s count is refused', async () => {
  const { lock } = schlage([2]);
  registerLock(lock);
  const r = await setLockCode(6, 31, '532611');
  assert.equal(r.ok, false);
  assert.match(r.error!, /no user slot 31/);
});
