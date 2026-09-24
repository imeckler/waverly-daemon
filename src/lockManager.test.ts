import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockManager, SlotReading, confirmsCode } from './lockManager.js';
import { LockHealth, Notifier, SILENCE_LIMIT_MS, checkLiveness } from './lockHealth.js';

// A stand-in for a ZWaveNode with user-code slots 2..(2+n-1). Writes are
// recorded; what a read-back returns is up to the test.
function fakeLock(slotCount = 3) {
  const writes: { property: string; slot: number; value: unknown }[] = [];
  const events: Record<string, Array<() => void>> = {};
  const ids: { commandClass: number; endpoint: number; property: string; propertyName: string; propertyKey: number }[] = [];
  for (let slot = 2; slot < 2 + slotCount; slot++) {
    ids.push({ commandClass: 99, endpoint: 0, property: 'userCode', propertyName: 'userCode', propertyKey: slot });
  }
  const lock = {
    id: 13,
    label: '912',
    getDefinedValueIDs: () => ids,
    setValue: async (vid: { property: string; propertyKey: number }, value: unknown) => {
      writes.push({ property: vid.property, slot: vid.propertyKey, value });
      return { status: 254 /* SuccessUnsupervised */ };
    },
    on: (ev: string, fn: () => void) => { (events[ev] ??= []).push(fn); },
  };
  return { lock: lock as any, writes, events };
}

function fakeNotifier() {
  const triggered: { summary: string; dedupKey: string; details: Record<string, unknown> }[] = [];
  const resolved: string[] = [];
  const notifier: Notifier = {
    async trigger(summary, dedupKey, details) { triggered.push({ summary, dedupKey, details }); },
    async resolve(dedupKey) { resolved.push(dedupKey); },
  };
  return { notifier, triggered, resolved };
}

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

// Lets a test hand the manager a per-slot answer, or none at all.
function readsFrom(answers: Map<number, SlotReading | undefined> | ((slot: number) => SlotReading | undefined)) {
  const reads: number[] = [];
  const readSlot = async (slot: number) => {
    reads.push(slot);
    return typeof answers === 'function' ? answers(slot) : answers.get(slot);
  };
  return { readSlot, reads };
}

const flush = () => new Promise(r => setImmediate(r));

test('a write the lock reads back as enabled is verified, without paging', async () => {
  const { lock, writes } = fakeLock();
  const { notifier, triggered } = fakeNotifier();
  const clock = fakeClock();
  const health = new LockHealth(lock, notifier, clock.now);
  const { readSlot, reads } = readsFrom(() => ({ status: 1, code: '913790' }));
  const m = new LockManager(lock, { health, readSlot });

  const r = await m.allocateCodeSlot('913790');
  assert.equal(r.ok, true);
  assert.deepEqual(writes, [{ property: 'userCode', slot: 2, value: '913790' }]);
  assert.deepEqual(reads, [2]);
  await flush();
  assert.equal(triggered.length, 0);
  assert.equal(health.lastHeardAt, clock.now());
});

test('a lock that masks codes is trusted on status alone', () => {
  assert.equal(confirmsCode({ status: 1, code: '**********' }, '913790'), true);
  assert.equal(confirmsCode({ status: 1, code: undefined }, '913790'), true);
  assert.equal(confirmsCode({ status: 1, code: '111111' }, '913790'), false);
  assert.equal(confirmsCode({ status: 0, code: '913790' }, '913790'), false);
  assert.equal(confirmsCode(undefined, '913790'), false);
});

test('a write the lock reports as still available is retried once, then paged', async () => {
  const { lock, writes } = fakeLock();
  const { notifier, triggered } = fakeNotifier();
  const health = new LockHealth(lock, notifier, fakeClock().now);
  const { readSlot } = readsFrom(() => ({ status: 0, code: '' }));
  const m = new LockManager(lock, { health, readSlot });

  const r = await m.allocateCodeSlot('913790');
  assert.equal(r.ok, false);
  assert.equal(writes.length, 2);
  await flush();
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].dedupKey, 'lock-13-write-unconfirmed');
  assert.match(triggered[0].summary, /Lock 13 \(912\)/);
  assert.equal(triggered[0].details.code, '91****');
  // The lock answered, so it is not silent — only the write failed.
  assert.notEqual(health.lastHeardAt, null);
});

