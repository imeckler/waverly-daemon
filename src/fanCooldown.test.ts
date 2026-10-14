import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FanCooldownState, newFanCooldown, withReading, stopReason } from './fanCooldown.js';

const MIN = 60_000;
const limits = { minDropF: 0.5, stallMs: 5 * MIN, maxMs: 180 * MIN };

/** Run one cycle: fold the reading in, then ask whether to stop. */
function cycle(state: FanCooldownState, now: number, tempF: number | null, heaterOn = false) {
  const next = withReading(state, now, tempF, limits.minDropF);
  return { state: next, stop: stopReason(next, now, heaterOn, limits) };
}

/** Feed readings at the given minutes and return the first stop reason, with when it fired. */
function run(readings: [minute: number, tempF: number | null][], slotEndedAt = 0) {
  let state = newFanCooldown(slotEndedAt);
  for (const [minute, tempF] of readings) {
    const r = cycle(state, minute * MIN, tempF);
    state = r.state;
    if (r.stop) return { stop: r.stop, atMinute: minute };
  }
  return { stop: null, atMinute: null };
}

test('keeps running while each reading is a new low', () => {
  const r = run([[1, 180], [2, 175], [3, 171], [4, 168], [5, 166], [6, 165]]);
  assert.equal(r.stop, null);
});

test('stops once stallMs pass without a new low; jitter is not a drop', () => {
  const r = run([[1, 150], [2, 149.8], [3, 150.1], [5, 149.7], [6, 149.9]]);
  assert.equal(r.atMinute, 6);
  assert.match(r.stop!, /lowest 150°F/);
});

test('the stall clock restarts at each new low', () => {
  const r = run([[1, 150], [5, 149], [9, 149], [10, 149]]);
  assert.equal(r.atMinute, 10);
});

test('a rising temperature stops the fan after stallMs', () => {
  const r = run([[1, 120], [3, 125], [5, 130], [6, 135]]);
  assert.equal(r.atMinute, 6);
});

test('the heater coming back on stops the fan at once', () => {
  const state = withReading(newFanCooldown(0), 1 * MIN, 150, limits.minDropF);
  assert.equal(stopReason(state, 2 * MIN, true, limits), 'heater is back on');
});

test('without readings the fan keeps running until the cap', () => {
  const r = run([[1, null], [5, null], [100, null], [179, null], [180, null]]);
  assert.equal(r.atMinute, 180);
  assert.match(r.stop!, /cap/);
});

test('a gap in readings does not count as a stall; the next reading decides', () => {
  const r = run([[1, 150], [2, null], [10, null], [11, 150], [12, 149]]);
  assert.equal(r.atMinute, 11);
});

test('the cap is measured from the slot end, even while still cooling', () => {
  const readings: [number, number][] = [];
  for (let m = 11; m <= 190; m++) readings.push([m, 200 - m]);
  const r = run(readings, 10 * MIN);
  assert.equal(r.atMinute, 190);
  assert.match(r.stop!, /180min cap/);
});
