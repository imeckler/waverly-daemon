// The session fan duty cycle for the steam room, driven end to end over the
// real TOLO protocol against the device simulator (see steamFanCooldown.test.ts
// for the approach). The timing itself is covered in fanDuty.test.ts; what's
// checked here is the wiring: nothing happens until the room reaches its
// target, the fan then cycles with its timer armed, 0% leaves the fan alone,
// a fan started at the panel is not switched off, and a duty fan running when
// the session ends is carried into the cooldown.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ToloClient, ToloDeviceSimulator } from './tolo/index.js';
import {
  applySteamSchedule,
  setSteamFanDuty,
  setSteamOverride,
  startSteamController,
  stopSteamController,
  type SteamPeriod,
} from './steamController.js';

const PORT = 51597; // not the default, and not the cooldown test's
const FAN_TIMER_MINUTES = 10; // must match steamController
const TARGET_C = 50; // must match steamController's TARGET_TEMPERATURE_C
const TICK_MS = 20;
const CYCLE_MS = 600;
const LIMITS = { minDropF: 0.5, stallMs: 300, maxMs: 1500 };

let simulator: ToloDeviceSimulator;
let probe: ToloClient;

const minutes = (n: number) => n * 60_000;
const period = (fromMin: number, toMin: number): SteamPeriod => ({
  start: new Date(Date.now() + minutes(fromMin)),
  stop: new Date(Date.now() + minutes(toMin)),
  hotFrom: null,
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

async function waitFor(predicate: (s: Seen) => boolean, what: string, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate(await probe.getStatus())) return;
    await sleep(10);
  }
  const s = await probe.getStatus();
  assert.fail(`timed out waiting for ${what}; powerOn=${s.powerOn} fanOn=${s.fanOn} fanTimer=${s.fanTimer}`);
}

const expectFanOn = () => waitFor(s => s.fanOn && s.fanTimer === FAN_TIMER_MINUTES, 'the fan to be on with its timer armed');
const expectFanOff = () => waitFor(s => !s.fanOn, 'the fan to be off');

/** Room off and cool, fan off, then a session under way below the target. */
beforeEach(async () => {
  setSteamOverride('none');
  setSteamFanDuty({ percent: 0, cycleMs: CYCLE_MS });
  applySteamSchedule([], '2026-03-10');
  await waitFor(s => !s.powerOn, 'the room to be off');
  simulator.setCurrentTemperature(30);
  await sleep(LIMITS.maxMs + 3 * TICK_MS); // any cooldown left by the previous test has capped out
  await probe.setFanOn(false);
  await probe.setFanTimer(null);
  simulator.setCurrentTemperature(TARGET_C - 5);
  applySteamSchedule([period(-30, 90)], '2026-03-10');
  await waitFor(s => s.powerOn, 'the room to be on');
});

test('the fan is left off until the room reaches its target', async () => {
  setSteamFanDuty({ percent: 50, cycleMs: CYCLE_MS });
  await sleep(CYCLE_MS);
  assert.equal((await probe.getStatus()).fanOn, false);
});

test('at temperature the fan cycles on and off, timer armed while on', async () => {
  setSteamFanDuty({ percent: 50, cycleMs: CYCLE_MS });
  simulator.setCurrentTemperature(TARGET_C);
  await expectFanOn(); // each cycle opens with the on stretch
  await expectFanOff();
  await expectFanOn();
  await expectFanOff();
});

test('the room levelling off a degree short still counts as at temperature', async () => {
  setSteamFanDuty({ percent: 50, cycleMs: CYCLE_MS });
  simulator.setCurrentTemperature(TARGET_C - 1);
  await expectFanOn();
});

test('the cycle keeps going after the room dips below the target', async () => {
  setSteamFanDuty({ percent: 50, cycleMs: CYCLE_MS });
  simulator.setCurrentTemperature(TARGET_C);
  await expectFanOn();
  simulator.setCurrentTemperature(TARGET_C - 4); // the fan doing its job
  await expectFanOff();
  await expectFanOn();
});

test('the fan timer is re-armed every tick of an on stretch', async () => {
  setSteamFanDuty({ percent: 100, cycleMs: CYCLE_MS });
  simulator.setCurrentTemperature(TARGET_C);
  await expectFanOn();
  await probe.setFanTimer(3); // as if minutes had ticked by on the device
  await waitFor(s => s.fanTimer === FAN_TIMER_MINUTES, 'the fan timer to be re-armed');
});

test('a duty fan found off mid-stretch is switched back on', async () => {
  setSteamFanDuty({ percent: 100, cycleMs: CYCLE_MS });
  simulator.setCurrentTemperature(TARGET_C);
  await expectFanOn();
  await probe.setFanOn(false); // a lapsed timer
  await expectFanOn();
});

test('at 0% the fan is never switched on, and one started at the panel is left on', async () => {
  simulator.setCurrentTemperature(TARGET_C);
  await sleep(CYCLE_MS);
  assert.equal((await probe.getStatus()).fanOn, false, 'the duty cycle should not start the fan');
  await probe.setFanOn(true);
  await sleep(CYCLE_MS);
  assert.equal((await probe.getStatus()).fanOn, true, 'the panel fan should be left alone');
});

test('setting the duty to 0 mid-stretch switches the fan off', async () => {
  setSteamFanDuty({ percent: 100, cycleMs: CYCLE_MS });
  simulator.setCurrentTemperature(TARGET_C);
  await expectFanOn();
  setSteamFanDuty({ percent: 0, cycleMs: CYCLE_MS });
  await expectFanOff();
});

test('a duty fan running when the session ends carries on as the cooldown', async () => {
  setSteamFanDuty({ percent: 100, cycleMs: CYCLE_MS });
  simulator.setCurrentTemperature(TARGET_C);
  await expectFanOn();
  applySteamSchedule([period(120, 240)], '2026-03-10');
  await waitFor(s => !s.powerOn, 'the room to be off');
  for (const c of [49, 48, 47]) {
    simulator.setCurrentTemperature(c);
    await sleep(LIMITS.stallMs / 2);
    assert.equal((await probe.getStatus()).fanOn, true, `fan should still be on cooling at ${c}°C`);
  }
  await expectFanOff(); // stalls out like any cooldown
});

test('a new cycle length takes effect mid-session', async () => {
  setSteamFanDuty({ percent: 50, cycleMs: 60_000 }); // a 30s on stretch: steady for this test
  simulator.setCurrentTemperature(TARGET_C);
  await expectFanOn();
  await sleep(CYCLE_MS);
  assert.equal((await probe.getStatus()).fanOn, true, 'still in the long on stretch');
  setSteamFanDuty({ percent: 50, cycleMs: CYCLE_MS });
  await expectFanOff();
  await expectFanOn();
});
