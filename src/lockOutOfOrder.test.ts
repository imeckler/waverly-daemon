import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LockManager, SlotReading } from './lockManager.js';
import { LockHealth, Notifier, SILENCE_LIMIT_MS, checkLiveness } from './lockHealth.js';
import { isLockOutOfOrder, markLockOutOfOrder, setOutOfOrderFile } from './lockOutOfOrder.js';
import { registerLockGroup, resetLockGroups, retireLock, setLockOutOfOrder, setOverridesFile } from './lockGroups.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-out-of-order-'));
const marksFile = path.join(dir, 'lock-out-of-order.json');
setOverridesFile(path.join(dir, 'lock-nodes.json'));

beforeEach(() => {
  fs.rmSync(marksFile, { force: true });
  setOutOfOrderFile(marksFile);
  resetLockGroups();
});

function fakeLock(id = 13) {
  const ids = [2, 3].map(slot => ({ commandClass: 99, endpoint: 0, property: 'userCode', propertyName: 'userCode', propertyKey: slot }));
  const lock = {
    id,
    label: '912',
    getDefinedValueIDs: () => ids,
    setValue: async () => ({ status: 254 /* SuccessUnsupervised */ }),
    on: () => {},
    off: () => {},
  };
  return lock as any;
}

function fakeNotifier() {
  const triggered: string[] = [];
  const resolved: string[] = [];
  const notifier: Notifier = {
    async trigger(_summary, dedupKey) { triggered.push(dedupKey); },
    async resolve(dedupKey) { resolved.push(dedupKey); },
  };
  return { notifier, triggered, resolved };
}

// A managed lock whose read-backs return whatever `answer.value` holds.
function managedLock(id = 13) {
  const n = fakeNotifier();
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const health = new LockHealth(fakeLock(id), n.notifier, clock.now);
  const answer: { value: SlotReading | undefined } = { value: undefined };
  const reads: number[] = [];
  let reinterviews = 0;
  const manager = new LockManager(fakeLock(id), {
    health,
    readSlot: async (slot) => { reads.push(slot); return answer.value; },
    reinterview: async () => { reinterviews++; return 'ready' as const; },
    healCheckDelayMs: 0,
  });
  registerLockGroup({ serverUrl: 'https://example.test', description: null, managers: [manager], wsClient: { reconnect: () => {} } });
  return { manager, health, clock, answer, reads, reinterviews: () => reinterviews, ...n };
}

const flush = () => new Promise(r => setImmediate(r));
const settle = async () => { await new Promise(r => setTimeout(r, 10)); await flush(); };

test('a silent lock that is out of order is neither probed, re-interviewed nor paged', async () => {
  const l = managedLock();
  assert.deepEqual(setLockOutOfOrder(13, true), { ok: true });
  l.clock.advance(SILENCE_LIMIT_MS);
  await checkLiveness(l.manager, false, 0);
  await checkLiveness(l.manager, true, 0);
  await flush();
  assert.deepEqual(l.reads, []);
  assert.equal(l.reinterviews(), 0);
  assert.deepEqual(l.triggered, []);
});

test('the same silent lock, in service, is paged', async () => {
  const l = managedLock();
  l.clock.advance(SILENCE_LIMIT_MS);
  await checkLiveness(l.manager, false, 0);
  await flush();
  assert.deepEqual(l.triggered, ['lock-13-unresponsive']);
});

test('a write an out-of-order lock does not confirm is still attempted, and not paged', async () => {
  const l = managedLock();
  setLockOutOfOrder(13, true);
  const r = await l.manager.allocateCodeSlot('913790');
  assert.equal(r.ok, false);
  await settle();
  // Written and read back twice; the liveness check the miss asks for does nothing.
  assert.deepEqual(l.reads, [2, 2]);
  assert.equal(l.reinterviews(), 0);
  assert.deepEqual(l.triggered, []);
});

test('marking a lock out of order resolves both of its incidents, open here or not', async () => {
  const l = managedLock();
  setLockOutOfOrder(13, true);
  await flush();
  assert.deepEqual(l.resolved.sort(), ['lock-13-unresponsive', 'lock-13-write-unconfirmed']);
});

test('a lock put back in service is probed at once and paged if it is still silent', async () => {
  const l = managedLock();
  setLockOutOfOrder(13, true);
  await flush();
  l.resolved.length = 0;
  assert.deepEqual(setLockOutOfOrder(13, false, 0), { ok: true });
  assert.equal(isLockOutOfOrder(13), false);
  await settle();
  // Probe, the retry, then the probe after the re-interview.
  assert.deepEqual(l.reads, [2, 2, 2]);
  assert.equal(l.reinterviews(), 1);
  assert.deepEqual(l.triggered, ['lock-13-unresponsive']);
});

test('a lock put back in service that answers is not paged', async () => {
  const l = managedLock();
  setLockOutOfOrder(13, true);
  l.answer.value = { status: 0, code: '' };
  setLockOutOfOrder(13, false, 0);
  await settle();
  assert.deepEqual(l.reads, [2]);
  assert.deepEqual(l.triggered, []);
  assert.notEqual(l.health.lastHeardAt, null);
});

test('putting an in-service lock back in service does not probe it', async () => {
  const l = managedLock();
  assert.deepEqual(setLockOutOfOrder(13, false), { ok: true });
  await flush();
  assert.deepEqual(l.reads, []);
});

test('a lock the daemon does not manage is refused', () => {
  managedLock();
  const r = setLockOutOfOrder(99, true);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not managed/);
  assert.equal(isLockOutOfOrder(99), false);
});

test('the mark survives a restart, and only covers the lock it was put on', () => {
  managedLock();
  setLockOutOfOrder(13, true);
  setOutOfOrderFile(marksFile); // forget what is in memory, as a restart would
  assert.equal(isLockOutOfOrder(13), true);
  assert.equal(isLockOutOfOrder(14), false);
});

test('a mark that cannot be saved is refused and not kept', () => {
  managedLock();
  setOutOfOrderFile(path.join(dir, 'no-such-dir', 'marks.json'));
  const r = setLockOutOfOrder(13, true);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Could not save/);
  assert.equal(isLockOutOfOrder(13), false);
});

test('an unreadable marks file leaves every lock in service', () => {
  fs.writeFileSync(marksFile, '{"outOfOrder": "13"');
  setOutOfOrderFile(marksFile);
  assert.equal(isLockOutOfOrder(13), false);
  fs.writeFileSync(marksFile, '{"outOfOrder": ["13"]}');
  setOutOfOrderFile(marksFile);
  assert.equal(isLockOutOfOrder(13), false);
});

test('retiring a lock drops its mark', () => {
  managedLock();
  setLockOutOfOrder(13, true);
  retireLock(13);
  assert.equal(isLockOutOfOrder(13), false);
  setOutOfOrderFile(marksFile);
  assert.equal(isLockOutOfOrder(13), false);
});

test('marking directly is idempotent', () => {
  markLockOutOfOrder(13, true);
  markLockOutOfOrder(13, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(marksFile, 'utf-8')).outOfOrder, [13]);
});
