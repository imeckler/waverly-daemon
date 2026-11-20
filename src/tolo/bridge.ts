// The daemon's end of the authenticated link to the ESP32 bridge that stands in
// for the App Box. The protocol is laid out in firmware/tolo-bridge/src/bridge.h:
// a hello, the bridge's challenge, then a request (a TOLO command, or the plan
// the bridge follows while the daemon is out of reach) and its answer, each
// carrying an HMAC-SHA256 over both nonces under the shared key.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const NONCE_LENGTH = 16;
const MAC_LENGTH = 32;
/** The most periods a plan can carry (plan.h). */
export const MAX_PLAN_PERIODS = 8;

const header = (type: number): Buffer => Buffer.from([0x54, 0x42, 1, type]);
const HELLO = header(1);
const CHALLENGE = header(2);

const KINDS = {
  command: { request: header(3), answer: header(4) },
  plan: { request: header(5), answer: header(6) },
};
export type Kind = keyof typeof KINDS;

// Each MAC starts with the header of the datagram it rides in, whose type byte
// keeps the kinds of message apart.
const mac = (key: string, ...parts: Buffer[]): Buffer =>
  createHmac('sha256', key).update(Buffer.concat(parts)).digest();

export const newNonce = (): Buffer => randomBytes(NONCE_LENGTH);

export const hello = (daemonNonce: Buffer): Buffer => Buffer.concat([HELLO, daemonNonce]);

/** The bridge's nonce, if `datagram` is its challenge in answer to our hello; else null. */
export function challengeNonce(datagram: Buffer, daemonNonce: Buffer): Buffer | null {
  const start = Buffer.concat([CHALLENGE, daemonNonce]);
  if (datagram.length !== start.length + NONCE_LENGTH || !datagram.subarray(0, start.length).equals(start)) return null;
  return datagram.subarray(start.length);
}

export function request(kind: Kind, key: string, daemonNonce: Buffer, bridgeNonce: Buffer, body: Buffer): Buffer {
  const k = KINDS[kind];
  return Buffer.concat([k.request, bridgeNonce, body, mac(key, k.request, daemonNonce, bridgeNonce, body)]);
}

/**
 * What the bridge answered to the request carrying `body`, if `datagram` is its
 * authentic answer to it; else null. For a command that is the controller's
 * reply frame, empty if the controller did not answer the bridge; for a plan it
 * is always empty.
 */
export function answer(
  kind: Kind,
  key: string,
  daemonNonce: Buffer,
  bridgeNonce: Buffer,
  body: Buffer,
  datagram: Buffer,
): Buffer | null {
  const k = KINDS[kind];
  const start = Buffer.concat([k.answer, bridgeNonce]);
  const end = datagram.length - MAC_LENGTH;
  if (end < start.length || !datagram.subarray(0, start.length).equals(start)) return null;
  const answered = datagram.subarray(start.length, end);
  const expected = mac(key, k.answer, daemonNonce, bridgeNonce, body, answered);
  return timingSafeEqual(datagram.subarray(end), expected) ? answered : null;
}

/**
 * A plan as the bridge takes it (plan.h): the temperature to hold and the
 * periods to power the room for, as seconds from `now`, so the bridge needs no
 * clock. Periods already over are left out.
 */
export function planBody(targetCelsius: number, periods: { start: number; stop: number }[], now: number): Buffer {
  const seconds = (at: number) => Math.max(0, Math.round((at - now) / 1000));
  const upcoming = periods.map(p => [seconds(p.start), seconds(p.stop)]).filter(([start, stop]) => start < stop);
  if (upcoming.length > MAX_PLAN_PERIODS) throw new Error(`a plan holds at most ${MAX_PLAN_PERIODS} periods`);
  const body = Buffer.alloc(2 + 8 * upcoming.length);
  body.writeUInt8(targetCelsius, 0);
  body.writeUInt8(upcoming.length, 1);
  upcoming.forEach(([start, stop], i) => {
    body.writeUInt32BE(start, 2 + 8 * i);
    body.writeUInt32BE(stop, 6 + 8 * i);
  });
  return body;
}
