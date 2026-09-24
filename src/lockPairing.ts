import { InclusionStrategy, ExclusionStrategy, ZWaveNode } from 'zwave-js';
import type { InclusionGrant, InclusionResult, FoundNode, RemoveNodeReason } from 'zwave-js';

// @zwave-js/core's SecurityClass enum, which zwave-js does not re-export.
const SECURITY_NONE = -1;
const SECURITY_NAMES: Record<number, string> = {
  0: 'S2 Unauthenticated',
  1: 'S2 Authenticated',
  2: 'S2 Access Control',
  7: 'S0',
};
import { LockPairingStatus, LockServerInfo } from '@waverly/sauna-protocol';
import { setPairingInProgress } from './lockHealth';

// ---------------------------------------------------------------------------
// Assisted pairing.
//
// Z-Wave inclusion and exclusion both need the lock put into learn mode by
// hand, and S2 inclusion (the Schlage) needs the PIN from the lock's label.
// So the daemon cannot re-pair a lock on its own; what it can do is run the
// controller side and tell the person at the lock what to do next. This
// module is that state machine. The admin page polls status() and renders
// `instruction`, the log, and the DSK prompt.
//
// The controller is abstracted to the handful of calls and events used, so the
// flow can be tested without a Z-Wave stick.
// ---------------------------------------------------------------------------

/** How long the controller stays in inclusion or exclusion mode before the daemon gives up. */
export const PAIRING_TIMEOUT_MS = 5 * 60 * 1000;

export interface PairingController {
  beginExclusion(options: { strategy: ExclusionStrategy }): Promise<boolean>;
  stopExclusion(): Promise<boolean>;
  beginInclusion(options: {
    strategy: InclusionStrategy.Default;
    forceSecurity: boolean;
    userCallbacks: {
      grantSecurityClasses(requested: InclusionGrant): Promise<InclusionGrant | false>;
      validateDSKAndEnterPIN(dsk: string): Promise<string | false>;
      abort(): void;
    };
  }): Promise<boolean>;
  stopInclusion(): Promise<boolean>;
  on(event: 'exclusion started' | 'exclusion stopped' | 'exclusion failed' | 'inclusion stopped' | 'inclusion failed', fn: () => void): unknown;
  on(event: 'inclusion started', fn: (strategy: InclusionStrategy) => void): unknown;
  on(event: 'node found', fn: (node: FoundNode) => void): unknown;
  on(event: 'node added', fn: (node: ZWaveNode, result: InclusionResult) => void): unknown;
  on(event: 'node removed', fn: (node: ZWaveNode, reason: RemoveNodeReason) => void): unknown;
}

export interface PairingHooks {
  listServers(): LockServerInfo[];
  /** A managed lock left the network. */
  retire(nodeId: number): void;
  /** A new lock is ready; take it on for the server. */
  adopt(serverUrl: string, node: ZWaveNode, replacesNodeId: number | null): void;
  clock?: () => number;
  timeoutMs?: number;
}

export const LEARN_MODE_STEPS =
  'Kwikset: press button A once on the inside panel. Schlage: enter the 6-digit programming code, then press 0.';

export class LockPairing {
  private st: LockPairingStatus;
  private pinResolver: ((pin: string | false) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly controller: PairingController, private readonly hooks: PairingHooks) {
    this.clock = hooks.clock ?? (() => Date.now());
    this.timeoutMs = hooks.timeoutMs ?? PAIRING_TIMEOUT_MS;
    this.st = {
      mode: 'idle',
      instruction: 'Nothing in progress.',
      log: [],
      dskPrompt: null,
      serverUrl: null,
      replacesNodeId: null,
      removedNodeId: null,
      addedNode: null,
      servers: [],
    };
    this.attach();
  }

  status(): LockPairingStatus {
    return { ...this.st, log: [...this.st.log], servers: this.hooks.listServers() };
  }

  private log(text: string): void {
    console.log(`Lock pairing: ${text}`);
    this.st.log.push({ at: new Date(this.clock()).toISOString(), text });
    if (this.st.log.length > 50) this.st.log.shift();
  }

