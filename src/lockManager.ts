import { IntervalTree } from 'node-interval-tree';
import { TranslatedValueID, ZWaveNode, SetValueStatus } from 'zwave-js';
import { ScheduledTask } from './scheduledTask';
import { Result, Err, Ok } from './lib/util';
import { BookingWebSocketClient } from './bookingWebSocketClient';
import { LockHealth, maskCode, Probeable, checkLiveness } from './lockHealth';
import { registerLockGroup } from './lockGroups';

interface CodeInterval {
  low: number,
  high: number,
  code: string,
  startEvent: ScheduledTask,
  stopEvent: ScheduledTask,
};
type CodeSlot = { value: TranslatedValueID, status: TranslatedValueID };
type AllocatedSlot = { slot: CodeSlot, slotIndex: number, count: number };

/** What the lock says a slot holds, in answer to a User Code Get. */
export type SlotReading = { status: number | undefined, code: string | undefined };

const CAPACITY = 20;
const CODE_ENABLED = 1;
const CODE_AVAILABLE = 0;

/** How long to give a re-interview before treating it as failed. */
export const REINTERVIEW_TIMEOUT_MS = 10 * 60 * 1000;
/** A write that got no answer triggers a liveness check after this long. */
export const HEAL_CHECK_DELAY_MS = 60 * 1000;

export type InterviewOutcome = 'ready' | 'interview failed' | 'timeout';

type BookingMessage =
  | { kind: 'addAccess', code: string, start: number, stop: number }
  | { kind: 'removeAccess', code: string, start: number, stop: number };

export function runLockManager(locks: ZWaveNode[], serverUrl: string, description: string | null = null) {
  // Create a manager for each lock. The array is shared with the lock group
  // registry, which adds and removes managers as locks are re-paired.
  const managers = locks.map(lock => new LockManager(lock));
  const wsClient = new BookingWebSocketClient({ serverUrl });
  registerLockGroup({ serverUrl, description, managers, wsClient });

  wsClient.onMessage((message: BookingMessage) => {
    console.log('Processing booking message:', message);

    switch (message.kind) {
      case 'addAccess':
        // Add access to all locks managed by this server
        for (const manager of managers) {
          const addResult = manager.addAccessInterval(message.code, [new Date(message.start), new Date(message.stop)]);
          if (addResult.ok === false) {
            console.error(`Failed to add access for code ${message.code} on lock:`, addResult.error);
          } else {
            console.log(`Successfully added access for code ${message.code} on lock`);
          }
        }
        break;

      case 'removeAccess':
        // Remove access from all locks managed by this server
        for (const manager of managers) {
          manager.removeAccessInterval(message.code, [new Date(message.start), new Date(message.stop)]);
        }
        console.log(`Removed access for code ${message.code} from all locks`);
        break;

      default:
        console.warn('Unknown message kind:', (message as any).kind);
    }
  });

  // Connect to WebSocket server
  wsClient.connect().then(() => {
    console.log(`Lock manager WebSocket client connected successfully to ${serverUrl}`);
  }).catch((error) => {
    console.error(`Failed to connect lock manager WebSocket client to ${serverUrl}:`, error);
  });

  return { managers, wsClient };
}

export interface LockManagerOptions {
  health?: LockHealth;
  /** Query one slot on the lock. Defaults to a User Code Get over the radio. */
  readSlot?: (slotNo: number) => Promise<SlotReading | undefined>;
  /** Re-interview the lock. Defaults to zwave-js's refreshInfo. */
  reinterview?: () => Promise<InterviewOutcome>;
  healCheckDelayMs?: number;
}

export class LockManager implements Probeable {
  lock: ZWaveNode;
  health: LockHealth;
  tree: IntervalTree<CodeInterval>;
  userCodeSlots: Array<CodeSlot>;
  // These are indices into the userCodeIds array. The 
  availableSlots: Set<number>;
  // ref-counting to handle overlapping intervals with the same code
  codeToSlot: Map<string, AllocatedSlot>;
  private readonly readSlot: (slotNo: number) => Promise<SlotReading | undefined>;
  private readonly reinterview: () => Promise<InterviewOutcome>;
  private readonly healCheckDelayMs: number;
  private healCheckTimer: NodeJS.Timeout | null = null;
  /** Set once the lock has left the network; nothing is written to it after that. */
  retired = false;

