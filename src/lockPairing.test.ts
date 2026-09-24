import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LockPairing, PairingController, PairingHooks } from './lockPairing.js';
import { isPairingInProgress } from './lockHealth.js';

// The controller side of pairing, as an event emitter the test drives.
class FakeController extends EventEmitter {
  calls: string[] = [];
  busy = false;
  callbacks: any = null;
  async beginExclusion() { this.calls.push('beginExclusion'); return !this.busy; }
  async stopExclusion() { this.calls.push('stopExclusion'); return true; }
  async beginInclusion(options: any) { this.calls.push('beginInclusion'); this.callbacks = options.userCallbacks; return !this.busy; }
  async stopInclusion() { this.calls.push('stopInclusion'); return true; }
}

function fakeNode(id: number, opts: { ready?: boolean; security?: number; label?: string } = {}) {
  const node = new EventEmitter() as any;
  node.id = id;
  node.ready = opts.ready ?? false;
  node.label = opts.label ?? null;
  node.getHighestSecurityClass = () => opts.security;
  return node;
}

function setup(hooksOverride: Partial<PairingHooks> = {}) {
  const controller = new FakeController();
  const retired: number[] = [];
  const adopted: { serverUrl: string; nodeId: number; replaces: number | null }[] = [];
  const hooks: PairingHooks = {
    listServers: () => [
      { serverUrl: 'https://sauna', description: 'Sauna entrance', lockNodeIds: [11, 13] },
      { serverUrl: 'https://shop', description: 'Printshop', lockNodeIds: [6] },
    ],
    retire: (id) => { retired.push(id); },
    adopt: (serverUrl, node, replaces) => { adopted.push({ serverUrl, nodeId: node.id, replaces }); },
    timeoutMs: 60_000,
    ...hooksOverride,
  };
  const pairing = new LockPairing(controller as unknown as PairingController, hooks);
  return { controller, pairing, retired, adopted };
}

test('idle status lists the servers and asks for nothing', () => {
  const { pairing } = setup();
  const st = pairing.status();
  assert.equal(st.mode, 'idle');
  assert.equal(st.servers.length, 2);
  assert.equal(st.dskPrompt, null);
});

test('exclusion: the lock leaves, it is retired, and the flow ends idle', async () => {
  const { controller, pairing, retired } = setup();
  await pairing.startExclusion();
  assert.equal(pairing.status().mode, 'excluding');
  assert.equal(isPairingInProgress(), true);
  assert.match(pairing.status().instruction, /press button A|programming code/);

  controller.emit('exclusion started');
  controller.emit('node removed', fakeNode(13), 0);
  assert.deepEqual(retired, [13]);
  assert.equal(pairing.status().removedNodeId, 13);

  controller.emit('exclusion stopped');
  const st = pairing.status();
  assert.equal(st.mode, 'idle');
  assert.equal(isPairingInProgress(), false);
  assert.match(st.instruction, /Node 13 is out of the network/);
});

test('an exclusion the controller finishes without a known node says the lock was already out', async () => {
  const { controller, pairing, retired } = setup();
  await pairing.startExclusion();
  controller.emit('exclusion stopped');
  assert.deepEqual(retired, []);
  assert.match(pairing.status().instruction, /already out of the network: go on to inclusion/);
});

test('a second start while busy is refused, and a busy controller is reported', async () => {
  const { controller, pairing } = setup();
  await pairing.startExclusion();
  await assert.rejects(() => pairing.startInclusion('https://sauna', 13), /Already excluding/);
  await pairing.stop();
  assert.equal(pairing.status().mode, 'idle');
  assert.deepEqual(controller.calls, ['beginExclusion', 'stopExclusion']);

  controller.busy = true;
  await assert.rejects(() => pairing.startInclusion('https://sauna', null), /busy/);
  assert.equal(pairing.status().mode, 'idle');
});

test('inclusion of an S0 lock: found, added, ready, adopted for the chosen server', async () => {
  const { controller, pairing, adopted } = setup();
  await assert.rejects(() => pairing.startInclusion('https://nowhere', null), /Unknown lock server/);
  await pairing.startInclusion('https://sauna', 13);
  assert.equal(pairing.status().mode, 'including');

  controller.emit('inclusion started', 0);
  controller.emit('node found', { id: 14 });
  const node = fakeNode(14, { security: 7, label: '912' });
  controller.emit('node added', node, { lowSecurity: false });
  let st = pairing.status();
  assert.equal(st.mode, 'including');
  assert.deepEqual(st.addedNode, { nodeId: 14, label: '912', security: 'S0', ready: false, adopted: false });
  assert.deepEqual(adopted, []);

  node.ready = true;
  node.emit('ready');
  st = pairing.status();
  assert.deepEqual(adopted, [{ serverUrl: 'https://sauna', nodeId: 14, replaces: 13 }]);
  assert.equal(st.addedNode?.adopted, true);
  assert.equal(st.mode, 'idle');
  assert.match(st.instruction, /Done. Node 14 is now a lock for https:\/\/sauna/);
});

