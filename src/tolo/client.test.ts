// The TOLO App Box is a serial-to-UDP bridge, and datagram boundaries are not
// reliably frame boundaries: in production the 24-byte GET_STATUS reply has
// arrived as two datagrams, the second beginning with the zero bytes of the
// status payload — which the client used to reject as "unknown command code 0"
// and fail the whole request. These tests drive the client with a fake device
// that answers in whatever pieces the test dictates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dgram from 'node:dgram';

import { ToloClient } from './client.js';
import { Command } from './enums.js';
import { Message } from './message.js';

const STATUS_EXTRA = Buffer.from([1, 45, 10, 0x41, 0, 0, 0, 0, 2, 0, 61, 90, 50, 0, 0, 0, 30]);

/** A fake device that replies to every request with `pieces` of the status frame. */
async function withDevice(
  split: (frame: Buffer) => Buffer[],
  run: (client: ToloClient) => Promise<void>,
): Promise<void> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (data, sender) => {
    const request = Message.fromBytes(data);
    assert.equal(request.command, Command.GET_STATUS);
    const reply = new Message(Command.GET_STATUS, 0x11, STATUS_EXTRA).toBytes();
    for (const piece of split(reply)) socket.send(piece, sender.port, sender.address);
  });
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  const client = new ToloClient('127.0.0.1', socket.address().port, 0.2, 2);
  try {
    await run(client);
  } finally {
    await client.close();
    await new Promise<void>(resolve => socket.close(resolve));
  }
}

test('a status reply in one datagram parses', async () => {
  await withDevice(frame => [frame], async client => {
    const status = await client.getStatus();
    assert.equal(status.powerOn, true);
    assert.equal(status.currentTemperature, 45);
    assert.equal(status.powerTimer, 10);
    assert.equal(status.saltBathTimer, 30);
  });
});

test('a status reply split across two datagrams is reassembled', async () => {
  // Split so the second datagram starts with a 0x00 — exactly the production case.
  await withDevice(frame => [frame.subarray(0, 8), frame.subarray(8)], async client => {
    const status = await client.getStatus();
    assert.equal(status.currentTemperature, 45);
    assert.equal(status.saltBathTimer, 30);
  });
});

test('a status reply split byte by byte is reassembled', async () => {
  await withDevice(frame => [...frame].map(b => Buffer.from([b])), async client => {
    const status = await client.getStatus();
    assert.equal(status.currentTemperature, 45);
  });
});

test('noise ahead of the reply is discarded, not fatal', async () => {
  const noise = Buffer.from([0x00, 0x00, 0x13, 0x37]);
  await withDevice(frame => [noise, frame], async client => {
    const status = await client.getStatus();
    assert.equal(status.currentTemperature, 45);
  });
});

test('a keep-alive byte between the halves is ignored', async () => {
  await withDevice(frame => [frame.subarray(0, 10), Buffer.from([0x2b]), frame.subarray(10)], async client => {
    const status = await client.getStatus();
    assert.equal(status.currentTemperature, 45);
  });
});

test('concurrent requests on one client all get their own reply', async () => {
  await withDevice(frame => [frame.subarray(0, 5), frame.subarray(5)], async client => {
    const results = await Promise.all([client.getStatus(), client.getStatus(), client.getStatus()]);
    for (const status of results) assert.equal(status.currentTemperature, 45);
  });
});
