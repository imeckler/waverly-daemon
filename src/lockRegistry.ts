import { TranslatedValueID, ZWaveNode } from 'zwave-js';
import { setValueOk, describeSetValue, readSlotFromLock, confirmsCode, describeReading } from './lockManager';
import { userCodeSlots, userCodeValueId, userIdStatusValueId } from './lockSlots';
import { describeSecurityClass } from './lockPairing';
import { isLockOutOfOrder } from './lockOutOfOrder';
import { LockBattery, LockCodes, LockSlot } from '@waverly/sauna-protocol';

// Shared registry of the lock nodes the daemon controls. index.ts populates it
// as lock nodes become ready; the sauna-schedule control channel reads it to
// answer admin queries and to apply manual code changes.
const lockNodes = new Map<number, ZWaveNode>();

export function registerLock(node: ZWaveNode): void {
  lockNodes.set(node.id, node);
}

export function unregisterLock(nodeId: number): void {
  lockNodes.delete(nodeId);
}

// Kwikset SmartCode (and most Z-Wave locks) accept 4–8 digit codes.
const CODE_PATTERN = /^\d{4,8}$/;

function statusText(value: unknown): string {
  switch (value) {
    case 0: return 'available';
    case 1: return 'enabled';
    case 2: return 'disabled';
    case 254: return 'not available';
    default: return value === undefined ? 'unknown' : String(value);
  }
}

// Read the cached user-code state for every registered lock. Values come from
// the driver's cache, so this is fast and non-invasive — it does not wake the
// lock or hit the radio. The cache is only as good as the lock's reports: over
// S0 (the Kwikset) the driver fills it with whatever was last *sent*, so a slot
// shown as enabled here may never have been stored by the lock, and a slot the
// driver has dropped (see lockSlots.ts) reads as unknown. setLockCode reads the
// slot back from the lock itself for that reason.
export function getLockCodes(): LockCodes[] {
  const result: LockCodes[] = [];
  for (const node of lockNodes.values()) {
    const slots: LockSlot[] = userCodeSlots(node).map(slot => {
      const code = node.getValue<string>(userCodeValueId(slot));
      const status = node.getValue(userIdStatusValueId(slot));
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
      label: labelOf(node),
      security: securityOf(node),
      battery: batteryOf(node),
      outOfOrder: isLockOutOfOrder(node.id),
      autoLock: autoLockOf(node),
    });
  }
  return result;
}

function labelOf(node: ZWaveNode): string | null {
  const label = (node as unknown as { label?: unknown }).label;
  return typeof label === 'string' && label !== '' ? label : null;
}

function securityOf(node: ZWaveNode): string {
  const highest = node.getHighestSecurityClass();
  return highest === undefined || highest < 0 ? 'none' : describeSecurityClass(highest);
}

// The Battery CC's cached report. Locks push one when the level changes and
// answer the daemon's daily query; the timestamp is the driver's record of
// when the value last arrived.
export function batteryOf(node: ZWaveNode): LockBattery | null {
  const levelId = { commandClass: 128, endpoint: 0, property: 'level' };
  const level = node.getValue<number>(levelId);
  if (typeof level !== 'number') return null;
  const isLow = node.getValue<boolean>({ commandClass: 128, endpoint: 0, property: 'isLow' });
  const ts = node.getValueTimestamp(levelId);
  return {
    level,
    isLow: isLow === true,
    reportedAt: typeof ts === 'number' ? new Date(ts).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Auto-lock: the lock's own relock-after-unlock setting. On the Schlage it is
// the "Auto Lock" configuration parameter, which throws the deadbolt 30
// seconds after the door is opened. The parameter is found by the label the
// device database gives it, and the values that mean on and off come from the
// same place, so a lock without it (the Kwikset) has no setting rather than a
// wrong one.
// ---------------------------------------------------------------------------

interface AutoLockParam { valueId: TranslatedValueID; on: number; off: number }

function autoLockParam(node: ZWaveNode): AutoLockParam | null {
  const valueId = node.getDefinedValueIDs()
    .find(v => v.commandClass === 112 && typeof v.property === 'number' && v.propertyName === 'Auto Lock');
  if (!valueId) return null;
  const metadata = node.getValueMetadata(valueId);
  const states = Object.entries('states' in metadata ? metadata.states ?? {} : {});
  const valueLabelled = (label: string) => states.find(([, l]) => l === label)?.[0];
  const on = valueLabelled('Enable');
  const off = valueLabelled('Disable');
  return on === undefined || off === undefined ? null : { valueId, on: Number(on), off: Number(off) };
}

/** What the driver's cache says the lock's auto-lock is; null if the lock has no such setting or it is unknown. */
export function autoLockOf(node: ZWaveNode): boolean | null {
  const param = autoLockParam(node);
  if (!param) return null;
  const value = node.getValue<number>(param.valueId);
  return value === param.on ? true : value === param.off ? false : null;
}

/**
 * Turn a lock's auto-lock on or off, and read the parameter back from the
 * lock: as with codes, the radio's acknowledgement does not say the lock
 * stored it. The read-back also refreshes the cache getLockCodes reports.
 */
export async function setLockAutoLock(nodeId: number, autoLock: boolean): Promise<{ ok: boolean; error?: string }> {
  const node = lockNodes.get(nodeId);
  if (!node) return { ok: false, error: `Lock node ${nodeId} is not managed by this daemon` };
  const param = autoLockParam(node);
  if (!param) return { ok: false, error: `Lock node ${nodeId} has no auto-lock setting` };
  const want = autoLock ? param.on : param.off;
  try {
    const result = await node.setValue(param.valueId, want);
    if (!setValueOk(result)) return { ok: false, error: `lock rejected write: ${describeSetValue(result)}` };
    const reading = await node.commandClasses.Configuration.get(param.valueId.property as number);
    if (reading !== want) {
      return { ok: false, error: `lock did not confirm the write; it reports ${reading === undefined ? 'no answer' : `value ${reading}`}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
  if (!userCodeSlots(node).includes(slot)) {
    return { ok: false, error: `Lock node ${nodeId} has no user slot ${slot}` };
  }

  const trimmed = (code ?? '').trim();
  try {
    let result;
    if (trimmed === '') {
      // Clear the slot.
      result = await node.setValue(userIdStatusValueId(slot), 0);
    } else {
      if (!CODE_PATTERN.test(trimmed)) {
        return { ok: false, error: 'Code must be 4–8 digits' };
      }
      result = await node.setValue(userCodeValueId(slot), trimmed);
    }

    if (!setValueOk(result)) {
      return { ok: false, error: `lock rejected write: ${describeSetValue(result)}` };
    }

    // The radio's acknowledgement is not proof the lock stored anything; ask it.
    const reading = await readSlotFromLock(node, slot);
    const confirmed = trimmed === ''
      ? reading !== undefined && reading.status === 0
      : confirmsCode(reading, trimmed);
    if (!confirmed) {
      return { ok: false, error: `lock did not confirm the write; it reports: ${describeReading(reading)}` };
    }
    return { ok: true, status: `${describeSetValue(result)}, verified by lock` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
