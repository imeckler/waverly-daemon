import { ZWaveNode } from 'zwave-js';
import { setValueOk, describeSetValue } from './lockManager';
import { LockCodes, LockSlot } from '@waverly/sauna-protocol';

// Shared registry of the lock nodes the daemon controls. index.ts populates it
// as lock nodes become ready; the sauna-schedule control channel reads it to
// answer admin queries and to apply manual code changes.
const lockNodes = new Map<number, ZWaveNode>();

export function registerLock(node: ZWaveNode): void {
  lockNodes.set(node.id, node);
}

// Kwikset SmartCode (and most Z-Wave locks) accept 4–8 digit codes.
const CODE_PATTERN = /^\d{4,8}$/;

function statusText(value: unknown): string {
  switch (value) {
    case 0: return 'available';
    case 1: return 'enabled';
    case 2: return 'disabled';
    default: return value === undefined ? 'unknown' : String(value);
  }
}

// Read the cached user-code state for every registered lock. Values come from
// the driver's cache (kept current by the lock's own reports), so this is fast
// and non-invasive — it does not wake the lock or hit the radio.
export function getLockCodes(): LockCodes[] {
  const result: LockCodes[] = [];
  for (const node of lockNodes.values()) {
    // Enumerate the real user slots. propertyKey 0 is the "set all codes"
    // pseudo-slot, not a real user — skip it.
    const codeVids = node
      .getDefinedValueIDs()
      .filter(v => v.commandClass === 99 && v.property === 'userCode'
        && typeof v.propertyKey === 'number' && v.propertyKey !== 0)
      .sort((a, b) => (a.propertyKey as number) - (b.propertyKey as number));

    const slots: LockSlot[] = codeVids.map(codeVid => {
      const slot = codeVid.propertyKey as number;
      const code = node.getValue<string>(codeVid);
      const status = node.getValue({ ...codeVid, property: 'userIdStatus' });
      return {
        slot,
        code: code && code.trim() !== '' ? code : null,
        status: statusText(status),
      };
    });

    result.push({
      nodeId: node.id,
      status: node.status === undefined ? 'unknown' : String(node.status),
      ready: node.ready,
      slots,
    });
  }
  return result;
}

export interface SetLockCodeResult {
  ok: boolean;
  status?: string;
  error?: string;
}

// Manually set (or, with an empty code, clear) a single user slot on a lock.
// Writing the userCode value sends a complete UserCodeCC.Set (status=Enabled +
// code) in one command; clearing sets the slot's status to Available.
export async function setLockCode(
  nodeId: number,
  slot: number,
  code: string,
): Promise<SetLockCodeResult> {
  const node = lockNodes.get(nodeId);
  if (!node) {
    return { ok: false, error: `Lock node ${nodeId} is not managed by this daemon` };
  }
  if (!Number.isInteger(slot) || slot < 1) {
    return { ok: false, error: `Invalid slot ${slot}` };
  }

  const vids = node.getDefinedValueIDs()
    .filter(v => v.commandClass === 99 && v.propertyKey === slot);
  const codeVid = vids.find(v => v.property === 'userCode');
  const statusVid = vids.find(v => v.property === 'userIdStatus');
  if (!codeVid || !statusVid) {
    return { ok: false, error: `Lock node ${nodeId} has no user slot ${slot}` };
  }

  const trimmed = (code ?? '').trim();
  try {
    let result;
    if (trimmed === '') {
      // Clear the slot.
      result = await node.setValue(statusVid, 0);
    } else {
      if (!CODE_PATTERN.test(trimmed)) {
        return { ok: false, error: 'Code must be 4–8 digits' };
      }
      result = await node.setValue(codeVid, trimmed);
    }

    if (!setValueOk(result)) {
      return { ok: false, error: `lock rejected write: ${describeSetValue(result)}` };
    }
    return { ok: true, status: describeSetValue(result) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