  constructor(lock: ZWaveNode, options: LockManagerOptions = {}) {
    this.lock = lock;
    this.health = options.health ?? new LockHealth(lock);
    this.readSlot = options.readSlot ?? ((slotNo) => readSlotFromLock(lock, slotNo));
    this.reinterview = options.reinterview ?? (() => reinterviewLock(lock));
    this.healCheckDelayMs = options.healCheckDelayMs ?? HEAL_CHECK_DELAY_MS;
    this.tree = new IntervalTree();
    this.codeToSlot = new Map();
    // Code 1 (propertyKey == 1) is reserved and propertyKey 0 is special and used for modifying all the codes at once.
    // propertyKey 0 is special and used for modifying all the codes.
    const codeValues = lock.getDefinedValueIDs().filter(v =>
      v.commandClass === 99 && v.property == 'userCode' && v.propertyKey != 0 && v.propertyKey != 1);

    this.userCodeSlots = codeValues.map((code) => ({ value: code, status: statusValueIdFor(code) }));

    this.availableSlots = new Set();
    for (let i = 0; i < this.userCodeSlots.length; ++i) {
      this.availableSlots.add(i);
    }
  }

  /**
   * The lock is gone (excluded, or replaced): cancel every pending start and
   * stop, drop the liveness check, and refuse further writes. Access intervals
   * stay in the tree only as history; nothing acts on them.
   */
  retire(): void {
    this.retired = true;
    if (this.healCheckTimer) { clearTimeout(this.healCheckTimer); this.healCheckTimer = null; }
    for (const interval of this.tree.inOrder()) {
      interval.startEvent.cancel();
      interval.stopEvent.cancel();
    }
  }

  startAccess(t: Date, code: string): ScheduledTask {
    return new ScheduledTask(t, () => {
      if (this.retired) return;
      this.allocateCodeSlot(code)
        .then(r => {
          if (r.ok === false) {
            console.error(`Failed to write code ${code} to lock ${this.lock.id}: ${r.error}`);
          }
        })
        .catch(e => console.error(`Error writing code ${code} to lock ${this.lock.id}:`, e));
    });
  }

  stopAccess(t: Date, code: string): ScheduledTask {
    return new ScheduledTask(t, () => {
      if (this.retired) return;
      this.freeCodeSlot(code)
        .catch(e => console.error(`Error clearing code ${code} from lock ${this.lock.id}:`, e));
    });
  }

  removeAccessInterval(code: string, [start, stop]: [Date, Date]) {
    const low = start.getTime();
    const high = stop.getTime();
    const overlapping = this.tree.search(low, high);
    const relevantSegment = overlapping.find(
      (x) => x.code == code && x.low == low && x.high == high);

    if (relevantSegment == undefined) {
      // Nothing to do.
      return;
    }

    // Need to decrement ref-count and free up the slot if the stopEvent has not been called.
    if (relevantSegment.startEvent.finalState == 'occurred') {
      if (relevantSegment.stopEvent.finalState == undefined) {
        relevantSegment.stopEvent.finishEarly();
      }
    } else {
      relevantSegment.startEvent.cancel();
      relevantSegment.stopEvent.cancel();
    }

    this.tree.remove(relevantSegment);
  }

  /**
   * Ask the lock what a slot holds. Returns undefined when the lock does not
   * answer. Any answer at all — even one that shows a rejected write — counts
   * as proof that the lock is alive.
   */
  private async querySlot(slotNo: number): Promise<SlotReading | undefined> {
    let reading: SlotReading | undefined;
    try {
      reading = await this.readSlot(slotNo);
    } catch (e) {
      console.error(`Lock ${this.lock.id} slot ${slotNo}: read-back failed:`, e);
      reading = undefined;
    }
    if (reading !== undefined) {
      this.health.recordHeard();
    } else {
      this.requestHealCheck();
    }
    return reading;
  }

  /** Watchdog probe: read the first managed slot and report whether the lock answered. */
  async probe(): Promise<boolean> {
    const slot = this.userCodeSlots[0];
    if (!slot) return false;
    let reading: SlotReading | undefined;
    try {
      reading = await this.readSlot(slot.value.propertyKey as number);
    } catch (e) {
      console.error(`Lock ${this.lock.id}: probe failed:`, e);
      reading = undefined;
    }
    return reading !== undefined;
  }

  /**
   * A lock whose radio still acknowledges frames can stop acting on them (the
   * Kwikset, after an interrupted transaction). A fresh interview re-queries
   * every command class, which has brought such a lock back without anyone
   * touching it. Reports whether the lock answers a probe afterwards.
   */
  async heal(): Promise<boolean> {
    this.health.lastHealAt = this.health.now();
    console.log(`${this.health.describe()}: not answering; re-interviewing`);
    let outcome: InterviewOutcome;
    try {
      outcome = await this.reinterview();
    } catch (e) {
      console.error(`${this.health.describe()}: re-interview threw:`, e);
      return false;
    }
    console.log(`${this.health.describe()}: re-interview ${outcome}`);
    if (outcome !== 'ready') return false;
    return this.probe();
  }

