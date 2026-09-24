import { LockPairing } from './lockPairing';

// The schedule client is created before the Z-Wave driver is ready, so it
// looks the pairing state machine up at request time.
let current: LockPairing | null = null;

export function setLockPairing(pairing: LockPairing): void {
  current = pairing;
}

export function lockPairing(): LockPairing | null {
  return current;
}
