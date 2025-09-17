import { IntervalTree, Interval } from 'node-interval-tree';
import { TranslatedValueID, Driver, isTransportServiceEncapsulation, ZWaveNode } from 'zwave-js';
import { ScheduledTask } from './scheduledTask';
import { countUnique, Result, Err, Ok, unwrap } from './lib/util';
import { BookingWebSocketClient } from './bookingWebSocketClient';

interface CodeInterval {
  low: number,
  high: number,
  code: string,
  startEvent: ScheduledTask, // | { overlapsEarlier: CodeInterval },
  stopEvent: ScheduledTask, //| { overlapsLater: CodeInterval },
};
type CodeSlot = { value: TranslatedValueID, status: TranslatedValueID };
type AllocatedSlot = { slot: CodeSlot, slotIndex: number, count: number };

const CAPACITY = 20;
const CODE_LENGTH = 6;
const CODE_ENABLED = 1;
const CODE_AVAILABLE = 0;

type BookingMessage =
  | { kind: 'addAccess', code: string, start: number, stop: number }
  | { kind: 'removeAccess', code: string, start: number, stop: number };

export function runLockManager(lock: ZWaveNode, serverUrl: string) {
  const manager = new LockManager(lock);
  const wsClient = new BookingWebSocketClient({ serverUrl });

  wsClient.onMessage((message: BookingMessage) => {
    console.log('Processing booking message:', message);

    switch (message.kind) {
      case 'addAccess':
        const addResult = manager.addAccessInterval(message.code, [new Date(message.start), new Date(message.stop)]);
        if (addResult.ok === false) {
          console.error(`Failed to add access for code ${message.code}:`, addResult.error);
        } else {
          console.log(`Successfully added access for code ${message.code}`);
        }
        break;

      case 'removeAccess':
        manager.removeAccessInterval(message.code, [new Date(message.start), new Date(message.stop)]);
        console.log(`Removed access for code ${message.code}`);
        break;

      default:
        console.warn('Unknown message kind:', (message as any).kind);
    }
  });

  // Connect to WebSocket server
  wsClient.connect().then(() => {
    console.log('Lock manager WebSocket client connected successfully');
  }).catch((error) => {
    console.error('Failed to connect lock manager WebSocket client:', error);
  });

  return { manager, wsClient };
}


export class LockManager {
  lock: ZWaveNode;
  tree: IntervalTree<CodeInterval>;
  userCodeSlots: Array<CodeSlot>;
  // These are indices into the userCodeIds array. The 
  availableSlots: Set<number>;
  // ref-counting to handle overlapping intervals with the same code
  codeToSlot: Map<string, AllocatedSlot>;

  constructor(lock: ZWaveNode) {
    this.lock = lock;
    this.tree = new IntervalTree();
    this.codeToSlot = new Map();
    // Code 1 (propertyKey == 1) is reserved and propertyKey 0 is special and used for modifying all the codes at once.
    const codeOrStatus = lock.getDefinedValueIDs().filter(v => v.commandClass === 99 && v.propertyKey != 0 && v.propertyKey != 1);
    // propertyKey 0 is special and used for modifying all the codes.
    const codeValues = codeOrStatus.filter(v => v.property == 'userCode');
    const statusesByIndex = new Map<any, TranslatedValueID>();
    codeOrStatus.forEach(v => {
      if (v.property == 'userIdStatus') {
        statusesByIndex.set(v.propertyKey, v);
      }
    });

    this.userCodeSlots = codeValues.map((code) => {
      const status = statusesByIndex.get(code.propertyKey);
      if (status == undefined) {
        throw 'Status for code not found';
      }
      return { value: code, status };
    });

    this.availableSlots = new Set();
    for (let i = 0; i < this.userCodeSlots.length; ++i) {
      this.availableSlots.add(i);
    }
  }

  startAccess(t: Date, code: string): ScheduledTask {
    return new ScheduledTask(t, () => {
      unwrap(this.allocateCodeSlot(code));
    });
  }

  stopAccess(t: Date, code: string): ScheduledTask {
    return new ScheduledTask(t, () => {
      this.freeCodeSlot(code);
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

  freeCodeSlot(code: string) {
    const r = this.codeToSlot.get(code);
    if (r != undefined) {
      r.count -= 1;
      if (r.count <= 0) {
        this.codeToSlot.delete(code)
        this.availableSlots.add(r.slotIndex);
        this.lock.setValue(r.slot.status, CODE_AVAILABLE);
      }
    }
  }

  allocateCodeSlot(code: string): Result<AllocatedSlot, string> {
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

    // Do it unconditionally for good measure
    this.lock.setValue(r.slot.status, CODE_ENABLED);
    this.lock.setValue(r.slot.value, code);

    return Ok(r);
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

function popSet<A>(set: Set<A>): A | undefined {
  for (const value of set) {
    set.delete(value);
    return value;
  }
  return undefined;
}