  /**
   * A write or read got no answer: look at the lock's liveness soon, once the
   * current burst of commands is over, so a deaf lock is re-interviewed within
   * minutes rather than at the next watchdog tick.
   */
  private requestHealCheck(): void {
    if (this.healCheckTimer || this.retired) return;
    this.healCheckTimer = setTimeout(() => {
      this.healCheckTimer = null;
      checkLiveness(this, true)
        .catch(e => console.error(`${this.health.describe()}: liveness check failed:`, e));
    }, this.healCheckDelayMs);
    this.healCheckTimer.unref();
  }

  async freeCodeSlot(code: string) {
    const r = this.codeToSlot.get(code);
    if (r != undefined) {
      r.count -= 1;
      if (r.count <= 0) {
        this.codeToSlot.delete(code)
        this.availableSlots.add(r.slotIndex);
        const slotNo = r.slot.status.propertyKey as number;
        this.health.recordCommand();
        const result = await this.lock.setValue(r.slot.status, CODE_AVAILABLE);
        if (!setValueOk(result)) {
          console.error(`Lock ${this.lock.id} slot ${slotNo}: failed to CLEAR code ${code} — ${describeSetValue(result)}`);
          return;
        }
        console.log(`Lock ${this.lock.id} slot ${slotNo}: cleared code ${code} — ${describeSetValue(result)}`);

        // The radio's acknowledgement says nothing about the slot; ask. A
        // Kwikset reports a cleared slot as Available while still echoing the
        // old digits, so only the status is checked.
        const reading = await this.querySlot(slotNo);
        if (reading !== undefined && reading.status === CODE_AVAILABLE) {
          console.log(`Lock ${this.lock.id} slot ${slotNo}: clear verified`);
          this.health.recordConfirmed();
        } else {
          this.health.recordUnconfirmed(`clearing slot ${slotNo}`, {
            slot: slotNo,
            code: maskCode(code),
            lockReports: describeReading(reading),
          });
        }
      }
    }
  }

  async allocateCodeSlot(code: string): Promise<Result<AllocatedSlot, string>> {
    let r = this.codeToSlot.get(code);

    if (r == undefined) {
      const i = popSet(this.availableSlots);
      if (i == undefined) {
        return Err('No available slot');
      } else {
        r = { slotIndex: i, count: 1, slot: this.userCodeSlots[i] };
        this.codeToSlot.set(code, r);
      }
    } else {
      r.count += 1;
    }

    const slotNo = r.slot.value.propertyKey as number;

    // Writing the userCode value sends a complete UserCodeCC.Set (status=Enabled
    // + the code) in a single command. Do NOT separately enable the slot first:
    // that sends a Set enabling the slot with no code — an invalid state that can
    // wedge the lock (observed on the Kwikset SmartCode). Await the write so a
    // rejection or timeout surfaces as a real error instead of the previous
    // fire-and-forget "success".
    //
    // Even an accepted write proves only that the radio took the frame. Over S0
    // there is no supervision and zwave-js then writes the sent value into its
    // own cache, so the slot is read back from the lock itself. One retry
    // covers a dropped frame; anything worse is paged.
    let reading: SlotReading | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.health.recordCommand();
      const codeResult = await this.lock.setValue(r.slot.value, code);
      if (!setValueOk(codeResult)) {
        return Err(`Lock ${this.lock.id} slot ${slotNo}: setValue rejected — code=${describeSetValue(codeResult)}`);
      }
      console.log(`Lock ${this.lock.id} slot ${slotNo}: wrote code ${code} — ${describeSetValue(codeResult)}`);

      reading = await this.querySlot(slotNo);
      if (confirmsCode(reading, code)) {
        console.log(`Lock ${this.lock.id} slot ${slotNo}: code ${code} verified`);
        this.health.recordConfirmed();
        return Ok(r);
      }
      if (attempt === 1) {
        console.warn(`Lock ${this.lock.id} slot ${slotNo}: code ${code} not confirmed (${describeReading(reading)}); retrying once`);
      }
    }