  private armTimeout(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.st.mode === 'idle') return;
      this.log(`No lock responded within ${Math.round(this.timeoutMs / 60000)} minutes; stopping`);
      this.stop().catch(e => console.error('Lock pairing: stop after timeout failed:', e));
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private attach(): void {
    const c = this.controller;
    c.on('exclusion started', () => this.log('Controller is in exclusion mode'));
    c.on('exclusion failed', () => {
      this.log('Exclusion failed');
      this.finish('Exclusion failed. Try again.');
    });
    c.on('exclusion stopped', () => {
      if (this.st.mode !== 'excluding') return;
      // A lock that answers the button press but was not a member of this
      // network (it had reset itself) is reported by the controller as node 0,
      // which zwave-js does not surface as a removal. Either way it is out.
      this.finish(this.st.removedNodeId === null
        ? 'Exclusion finished without removing a managed lock. If the lock reacted when you pressed the button, it was already out of the network: go on to inclusion.'
        : `Node ${this.st.removedNodeId} is out of the network. Start inclusion to pair the lock again.`);
    });
    c.on('node removed', (node, reason) => {
      this.st.removedNodeId = node.id;
      this.log(`Node ${node.id} left the network (${describeRemoval(reason)})`);
      this.hooks.retire(node.id);
      if (this.st.mode === 'excluding') {
        this.st.instruction = `Node ${node.id} removed. The controller will leave exclusion mode shortly.`;
      }
    });

    c.on('inclusion started', (strategy) => this.log(`Controller is in inclusion mode (${InclusionStrategy[strategy] ?? strategy})`));
    c.on('inclusion failed', () => {
      this.log('Inclusion failed');
      this.finish('Inclusion failed. Exclude the lock and try again.');
    });
    c.on('node found', (node) => {
      this.log(`Found a device, node ${node.id}; bootstrapping security`);
      this.st.instruction = `Found the lock as node ${node.id}. Leave it alone while it pairs.`;
    });
    c.on('node added', (node, result) => this.onNodeAdded(node, result));
    c.on('inclusion stopped', () => {
      if (this.st.mode !== 'including') return;
      if (this.st.addedNode === null) this.finish('Inclusion stopped without a lock joining.');
      // Otherwise the interview is still running; onNodeAdded finishes the flow.
    });
  }

  private finish(instruction: string): void {
    this.clearTimer();
    this.abortPin();
    this.st.mode = 'idle';
    this.st.instruction = instruction;
    setPairingInProgress(false);
  }

  private abortPin(): void {
    if (this.pinResolver) {
      const resolve = this.pinResolver;
      this.pinResolver = null;
      this.st.dskPrompt = null;
      resolve(false);
    }
  }

  async startExclusion(): Promise<void> {
    if (this.st.mode !== 'idle') throw new Error(`Already ${this.st.mode}`);
    this.st.log = [];
    this.st.removedNodeId = null;
    this.st.addedNode = null;
    this.st.dskPrompt = null;
    const ok = await this.controller.beginExclusion({ strategy: ExclusionStrategy.ExcludeOnly });
    if (!ok) throw new Error('The controller is busy and could not enter exclusion mode');
    this.st.mode = 'excluding';
    setPairingInProgress(true);
    this.st.instruction = `Put the lock in exclusion mode now. ${LEARN_MODE_STEPS}`;
    this.log('Exclusion requested');
    this.armTimeout();
  }

  async startInclusion(serverUrl: string, replacesNodeId: number | null): Promise<void> {
    if (this.st.mode !== 'idle') throw new Error(`Already ${this.st.mode}`);
    const server = this.hooks.listServers().find(s => s.serverUrl === serverUrl);
    if (!server) throw new Error(`Unknown lock server ${serverUrl}`);
    this.st.log = [];
    this.st.addedNode = null;
    this.st.dskPrompt = null;
    this.st.serverUrl = serverUrl;
    this.st.replacesNodeId = replacesNodeId;
    const ok = await this.controller.beginInclusion({
      strategy: InclusionStrategy.Default,
      // A lock's User Code command class is only offered over the secure
      // channel. zwave-js bootstraps S2 on its own but S0 only when forced;
      // without this a Kwikset joins unencrypted and is useless.
      forceSecurity: true,
      userCallbacks: {
        grantSecurityClasses: async (requested) => {
          this.log(`Lock asks for ${requested.securityClasses.map(describeSecurityClass).join(', ')}; granting all`);
          return requested;
        },
        validateDSKAndEnterPIN: (dsk) => this.promptForPin(dsk),
        abort: () => {
          this.log('Security bootstrap aborted by the driver');
          this.abortPin();
        },
      },
    });
    if (!ok) throw new Error('The controller is busy and could not enter inclusion mode');
    this.st.mode = 'including';
    setPairingInProgress(true);
    this.st.instruction = `Put the lock in inclusion mode now. ${LEARN_MODE_STEPS}`;
    this.log(`Inclusion requested for ${server.description ?? serverUrl}${replacesNodeId !== null ? `, replacing node ${replacesNodeId}` : ''}`);
    this.armTimeout();
  }

  private promptForPin(dsk: string): Promise<string | false> {
    this.abortPin();
    this.st.dskPrompt = { dsk };
    this.st.instruction = 'Enter the 5-digit PIN printed on the lock (the first five digits of its DSK).';
    this.log(`Lock offers DSK ${dsk}; waiting for its PIN`);
    return new Promise<string | false>(resolve => { this.pinResolver = resolve; });
  }

