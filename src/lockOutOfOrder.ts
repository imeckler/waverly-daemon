import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Per-lock marks an admin sets from the site: out of order, and clear alerts
// muted.
//
// A lock that is known to be broken keeps failing its probes and its writes,
// and paging about it tells nobody anything new. An admin marks it out of
// order from the site; until it is put back in service the daemon does not
// probe it and raises no incidents about it. Codes are still written to it.
//
// A lock whose clears are muted still has everything else alerted. Some locks
// answer a clear with the code still showing while in fact dropping it, so
// the low-urgency incident about an unconfirmed clear says nothing for them;
// muted, the miss is only logged. An unconfirmed write still pages, since
// that may be a lockout.
//
// The marks live here rather than on the site because the daemon is what
// pages, and it has to honour them across its own restarts and while the
// site is unreachable. They are kept in the one writable directory the daemon
// has (the Z-Wave cache), next to the lock node mapping.
// ---------------------------------------------------------------------------

export const LOCK_OUT_OF_ORDER_FILE = './zwave-cache/lock-out-of-order.json';

interface SavedMarks {
  /** Node ids of the locks that are out of order. */
  outOfOrder: number[];
  /** Node ids of the locks whose unconfirmed-clear alerts are muted. Absent in files from before the mark. */
  clearAlertsMuted?: number[];
  updatedAt: string;
}

interface Marks {
  outOfOrder: Set<number>;
  clearAlertsMuted: Set<number>;
}

type MarkKind = keyof Marks;

let file = LOCK_OUT_OF_ORDER_FILE;
let marks: Marks | null = null;

/** Tests point this at a scratch file. Forgets what was loaded. */
export function setOutOfOrderFile(path: string): void {
  file = path;
  marks = null;
}

function nodeIdList(value: unknown, name: string): Set<number> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || !value.every(id => Number.isInteger(id))) {
    throw new Error(`${name} is not a list of node ids`);
  }
  return new Set(value as number[]);
}

// A file that cannot be read marks nothing: alerts stay on, which is the side
// to err on.
function load(): Marks {
  if (marks) return marks;
  marks = { outOfOrder: new Set(), clearAlertsMuted: new Set() };
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as SavedMarks;
      const outOfOrder = nodeIdList(saved.outOfOrder ?? null, 'outOfOrder');
      const clearAlertsMuted = nodeIdList(saved.clearAlertsMuted, 'clearAlertsMuted');
      marks = { outOfOrder, clearAlertsMuted };
      if (outOfOrder.size > 0) {
        console.log(`Locks out of order: ${[...outOfOrder].join(', ')} (from ${file}, saved ${saved.updatedAt})`);
      }
      if (clearAlertsMuted.size > 0) {
        console.log(`Locks with clear alerts muted: ${[...clearAlertsMuted].join(', ')} (from ${file}, saved ${saved.updatedAt})`);
      }
    }
  } catch (e) {
    console.error(`Could not read lock marks from ${file}; treating every lock as in service with alerts on:`, e);
  }
  return marks;
}

export function isLockOutOfOrder(nodeId: number): boolean {
  return load().outOfOrder.has(nodeId);
}

export function isLockClearAlertsMuted(nodeId: number): boolean {
  return load().clearAlertsMuted.has(nodeId);
}

/**
 * Set or clear one of a lock's marks and save them all. Throws, leaving the
 * mark as it was, when it cannot be saved: a mark that would be gone after a
 * restart is not one to report as made.
 */
function mark(kind: MarkKind, nodeId: number, on: boolean, described: string): void {
  const current = load();
  if (current[kind].has(nodeId) === on) return;
  const next = { ...current, [kind]: new Set(current[kind]) };
  if (on) next[kind].add(nodeId); else next[kind].delete(nodeId);
  save(next);
  console.log(`Lock ${nodeId} ${described}`);
}

function save(next: Marks): void {
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  const data: SavedMarks = {
    outOfOrder: sorted(next.outOfOrder),
    clearAlertsMuted: sorted(next.clearAlertsMuted),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  marks = next;
}

export function markLockOutOfOrder(nodeId: number, outOfOrder: boolean): void {
  mark('outOfOrder', nodeId, outOfOrder, outOfOrder ? 'marked out of order' : 'marked back in service');
}

export function markLockClearAlertsMuted(nodeId: number, muted: boolean): void {
  mark('clearAlertsMuted', nodeId, muted, muted ? 'clear alerts muted' : 'clear alerts unmuted');
}

/** Drop every mark a lock has: for a node id that is gone for good. */
export function forgetLockMarks(nodeId: number): void {
  const current = load();
  if (!current.outOfOrder.has(nodeId) && !current.clearAlertsMuted.has(nodeId)) return;
  const next = { outOfOrder: new Set(current.outOfOrder), clearAlertsMuted: new Set(current.clearAlertsMuted) };
  next.outOfOrder.delete(nodeId);
  next.clearAlertsMuted.delete(nodeId);
  save(next);
  console.log(`Lock ${nodeId}: marks dropped`);
}
