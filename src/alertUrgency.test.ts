import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  heaterOnOrDue, linkFaultSeverity, dedupKeyFor, dedupKeysFor, localNetworkOutage, HEATER_DUE_WINDOW_MS,
} from './alertUrgency.js';

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 29, 10, 45); // 3:45 AM Pacific
const slot = (startOffsetMs: number, durationMs: number) =>
  ({ start: new Date(T0 + startOffsetMs), stop: new Date(T0 + startOffsetMs + durationMs) });

test('a cold heater with nothing due is not urgent', () => {
  assert.equal(heaterOnOrDue([], T0, false), false);
  assert.equal(heaterOnOrDue([slot(5 * H, 2 * H)], T0, false), false);
  assert.equal(linkFaultSeverity(false), 'warning');
});

test('a heater that is physically on is urgent even with no plan', () => {
  assert.equal(heaterOnOrDue([], T0, true), true);
  assert.equal(linkFaultSeverity(true), 'critical');
});

test('a slot in progress or starting within the window is urgent', () => {
  assert.equal(heaterOnOrDue([slot(-H, 3 * H)], T0, false), true);
  assert.equal(heaterOnOrDue([slot(HEATER_DUE_WINDOW_MS, 2 * H)], T0, false), true);
  assert.equal(heaterOnOrDue([slot(HEATER_DUE_WINDOW_MS + 1, 2 * H)], T0, false), false);
});

test('a slot that already ended does not count', () => {
  assert.equal(heaterOnOrDue([slot(-3 * H, 2 * H)], T0, false), false);
});

test('low-urgency incidents get their own dedup key; critical keeps the bare key', () => {
  assert.equal(dedupKeyFor('sauna-unreachable-small', 'critical'), 'sauna-unreachable-small');
  assert.equal(dedupKeyFor('sauna-unreachable-small', 'error'), 'sauna-unreachable-small');
  assert.equal(dedupKeyFor('sauna-unreachable-small', 'warning'), 'sauna-unreachable-small-low');
  assert.deepEqual(dedupKeysFor('k'), ['k', 'k-low']);
});

test('every device unreachable while the server is unreachable is a local outage', () => {
  const down = { reachable: false };
  const up = { reachable: true };
  assert.equal(localNetworkOutage([down, down, down], false), true);
  assert.equal(localNetworkOutage([down, down], false), true);
});

test('a device fault is not an outage when the server link is up or another device answers', () => {
  const down = { reachable: false };
  const up = { reachable: true };
  assert.equal(localNetworkOutage([down, down], true), false);
  assert.equal(localNetworkOutage([down, up], false), false);
  assert.equal(localNetworkOutage([], false), false);
});
