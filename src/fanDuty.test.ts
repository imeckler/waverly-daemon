import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dutyFanOn, parseFanDuty, NO_FAN_DUTY } from './fanDuty.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 16, 18, 0);
const duty = (percent: number, cycleMinutes = 10) => ({ percent, cycleMs: cycleMinutes * MIN });

test('the cycle opens with the on stretch and is percent of the cycle long', () => {
  // 40% of 10 minutes: on for minutes [0, 4), off for [4, 10).
  assert.equal(dutyFanOn(duty(40), T0, T0), true);
  assert.equal(dutyFanOn(duty(40), T0, T0 + 4 * MIN - 1), true);
  assert.equal(dutyFanOn(duty(40), T0, T0 + 4 * MIN), false);
  assert.equal(dutyFanOn(duty(40), T0, T0 + 10 * MIN - 1), false);
});

test('the cycle repeats', () => {
  assert.equal(dutyFanOn(duty(40), T0, T0 + 10 * MIN), true);
  assert.equal(dutyFanOn(duty(40), T0, T0 + 23 * MIN), true);
  assert.equal(dutyFanOn(duty(40), T0, T0 + 24 * MIN), false);
});

test('the cycle length is honoured', () => {
  // 25% of 20 minutes: on for [0, 5), off for [5, 20).
  assert.equal(dutyFanOn(duty(25, 20), T0, T0 + 5 * MIN - 1), true);
  assert.equal(dutyFanOn(duty(25, 20), T0, T0 + 5 * MIN), false);
  assert.equal(dutyFanOn(duty(25, 20), T0, T0 + 20 * MIN), true);
});

test('the share of time on matches the percentage', () => {
  for (const percent of [10, 33, 50, 75]) {
    for (const cycleMinutes of [2, 10, 60]) {
      let on = 0;
      const steps = 4 * cycleMinutes * 60; // four cycles, second by second
      for (let s = 0; s < steps; s++) if (dutyFanOn(duty(percent, cycleMinutes), T0, T0 + s * 1000)) on++;
      assert.ok(Math.abs(on / steps - percent / 100) < 0.01, `${percent}% of ${cycleMinutes}min: on ${on}/${steps}`);
    }
  }
});

test('0% is never on and 100% always on', () => {
  for (let m = 0; m < 60; m += 0.5) {
    assert.equal(dutyFanOn(duty(0), T0, T0 + m * MIN), false);
    assert.equal(dutyFanOn(duty(100), T0, T0 + m * MIN), true);
  }
});

test('never on before the room reached its target', () => {
  assert.equal(dutyFanOn(duty(100), T0, T0 - 1), false);
});

test('missing fields take the defaults: no fan, 10-minute cycle', () => {
  assert.deepEqual(parseFanDuty(undefined, undefined), NO_FAN_DUTY);
  assert.deepEqual(NO_FAN_DUTY, { percent: 0, cycleMs: 10 * MIN });
  assert.deepEqual(parseFanDuty(null, null), NO_FAN_DUTY);
});

test('valid values are taken as they are', () => {
  assert.deepEqual(parseFanDuty(40, 15), { percent: 40, cycleMs: 15 * MIN });
  assert.deepEqual(parseFanDuty(100, 2), { percent: 100, cycleMs: 2 * MIN });
  assert.deepEqual(parseFanDuty(0, 60), { percent: 0, cycleMs: 60 * MIN });
});

test('an invalid percentage reads as 0 and an invalid cycle as the default, each on its own', () => {
  for (const bad of [-5, 101, Number.NaN, '40']) {
    assert.deepEqual(parseFanDuty(bad, 15), { percent: 0, cycleMs: 15 * MIN });
  }
  for (const bad of [1, 61, 0, Number.NaN, '10']) {
    assert.deepEqual(parseFanDuty(40, bad), { percent: 40, cycleMs: 10 * MIN });
  }
});
