// Post-session fan cooldown for the steam room, driven end to end over the
// real TOLO protocol against the device simulator (see steamController.test.ts
// for the approach). The cooling decision itself is covered in
// fanCooldown.test.ts; what's checked here is the wiring: the fan comes on with
// its timer when a session ends, is kept armed while the room cools, and goes
// off when the room stops cooling, the room comes back on, or the fan is found
// off. A fast control tick and short limits keep each test under a second.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ToloClient, ToloDeviceSimulator } from './tolo/index.js';
import {
  applySteamSchedule,
  setSteamOverride,
  startSteamController,
  stopSteamController,
  type SteamPeriod,
} from './steamController.js';

const PORT = 51598; // not the default, so a real unit on the LAN is never touched
const FAN_TIMER_MINUTES = 10; // must match steamController
const TICK_MS = 20;
const LIMITS = { minDropF: 0.5, stallMs: 200, maxMs: 1500 };

let simulator: ToloDeviceSimulator;
let probe: ToloClient;

const minutes = (n: number) => n * 60_000;
const period = (fromMin: number, toMin: number): SteamPeriod => ({
  start: new Date(Date.now() + minutes(fromMin)),
  stop: new Date(Date.now() + minutes(toMin)),
  hotFrom: new Date(Date.now() + minutes(fromMin + 60)),
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

before(async () => {
  simulator = new ToloDeviceSimulator('127.0.0.1', PORT);
  await simulator.start();
  probe = new ToloClient('127.0.0.1', PORT);
  startSteamController('127.0.0.1', PORT, { controlIntervalMs: TICK_MS, fanCooldown: LIMITS });
});

after(async () => {
  await stopSteamController();
  await probe.close();
  await simulator.stop();
});

type Seen = { powerOn: boolean; fanOn: boolean; fanTimer: number | null };

async function waitFor(predicate: (s: Seen) => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const status = await probe.getStatus();
    if (predicate(status)) return;
    await sleep(10);
  }
  const s = await probe.getStatus();
  assert.fail(`timed out waiting for ${what}; powerOn=${s.powerOn} fanOn=${s.fanOn} fanTimer=${s.fanTimer}`);
}

const expectRoomOn = () => waitFor(s => s.powerOn, 'the room to be on');
const expectRoomOff = () => waitFor(s => !s.powerOn, 'the room to be off');
const expectFanOn = () => waitFor(s => s.fanOn && s.fanTimer === FAN_TIMER_MINUTES, 'the fan to be on with its timer armed');
const expectFanOff = () => waitFor(s => !s.fanOn, 'the fan to be off');

/** Room on in a session, fan off, at a steady hot temperature; no cooldown in progress. */
beforeEach(async () => {
  setSteamOverride('none');
  applySteamSchedule([], '2026-03-10');
  await expectRoomOff();
  await probe.setFanOn(false);
  await probe.setFanTimer(null);
  simulator.setCurrentTemperature(48);
  await sleep(LIMITS.maxMs + 3 * TICK_MS); // any cooldown left by the previous test has capped out
  await probe.setFanOn(false);
  applySteamSchedule([period(-30, 90)], '2026-03-10');
  await expectRoomOn();
  await sleep(3 * TICK_MS);
  assert.equal((await probe.getStatus()).fanOn, false, 'fixture: fan should be off during the session');
});

/** End the session by taking its period out of the plan. */
function endSession(): void {
  applySteamSchedule([period(120, 240)], '2026-03-10');
}

test('the fan comes on with its timer armed when the session ends', async () => {
  endSession();
  await expectRoomOff();
  await expectFanOn();
});

test('the fan keeps running while the room keeps cooling, and stops once it stops', async () => {
  endSession();
  await expectFanOn();
  for (const c of [47, 46, 45, 44, 43]) {
    simulator.setCurrentTemperature(c);
    await sleep(LIMITS.stallMs / 2);
    assert.equal((await probe.getStatus()).fanOn, true, `fan should still be on at ${c}°C`);
  }
  await expectFanOff();
});

test('the fan timer is re-armed every tick while the cooldown runs', async () => {
  endSession();
  await expectFanOn();
  await probe.setFanTimer(3); // as if minutes had ticked by on the device
  await waitFor(s => s.fanTimer === FAN_TIMER_MINUTES, 'the fan timer to be re-armed');
});

test('a rising temperature stops the fan after the stall window', async () => {
  endSession();
  await expectFanOn();
  simulator.setCurrentTemperature(50);
  await expectFanOff();
});

test('the room coming back on stops the fan at once', async () => {
  endSession();
  await expectFanOn();
  setSteamOverride('on');
  await expectRoomOn();
  await expectFanOff();
});

test('a fan switched off at the panel is left off', async () => {
  endSession();
  await expectFanOn();
  await probe.setFanOn(false);
  await sleep(5 * TICK_MS);
  assert.equal((await probe.getStatus()).fanOn, false);
});

test('the cap stops the fan even while the room is still cooling', async () => {
  endSession();
  await expectFanOn();
  const started = Date.now();
  const cooling = setInterval(() => simulator.setCurrentTemperature(48 - Math.floor((Date.now() - started) / 100)), 50);
  try {
    await sleep(LIMITS.maxMs - 2 * LIMITS.stallMs);
    assert.equal((await probe.getStatus()).fanOn, true, 'fan should still be on before the cap');
    await expectFanOff();
  } finally {
    clearInterval(cooling);
  }
});

test('a plan re-sent mid-cooldown picks the cooldown up where it is', async () => {
  endSession();
  await expectFanOn();
  // The plan arrives again (a daemon restart replays it) with the period already over.
  applySteamSchedule([period(-90, -0.001), period(120, 240)], '2026-03-10');
  await sleep(5 * TICK_MS);
  assert.equal((await probe.getStatus()).fanOn, true, 'the running fan should be kept');
  for (const c of [47, 46]) {
    simulator.setCurrentTemperature(c);
    await sleep(LIMITS.stallMs / 2);
    assert.equal((await probe.getStatus()).fanOn, true, `fan should still be on at ${c}°C`);
  }
  await expectFanOff();
});

test('a re-sent plan does not restart a cooldown that has finished', async () => {
  endSession();
  await expectFanOn();
  await expectFanOff(); // steady temperature: stalls out
  applySteamSchedule([period(-90, -0.001), period(120, 240)], '2026-03-10');
  await sleep(5 * TICK_MS);
  assert.equal((await probe.getStatus()).fanOn, false, 'the fan should not be brought back');
});