test('a lock that does not answer the read-back is paged and stays unheard', async () => {
  const { lock } = fakeLock();
  const { notifier, triggered } = fakeNotifier();
  const health = new LockHealth(lock, notifier, fakeClock().now);
  const { readSlot } = readsFrom(() => undefined);
  const m = new LockManager(lock, { health, readSlot });

  const r = await m.allocateCodeSlot('913790');
  assert.equal(r.ok, false);
  await flush();
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].details.lockReports, 'no answer');
  assert.equal(health.lastHeardAt, null);
  assert.equal(health.commandsSinceHeard, 2);
});

test('a confirmed write resolves an earlier unconfirmed-write incident', async () => {
  const { lock } = fakeLock();
  const { notifier, resolved } = fakeNotifier();
  const health = new LockHealth(lock, notifier, fakeClock().now);
  let answer: SlotReading | undefined = undefined;
  const { readSlot } = readsFrom(() => answer);
  const m = new LockManager(lock, { health, readSlot });

  assert.equal((await m.allocateCodeSlot('111111')).ok, false);
  answer = { status: 1, code: '222222' };
  assert.equal((await m.allocateCodeSlot('222222')).ok, true);
  await flush();
  assert.deepEqual(resolved, ['lock-13-write-unconfirmed']);
});

test('a clear is verified on status only, so a Kwikset echoing the old digits passes', async () => {
  const { lock, writes } = fakeLock();
  const { notifier, triggered } = fakeNotifier();
  const health = new LockHealth(lock, notifier, fakeClock().now);
  let status = 1;
  const { readSlot } = readsFrom(() => ({ status, code: '913790' }));
  const m = new LockManager(lock, { health, readSlot });

  assert.equal((await m.allocateCodeSlot('913790')).ok, true);
  status = 0;
  await m.freeCodeSlot('913790');
  assert.deepEqual(writes.map(w => [w.property, w.slot, w.value]), [
    ['userCode', 2, '913790'],
    ['userIdStatus', 2, 0],
  ]);
  await flush();
  assert.equal(triggered.length, 0);
});

test('a clear the lock does not confirm is paged', async () => {
  const { lock } = fakeLock();
  const { notifier, triggered } = fakeNotifier();
  const health = new LockHealth(lock, notifier, fakeClock().now);
  const { readSlot } = readsFrom(() => ({ status: 1, code: '913790' }));
  const m = new LockManager(lock, { health, readSlot });

  assert.equal((await m.allocateCodeSlot('913790')).ok, true);
  await m.freeCodeSlot('913790');
  await flush();
  assert.equal(triggered.length, 1);
  assert.match(triggered[0].summary, /clearing slot 2/);
});

test('the watchdog leaves a recently heard lock alone', async () => {
  const { lock } = fakeLock();
  const { notifier, triggered } = fakeNotifier();
  const clock = fakeClock();
  const health = new LockHealth(lock, notifier, clock.now);
  const { readSlot, reads } = readsFrom(() => ({ status: 0, code: '' }));
  const m = new LockManager(lock, { health, readSlot });

  health.recordHeard();
  clock.advance(SILENCE_LIMIT_MS / 2);
  await checkLiveness(m);
  assert.deepEqual(reads, []);
  assert.equal(triggered.length, 0);
});

test('the watchdog probes a silent lock and pages when it does not answer, then resolves when it does', async () => {
  const { lock } = fakeLock();
  const { notifier, triggered, resolved } = fakeNotifier();
  const clock = fakeClock();
  const health = new LockHealth(lock, notifier, clock.now);
  let answer: SlotReading | undefined = undefined;
  const { readSlot, reads } = readsFrom(() => answer);
  const m = new LockManager(lock, { health, readSlot });

  // Nothing heard since start; after the limit the probe goes out and fails.
  clock.advance(SILENCE_LIMIT_MS);
  await checkLiveness(m);
  assert.deepEqual(reads, [2]);
  await flush();
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].dedupKey, 'lock-13-unresponsive');
  assert.match(triggered[0].summary, /since the daemon started 2 h ago/);

  // Still silent, still probing on the next tick.
  clock.advance(SILENCE_LIMIT_MS);
  await checkLiveness(m);
  assert.equal(reads.length, 2);

  // The lock comes back: the probe answers and the incident is resolved.
  answer = { status: 0, code: '' };
  await checkLiveness(m);
  await flush();
  assert.deepEqual(resolved, ['lock-13-unresponsive']);
  assert.equal(health.lastHeardAt, clock.now());
});

test('a notification pushed by the lock counts as being heard', async () => {
  const { lock, events } = fakeLock();
  const { notifier } = fakeNotifier();
  const clock = fakeClock();
  const health = new LockHealth(lock, notifier, clock.now);
  clock.advance(1234);
  for (const fn of events['notification']) fn();
  assert.equal(health.lastHeardAt, clock.now());
});