    this.health.recordUnconfirmed(`writing code ${maskCode(code)} to slot ${slotNo}`, {
      slot: slotNo,
      code: maskCode(code),
      lockReports: describeReading(reading),
    });
    return Err(`Lock ${this.lock.id} slot ${slotNo}: code not confirmed by the lock (${describeReading(reading)})`);
  }

  addAccessInterval(code: string, [start, stop]: [Date, Date]): Result<void, string> {
    const low = start.getTime();
    const high = stop.getTime();
    const overlapping = this.tree.search(low, high);
    const alreadyPresent = overlapping.find(
      (x) => x.code == code && x.low == low && x.high == high) != undefined;

    if (alreadyPresent) {
      return Ok(undefined);
    } else {
      const EPSILON = 1;
      // Make sure at every point in this interval there's less than CAPACITY other people.
      // The number of intervals overlapping only changes at endpoints.
      const testPoints = overlapping.flatMap(
        (r) => [r.low + EPSILON, r.high - EPSILON].filter((t) => low < t && t < high));

      const spaceAvailable = testPoints.every((t) => {
        // See how many overlapping intervals overlap with time t
        const codesAtTime = new Set<string>();
        overlapping.forEach((r) => {
          if (r.low < t && t < r.high) { codesAtTime.add(r.code); }
        });
        codesAtTime.delete(code);
        return codesAtTime.size < CAPACITY
      });

      if (!spaceAvailable) {
        return Err('At capacity');
      }

      // Important that these are called sequentially here
      // in case both are in the past, we need the start code
      // to run before the stop code.
      const startEvent = this.startAccess(start, code);
      const stopEvent = this.stopAccess(stop, code);
      this.tree.insert({
        low, high, code,
        startEvent,
        stopEvent,
      });

      return Ok(undefined);
    }
  }
}

/** Does the lock's answer show `code` enabled in the slot? A lock that masks codes is trusted on status alone. */
export function confirmsCode(reading: SlotReading | undefined, code: string): boolean {
  if (reading === undefined || reading.status !== CODE_ENABLED) return false;
  if (reading.code === undefined || !/^\d+$/.test(reading.code)) return true;
  return reading.code === code;
}

export function describeReading(reading: SlotReading | undefined): string {
  if (reading === undefined) return 'no answer';
  const status = reading.status === CODE_AVAILABLE ? 'available'
    : reading.status === CODE_ENABLED ? 'enabled'
    : reading.status === undefined ? 'status unknown' : `status ${reading.status}`;
  return reading.code === undefined || reading.code === '' ? status : `${status}, code ${maskCode(reading.code)}`;
}

/**
 * Re-interview the lock and wait for it to come back (ready), give up
 * (interview failed), or run out of time.
 */
export function reinterviewLock(lock: ZWaveNode): Promise<InterviewOutcome> {
  const outcome = new Promise<InterviewOutcome>((resolve) => {
    const finish = (o: InterviewOutcome) => {
      clearTimeout(timer);
      lock.off('ready', onReady);
      lock.off('interview failed', onFailed);
      resolve(o);
    };
    const onReady = () => finish('ready');
    const onFailed = () => finish('interview failed');
    const timer = setTimeout(() => finish('timeout'), REINTERVIEW_TIMEOUT_MS);
    lock.on('ready', onReady);
    lock.on('interview failed', onFailed);
  });
  return lock.refreshInfo({ resetSecurityClasses: false, waitForWakeup: false })
    .then(() => outcome);
}

/** A User Code Get over the radio. Resolves undefined when the lock does not answer. */
export async function readSlotFromLock(lock: ZWaveNode, slotNo: number): Promise<SlotReading | undefined> {
  const answer = await lock.commandClasses['User Code'].get(slotNo);
  if (!answer) return undefined;
  const raw = answer.userCode;
  return {
    status: answer.userIdStatus,
    code: typeof raw === 'string' ? raw.trim() : undefined,
  };
}

// zwave-js keys a slot's userCode and userIdStatus value IDs by the same user ID
// (propertyKey); they differ only in `property`. Derive the status ID from the
// code's rather than looking it up among the node's defined value IDs, so a
// slot whose status the driver has not cached is still usable. setValue only
// dispatches on commandClass/endpoint/property/propertyKey, and writing
// Available (0) maps to UserCodeCC.clear, which never consults the cache.
export function statusValueIdFor(code: TranslatedValueID): TranslatedValueID {
  return { ...code, property: 'userIdStatus', propertyName: 'userIdStatus' };
}

// A lock write counts as "landed" if the device accepted it (Success), the
// controller sent it without a confirmation channel (SuccessUnsupervised — the
// normal case over S0, which has no Supervision), or it's still in progress
// (Working). Anything else (Fail / NoDeviceSupport / InvalidValue / timeout via
// a thrown error) is a genuine failure worth surfacing. A landed write is still
// only trusted once the lock's own answer shows it (see allocateCodeSlot).
export type SetValueResult = Awaited<ReturnType<ZWaveNode['setValue']>>;

export function setValueOk(result: SetValueResult): boolean {
  return result.status === SetValueStatus.Success
    || result.status === SetValueStatus.SuccessUnsupervised
    || result.status === SetValueStatus.Working;
}

export function describeSetValue(result: SetValueResult): string {
  const name = SetValueStatus[result.status] ?? `status ${result.status}`;
  return result.message ? `${name} (${result.message})` : name;
}

function popSet<A>(set: Set<A>): A | undefined {
  for (const value of set) {
    set.delete(value);
    return value;
  }
  return undefined;
}
