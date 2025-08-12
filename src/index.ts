/* TODO:
  * Consider just doing a polling version of this where the server holds onto the state of who should have
* access at any time, and we just grab that from the server, query the lock and make sure they are in sync.
  *
  * Or better, the server sends a diff (or we compute it) 
*/
import { exit } from 'process';
import { TranslatedValueID, Driver, isTransportServiceEncapsulation, ZWaveNode } from 'zwave-js';
import { IntervalTree, Interval } from 'node-interval-tree';

interface CodeInterval {
  low: number,
  high: number,
  code: string,
  startEvent: ScheduledTask, // | { overlapsEarlier: CodeInterval },
  stopEvent: ScheduledTask, //| { overlapsLater: CodeInterval },
};

function countUnique(xs: string[]): number {
  const m = new Set<string>();
  xs.forEach((x) => m.add(x));
  return m.size;
}

class ScheduledTask {
  id: NodeJS.Timeout;
  finalState: 'finishedEarly' | 'cancelled' | 'occurred' | undefined;
  f: () => void;

  cancel() {
    if (this.finalState == undefined) {
      this.finalState = 'cancelled';
      clearTimeout(this.id);
    }
  }

  finishEarly() {
    if (this.finalState == undefined) {
      this.finalState = 'finishedEarly';
      clearTimeout(this.id);
      this.f();
    }
  }

  constructor(t: Date, f: () => void) {
    this.finalState = undefined;
    const now = Date.now();
    this.f = f;

    this.id = global.setTimeout(() => {
      if (this.finalState == undefined) {
        this.finalState = 'occurred';
        f();
      }
    }, t.getTime() - now);
  }
}

type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };
function Err<T, E>(e: E): Result<T, E> {
  return { ok: false, error: e };
}
function Ok<T, E>(x: T): Result<T, E> {
  return { ok: true, value: x };
}

function unwrap<A, E>(x: Result<A, E>): A {
  if (x.ok == true) {
    return x.value;
  } else {
    throw x.error;
  }
}

const CAPACITY = 20;
const CODE_LENGTH = 4;
const CODE_ENABLED = 1;
const CODE_AVAILABLE = 0;


class SaunaManager {
  static TARGET_TEMP = 180;
}

function randomCode(): string {
  const res = [];
  for (let i = 0; i < CODE_LENGTH; ++i) {
    const x = Math.floor(Math.random() * 10);
    res.push(x.toString());
  }
  return res.join('');
}

function popSet<A>(set: Set<A>): A | undefined {
  for (const value of set) {
    set.delete(value);
    return value;
  }
  return undefined;
}

type CodeSlot = { value: TranslatedValueID, status: TranslatedValueID };
type AllocatedSlot = { slot: CodeSlot, slotIndex: number, count: number };

function runLockManager(lock: ZWaveNode) {
  const BOOKING_WEBSOCKET = '';
  const manager = new LockManager(lock);
  const ws = new WebSocket(BOOKING_WEBSOCKET);

  type BookingMessage =
    | { kind: 'addAccess', code: string, start: number, stop: number }
    | { kind: 'removeAccess', code: string, start: number, stop: number };
  ws.onmessage = (ev) => {
    const msg: BookingMessage = JSON.parse(ev.data)
    switch (msg.kind) {
      case 'addAccess':
        manager.addAccessInterval(msg.code, [new Date(msg.start), new Date(msg.stop)]);
        break;
      case 'removeAccess':
        manager.removeAccessInterval(msg.code, [new Date(msg.start), new Date(msg.stop)]);
        break;
    }
  }
}

// On start up, request the schedule from the server.
//
// Should maintain a websocket. On opening, the server sends all the scheduled acceses,
// and as new bookings or cancellations occur, the server should send them.
//
class LockManager {
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
    // TODO: filter out the reserved codes
    const codeOrStatus = lock.getDefinedValueIDs().filter(v => v.commandClass === 99 && v.propertyKey != 0);
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

      this.tree.insert({
        low, high, code,
        startEvent: this.startAccess(start, code),
        stopEvent: this.stopAccess(stop, code),
      });

      return Ok(undefined);
    }
  }
}

const driver = new Driver('/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick_533D004242-if00', {
  storage: {
    cacheDir: './zwave-cache'
  }
});

driver.disableStatistics();

driver.start().then(async () => {
  return driver.on('all nodes ready', () => {
    for (let i = 0; i < 10; ++i) {console.log('arstieaonrstei');}
    const lockNode = driver.controller.nodes.get(2);
    if (lockNode == undefined) { exit(1); }

      // Get ALL values for the node
      const allValues = lockNode.getDefinedValueIDs();
      console.log('All available values:');
      allValues.forEach(valueId => {
        const value = lockNode.getValue(valueId);
        const metadata = lockNode.getValueMetadata(valueId);
        console.log(`CC ${valueId.commandClass}, property: ${valueId.property}, key: ${valueId.propertyKey}, value:
  ${value}, label: ${metadata?.label}`);
      });

      // Get specific User Code values
      console.log('\nUser Codes:');
      const userCodeValues = allValues.filter(v => v.commandClass === 99); // User Code CC
      userCodeValues.forEach(valueId => {
        const value = lockNode.getValue(valueId);
        if (valueId.property === 'userCode' && value) {
          console.log(`User slot ${valueId.propertyKey}: ${value}`);
        }
        if (valueId.property === 'userIdStatus') {
          console.log(`User slot ${valueId.propertyKey} status: ${value}`);
        }
      });

    console.log('eyo', driver.controller.nodes);
  })
});
