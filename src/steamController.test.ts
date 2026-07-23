// Steam room control, driven end to end over the real TOLO protocol.
//
// The TOLO device simulator speaks the same UDP protocol as the hardware, so
// these tests exercise the whole path — schedule in, packets out — rather than
// stubbing the client. What's being checked is the part that decides *whether
// the room should be on*: the plan, the admin override, and which wins.
//
// The unit is only ever powered on by arming its power timer (never
// setPowerOn(true)), so "we turned it on" reads as the timer being armed to
// POWER_TIMER_MINUTES, and "we turned it off" as powerOn going false.

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

const PORT = 51599; // not the default, so a real unit on the LAN is never touched
const POWER_TIMER_MINUTES = 10; // must match steamController

let simulator: ToloDeviceSimulator;
let probe: ToloClient;

const minutes = (n: number) => n * 60_000;
const period = (fromMin: number, toMin: number): SteamPeriod => ({
  start: new Date(Date.now() + minutes(fromMin)),
  stop: new Date(Date.now() + minutes(toMin)),
  hotFrom: new Date(Date.now() + minutes(fromMin + 60)),
});

before(async () => {
  simulator = new ToloDeviceSimulator('127.0.0.1', PORT);
  await simulator.start();
  probe = new ToloClient('127.0.0.1', PORT);
  startSteamController('127.0.0.1', PORT);
});

after(async () => {
  await stopSteamController();
  await probe.close();
  await simulator.stop();
});

/**
 * Put the device in a state that is neither of the two outcomes, so a test can
 * only pass by the controller actually driving it there: powered on, with no
 * timer armed.
 */
beforeEach(async () => {
  await probe.setPowerOn(true);
  await probe.setPowerTimer(null); // null is how the protocol clears the timer
  const status = await probe.getStatus();
  assert.equal(status.powerOn, true, 'fixture: device should start powered on');
  assert.notEqual(status.powerTimer, POWER_TIMER_MINUTES,
    'fixture: device should not start with our timer already armed');
});

/** Wait for the device to reach a state, or fail with what it actually reached. */
async function waitFor(
  predicate: (s: { powerOn: boolean; powerTimer: number | null }) => boolean,
  what: string,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const status = await probe.getStatus();
    if (predicate(status)) return;
    await new Promise(r => setTimeout(r, 20));
  }
  const status = await probe.getStatus();
  assert.fail(`timed out waiting for ${what}; powerOn=${status.powerOn} powerTimer=${status.powerTimer}`);
}

const expectOn = () =>
  waitFor(s => s.powerTimer === POWER_TIMER_MINUTES, 'the power timer to be armed');
const expectOff = () => waitFor(s => s.powerOn === false, 'the unit to be powered off');

test('a period covering now switches the room on', async () => {
  applySteamSchedule([period(-30, 90)], '2026-03-10');
  await expectOn();
});

test('a period entirely in the future leaves the room off', async () => {
  applySteamSchedule([period(60, 180)], '2026-03-10');
  await expectOff();
});

test('a period that has already ended leaves the room off', async () => {
  applySteamSchedule([period(-180, -60)], '2026-03-10');
  await expectOff();
});

test('an empty plan switches the room off', async () => {
  applySteamSchedule([period(-30, 90)], '2026-03-10');
  await expectOn();
  applySteamSchedule([], '2026-03-11');
  await expectOff();
});

test('a replan that withdraws the period switches the room off', async () => {
  // A cancellation can shrink the day's allowance and take the steam room back
  // out of the plan. The schedule is replaced wholesale, so the withdrawn period
  // must not linger.
  applySteamSchedule([period(-30, 90)], '2026-03-10');
  await expectOn();
  applySteamSchedule([period(120, 240)], '2026-03-10');
  await expectOff();
});

test('the room switches on for the second of several periods', async () => {
  applySteamSchedule(
    [period(-300, -240), period(-10, 50), period(120, 180)],
    '2026-03-10',
  );
  await expectOn();
});

test('an "off" override beats a scheduled period', async () => {
  applySteamSchedule([period(-30, 90)], '2026-03-10');
  await expectOn();
  setSteamOverride('off');
  await expectOff();
});

test('an "on" override runs the room outside any period', async () => {
  applySteamSchedule([period(120, 240)], '2026-03-10');
  await expectOff();
  setSteamOverride('on');
  await expectOn();
});

test('clearing an override hands control back to the plan', async () => {
  applySteamSchedule([period(-30, 90)], '2026-03-10');
  setSteamOverride('off');
  await expectOff();

  setSteamOverride('none');
  await expectOn(); // the period is still current, so the plan takes over

  setSteamOverride('on');
  await expectOn();
  applySteamSchedule([period(120, 240)], '2026-03-10');
  await expectOn(); // still overridden on, despite no current period

  setSteamOverride('none');
  await expectOff(); // ...and now the plan says off
});

test('a plan arriving mid-period switches on immediately, not at the next tick', async () => {
  // The control tick is 30s. A plan that lands after its period has already
  // begun — a booking made minutes before, or a daemon restart — must act at
  // once, or the room loses that much of its warm-up.
  const before = Date.now();
  applySteamSchedule([period(-5, 60)], '2026-03-10');
  await expectOn();
  assert.ok(Date.now() - before < 5_000, 'took too long to act on a mid-period plan');
});
