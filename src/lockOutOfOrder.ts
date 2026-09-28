import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Locks marked out of order.
//
// A lock that is known to be broken keeps failing its probes and its writes,
// and paging about it tells nobody anything new. An admin marks it out of
// order from the site; until it is put back in service the daemon does not
// probe it and raises no incidents about it. Codes are still written to it.
//
// The mark lives here rather than on the site because the daemon is what
// pages, and it has to honour the mark across its own restarts and while the
// site is unreachable. It is kept in the one writable directory the daemon
// has (the Z-Wave cache), next to the lock node mapping.
// ---------------------------------------------------------------------------

export const LOCK_OUT_OF_ORDER_FILE = './zwave-cache/lock-out-of-order.json';

interface SavedMarks {
  /** Node ids of the locks that are out of order. */
  outOfOrder: number[];
  updatedAt: string;
}

let file = LOCK_OUT_OF_ORDER_FILE;
let marks: Set<number> | null = null;

/** Tests point this at a scratch file. Forgets what was loaded. */
export function setOutOfOrderFile(path: string): void {
  file = path;
  marks = null;
}

// A file that cannot be read marks nothing: alerts stay on, which is the side
// to err on.
function load(): Set<number> {
  if (marks) return marks;
  marks = new Set();
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as SavedMarks;
      if (!Array.isArray(saved.outOfOrder) || !saved.outOfOrder.every(id => Number.isInteger(id))) {
        throw new Error('outOfOrder is not a list of node ids');
      }
      marks = new Set(saved.outOfOrder);
      if (marks.size > 0) {
        console.log(`Locks out of order: ${[...marks].join(', ')} (from ${file}, saved ${saved.updatedAt})`);
      }
    }
  } catch (e) {
    console.error(`Could not read out-of-order locks from ${file}; treating every lock as in service:`, e);
  }
  return marks;
}

export function isLockOutOfOrder(nodeId: number): boolean {
  return load().has(nodeId);
}

/**
 * Set or clear a lock's mark and save it. Throws, leaving the mark as it was,
 * when it cannot be saved: a mark that would be gone after a restart is not
 * one to report as made.
 */
export function markLockOutOfOrder(nodeId: number, outOfOrder: boolean): void {
  const current = load();
  if (current.has(nodeId) === outOfOrder) return;
  const next = new Set(current);
  if (outOfOrder) next.add(nodeId); else next.delete(nodeId);
  const data: SavedMarks = { outOfOrder: [...next].sort((a, b) => a - b), updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  marks = next;
  console.log(`Lock ${nodeId} marked ${outOfOrder ? 'out of order' : 'back in service'}`);
}