  enterPin(pin: string | null): void {
    if (!this.pinResolver) throw new Error('The lock is not asking for a PIN right now');
    const resolve = this.pinResolver;
    const prompt = this.st.dskPrompt;
    this.pinResolver = null;
    this.st.dskPrompt = null;
    if (pin === null) {
      this.log('PIN entry cancelled');
      this.st.instruction = 'Secure pairing cancelled. Stop and exclude the lock, then start again.';
      resolve(false);
      return;
    }
    const trimmed = pin.trim();
    if (!/^\d{5}$/.test(trimmed)) {
      // Keep waiting for a usable answer.
      this.pinResolver = resolve;
      this.st.dskPrompt = prompt;
      throw new Error('The PIN is the five digits printed on the lock');
    }
    this.log('PIN entered; finishing secure pairing');
    this.st.instruction = 'PIN accepted. Waiting for the lock to finish joining.';
    resolve(trimmed);
  }

  private onNodeAdded(node: ZWaveNode, result: InclusionResult): void {
    const security = describeInclusionSecurity(node, result);
    this.st.addedNode = {
      nodeId: node.id,
      label: labelOf(node),
      security,
      ready: false,
      adopted: false,
    };
    this.clearTimer();
    this.log(`Node ${node.id} joined (${security}); waiting for its interview`);
    // Whether zwave-js flags it or not, a lock without a security class has
    // no usable User Code command class.
    if (result.lowSecurity || !hasSecurity(node)) {
      this.finish(`The lock joined WITHOUT security (${security}), so its codes cannot be managed. Exclude it and pair it again.`);
      return;
    }
    this.st.instruction = `Node ${node.id} joined. Its interview takes a minute or two; leave the lock alone.`;
    const onReady = () => {
      if (!this.st.addedNode || this.st.addedNode.nodeId !== node.id) return;
      this.st.addedNode.ready = true;
      this.st.addedNode.label = labelOf(node);
      const serverUrl = this.st.serverUrl;
      if (serverUrl === null) {
        this.finish(`Node ${node.id} is ready but no lock server was chosen; it was not adopted.`);
        return;
      }
      try {
        this.hooks.adopt(serverUrl, node, this.st.replacesNodeId);
        this.st.addedNode.adopted = true;
        this.log(`Node ${node.id} adopted for ${serverUrl}; its access codes are being reloaded`);
        this.finish(`Done. Node ${node.id} is now a lock for ${serverUrl}. Member codes are being written to it; check the Lock Codes page in a minute.`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`Could not adopt node ${node.id}: ${msg}`);
        this.finish(`Node ${node.id} joined but could not be adopted: ${msg}`);
      }
    };
    if (node.ready) onReady();
    else node.once('ready', onReady);
  }

  async stop(): Promise<void> {
    const mode = this.st.mode;
    if (mode === 'excluding') await this.controller.stopExclusion();
    if (mode === 'including') await this.controller.stopInclusion();
    if (mode !== 'idle') {
      this.log(`${mode === 'excluding' ? 'Exclusion' : 'Inclusion'} stopped by request`);
      this.finish('Stopped.');
    }
  }
}

function hasSecurity(node: ZWaveNode): boolean {
  const highest = node.getHighestSecurityClass();
  return highest !== undefined && highest !== SECURITY_NONE;
}

function labelOf(node: ZWaveNode): string | null {
  const label = (node as unknown as { label?: unknown }).label;
  return typeof label === 'string' && label !== '' ? label : null;
}

export function describeSecurityClass(c: number): string {
  return SECURITY_NAMES[c] ?? `security class ${c}`;
}

export function describeInclusionSecurity(node: ZWaveNode, result: InclusionResult): string {
  if (result.lowSecurity) {
    return `none — secure bootstrap failed: ${describeBootstrapFailure(result.lowSecurityReason)}`;
  }
  const highest = node.getHighestSecurityClass();
  if (highest === undefined || highest === SECURITY_NONE) return 'none';
  return describeSecurityClass(highest);
}

// zwave-js's SecurityBootstrapFailure enum, spelled out for the person at the lock.
function describeBootstrapFailure(reason: number): string {
  const names: Record<number, string> = {
    0: 'user cancelled',
    1: 'no keys configured',
    2: 'S2 not supported',
    3: 'no S2 keys granted',
    4: 'security class mismatch',
    5: 'PIN did not match the DSK',
    6: 'timed out',
    7: 'the lock rejected the key',
    8: 'the lock refused',
    9: 'unknown error',
  };
  return names[reason] ?? `reason ${reason}`;
}

function describeRemoval(reason: RemoveNodeReason): string {
  const names: Record<number, string> = {
    0: 'excluded',
    1: 'excluded by another controller',
    2: 'removed as failed',
    3: 'replaced',
    4: 'replaced by another controller',
    5: 'reset',
    6: 'SmartStart',
  };
  return names[reason as number] ?? `reason ${reason}`;
}
