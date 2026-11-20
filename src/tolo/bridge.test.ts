// The client's exchange with the ESP32 bridge, against a stand-in that follows
// firmware/tolo-bridge/src/bridge.h: one open challenge, good for one command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import * as dgram from 'node:dgram';

import { planBody } from './bridge.js';
import { ToloClient, ToloCommunicationError } from './client.js';
import { Command } from './enums.js';
import { Message } from './message.js';

const KEY = 'a'.repeat(64);
const STATUS = new Message(Command.GET_STATUS, 0x11, Buffer.from([1, 45, 10, 0x41, 0, 0, 0, 0, 2, 0, 61, 90, 50, 0, 0, 0, 30]));

type Bridge = { port: number; requests: Buffer[]; plans: Buffer[]; datagrams: Buffer[]; close: () => Promise<void> };

/** A bridge holding `key`, whose controller answers every request with `answer`. */
async function startBridge(key: string, answer: Buffer, forgeReplies = false, silentFor = 0): Promise<Bridge> {
  const socket = dgram.createSocket('udp4');
  const requests: Buffer[] = [];
  const plans: Buffer[] = [];
  const datagrams: Buffer[] = [];
  let open: { daemon: Buffer; bridge: Buffer } | null = null;
  const mac = (...parts: Buffer[]) => createHmac('sha256', key).update(Buffer.concat(parts)).digest();

  socket.on('message', (data, sender) => {
    datagrams.push(data);
    const send = (type: number, ...parts: Buffer[]) =>
      socket.send(Buffer.concat([Buffer.from([0x54, 0x42, 1, type]), ...parts]), sender.port, sender.address);
    if (data[3] === 1 && data.length === 20) {
      open = { daemon: data.subarray(4), bridge: randomBytes(16) };
      send(2, open.daemon, open.bridge);
    } else if ((data[3] === 3 || data[3] === 5) && open && data.subarray(4, 20).equals(open.bridge)) {
      const isPlan = data[3] === 5;
      const body = data.subarray(20, data.length - 32);
      if (!data.subarray(data.length - 32).equals(mac(data.subarray(0, 4), open.daemon, open.bridge, body))) return;
      (isPlan ? plans : requests).push(body);
      const answered = isPlan || requests.length <= silentFor ? Buffer.alloc(0) : answer;
      const answerHeader = Buffer.from([0x54, 0x42, 1, isPlan ? 6 : 4]);
      const answerMac = mac(answerHeader, open.daemon, open.bridge, body, answered);
      if (forgeReplies) answerMac[0] ^= 1;
      send(isPlan ? 6 : 4, open.bridge, answered, answerMac);
      open = null;
    }
  });
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    requests,
    plans,
    datagrams,
    close: () => new Promise(resolve => socket.close(() => resolve())),
  };
}

async function withClient(bridge: Bridge, key: string, run: (client: ToloClient) => Promise<void>): Promise<void> {
  const client = new ToloClient('127.0.0.1', bridge.port, 0.2, 2, key);
  try {
    await run(client);
  } finally {
    await client.close();
    await bridge.close();
  }
}

test('a request goes through the bridge and its reply parses', async () => {
  const bridge = await startBridge(KEY, STATUS.toBytes());
  await withClient(bridge, KEY, async client => {
    const status = await client.getStatus();
    assert.equal(status.currentTemperature, 45);
    assert.deepEqual(bridge.requests, [Buffer.from('aaaa6111ff55558f', 'hex')]);
  });
});

test('a client with the wrong key reaches nothing, and is told the key is the likely cause', async () => {
  const bridge = await startBridge(KEY, STATUS.toBytes());
  await withClient(bridge, 'b'.repeat(64), async client => {
    await assert.rejects(client.getStatus(), /tolo_key/);
    assert.deepEqual(bridge.requests, []);
  });
});

test('a reply whose MAC does not verify is not believed', async () => {
  const bridge = await startBridge(KEY, STATUS.toBytes(), true);
  await withClient(bridge, KEY, async client => {
    await assert.rejects(client.getStatus(), ToloCommunicationError);
  });
});

test('a captured command is refused when replayed', async () => {
  const bridge = await startBridge(KEY, new Message(Command.SET_POWER_ON, 1, Buffer.from([0])).toBytes());
  await withClient(bridge, KEY, async client => {
    assert.equal(await client.setPowerOn(true), true);
    const captured = bridge.datagrams.find(d => d[3] === 3);
    assert.ok(captured);
    const socket = dgram.createSocket('udp4');
    await new Promise<void>(resolve => socket.send(captured, bridge.port, '127.0.0.1', () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 100));
    socket.close();
    assert.equal(bridge.requests.length, 1);
  });
});

test('a controller that does not answer the bridge is reported as such', async () => {
  const bridge = await startBridge(KEY, Buffer.alloc(0));
  await withClient(bridge, KEY, async client => {
    await assert.rejects(client.getStatus(), /no answer from the controller/);
  });
});

test('a plan reaches the bridge as seconds from now, without the periods already over', async () => {
  const bridge = await startBridge(KEY, STATUS.toBytes());
  await withClient(bridge, KEY, async client => {
    const now = 1_800_000_000_000;
    const periods = [
      { start: now - 7_200_000, stop: now - 3_600_000 },
      { start: now - 600_000, stop: now + 1_800_000 },
      { start: now + 3_600_000, stop: now + 7_200_000 },
    ];
    assert.deepEqual(planBody(50, periods, now), Buffer.from('3202' + '00000000' + '00000708' + '00000e10' + '00001c20', 'hex'));
    await client.sendPlan(50, [{ start: Date.now() - 600_000, stop: Date.now() + 1_800_000 }]);
    assert.equal(bridge.plans.length, 1);
    assert.deepEqual(bridge.plans[0].subarray(0, 6), Buffer.from('320100000000', 'hex'));
    assert.ok(Math.abs(bridge.plans[0].readUInt32BE(6) - 1800) <= 1);
    assert.deepEqual(bridge.requests, []);
  });
});

test('a controller that misses one request is asked again', async () => {
  const bridge = await startBridge(KEY, STATUS.toBytes(), false, 1);
  await withClient(bridge, KEY, async client => {
    assert.equal((await client.getStatus()).currentTemperature, 45);
    assert.equal(bridge.requests.length, 2);
  });
});

test('a plan sent with the wrong key does not reach the bridge', async () => {
  const bridge = await startBridge(KEY, STATUS.toBytes());
  await withClient(bridge, 'b'.repeat(64), async client => {
    await assert.rejects(client.sendPlan(50, []), /tolo_key/);
    assert.deepEqual(bridge.plans, []);
  });
});
