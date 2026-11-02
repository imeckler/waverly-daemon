import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronTimespec } from './cronTimespec.js';

const LA = 'America/Los_Angeles';

test('PDT instant formats at UTC-7', () => {
  assert.equal(cronTimespec(new Date('2026-10-31T23:15:00Z'), LA), '0 15 16 31 10 *');
});

test('PST instant formats at UTC-8 (2026-11-01 slot that fired an hour late)', () => {
  assert.equal(cronTimespec(new Date('2026-11-02T00:15:00Z'), LA), '0 15 16 1 11 *');
});

test('slot on the far side of a DST change uses that side’s offset', () => {
  // Spring forward 2027-03-14: 18:00 PDT is 01:00Z next day.
  assert.equal(cronTimespec(new Date('2027-03-15T01:00:00Z'), LA), '0 0 18 14 3 *');
});

test('midnight renders as hour 0', () => {
  assert.equal(cronTimespec(new Date('2026-11-02T08:00:00Z'), LA), '0 0 0 2 11 *');
});