test('inclusion of an S2 lock asks for the PIN and passes it to the driver', async () => {
  const { controller, pairing } = setup();
  await pairing.startInclusion('https://sauna', null);

  // The driver asks which classes to grant, then for the PIN.
  const grant = await controller.callbacks.grantSecurityClasses({ securityClasses: [2, 1, 0], clientSideAuth: false });
  assert.deepEqual(grant.securityClasses, [2, 1, 0]);
  const pinPromise: Promise<string | false> = controller.callbacks.validateDSKAndEnterPIN('12345-67890-11111-22222-33333-44444-55555-66666');
  let st = pairing.status();
  assert.equal(st.dskPrompt?.dsk, '12345-67890-11111-22222-33333-44444-55555-66666');
  assert.match(st.instruction, /5-digit PIN/);

  assert.throws(() => pairing.enterPin('12'), /five digits/);
  assert.notEqual(pairing.status().dskPrompt, null);
  pairing.enterPin(' 12345 ');
  assert.equal(await pinPromise, '12345');
  assert.equal(pairing.status().dskPrompt, null);

  const node = fakeNode(15, { security: 2, ready: true, label: 'BE469ZP' });
  controller.emit('node added', node, { lowSecurity: false });
  st = pairing.status();
  assert.equal(st.addedNode?.security, 'S2 Access Control');
  assert.equal(st.addedNode?.adopted, true);
  assert.equal(st.mode, 'idle');
});

test('cancelling the PIN aborts the secure bootstrap', async () => {
  const { controller, pairing } = setup();
  await pairing.startInclusion('https://sauna', null);
  const pinPromise: Promise<string | false> = controller.callbacks.validateDSKAndEnterPIN('11111-22222');
  pairing.enterPin(null);
  assert.equal(await pinPromise, false);
  assert.throws(() => pairing.enterPin('12345'), /not asking for a PIN/);
});

test('a lock that joins without security is not adopted', async () => {
  const { controller, pairing, adopted } = setup();
  await pairing.startInclusion('https://sauna', 13);
  const node = fakeNode(16, { ready: true });
  controller.emit('node added', node, { lowSecurity: true, lowSecurityReason: 5 });
  const st = pairing.status();
  assert.equal(st.mode, 'idle');
  assert.match(st.addedNode?.security ?? '', /PIN did not match/);
  assert.match(st.instruction, /WITHOUT security/);
  node.emit('ready');
  assert.deepEqual(adopted, []);
});

test('stopping mid-inclusion aborts a pending PIN and leaves inclusion mode', async () => {
  const { controller, pairing } = setup();
  await pairing.startInclusion('https://sauna', null);
  const pinPromise: Promise<string | false> = controller.callbacks.validateDSKAndEnterPIN('11111-22222');
  await pairing.stop();
  assert.equal(await pinPromise, false);
  assert.equal(pairing.status().mode, 'idle');
  assert.ok(controller.calls.includes('stopInclusion'));
});

test('inclusion stopping with no lock joined ends the flow', async () => {
  const { controller, pairing } = setup();
  await pairing.startInclusion('https://sauna', null);
  controller.emit('inclusion stopped');
  assert.equal(pairing.status().mode, 'idle');
  assert.match(pairing.status().instruction, /without a lock joining/);
});

test('an adoption that throws is reported, not swallowed', async () => {
  const { controller, pairing } = setup({ adopt: () => { throw new Error('No lock server https://sauna'); } });
  await pairing.startInclusion('https://sauna', null);
  controller.emit('node added', fakeNode(17, { ready: true, security: 7 }), { lowSecurity: false });
  const st = pairing.status();
  assert.equal(st.addedNode?.adopted, false);
  assert.match(st.instruction, /could not be adopted: No lock server/);
});

test('the pairing times out and stops on its own', async () => {
  const { controller, pairing } = setup({ timeoutMs: 20 });
  await pairing.startExclusion();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(pairing.status().mode, 'idle');
  assert.ok(controller.calls.includes('stopExclusion'));
  assert.match(pairing.status().log.map(l => l.text).join('\n'), /No lock responded/);
});
