import { ValueID, ZWaveNode } from 'zwave-js';

// ---------------------------------------------------------------------------
// Which user-code slots a lock has.
//
// The driver keeps a value for each slot it has heard about, but it also
// drops one: a lock that answers a query for a slot with "status not
// available" has that slot's value and metadata removed from the cache, and
// nothing puts them back short of a re-interview. The Schlage has answered
// that way right after a write to the slot, which made slot 1 vanish from
// the admin page and from the managers' capacity. A lock does not lose a slot
// that way, so the slots come from the count the lock reported when it was
// interviewed, and value ids are built rather than looked up: setValue and
// User Code Get need nothing from the cache.
// ---------------------------------------------------------------------------

const SUPPORTED_USERS: ValueID = { commandClass: 99, endpoint: 0, property: 'supportedUsers' };

/**
 * Slot numbers 1..N, N as the lock reported it. A lock that never reported a
 * count gets the slots the cache knows.
 */
export function userCodeSlots(node: ZWaveNode): number[] {
  const count = node.getValue<number>(SUPPORTED_USERS);
  if (typeof count === 'number' && count > 0) return Array.from({ length: count }, (_, i) => i + 1);
  return node.getDefinedValueIDs()
    .filter(v => v.commandClass === 99 && v.property === 'userCode' && typeof v.propertyKey === 'number' && v.propertyKey !== 0)
    .map(v => v.propertyKey as number)
    .sort((a, b) => a - b);
}

export function userCodeValueId(slot: number): ValueID {
  return { commandClass: 99, endpoint: 0, property: 'userCode', propertyKey: slot };
}

/** Writing Available (0) to this clears the slot; zwave-js maps it to UserCodeCC.clear. */
export function userIdStatusValueId(slot: number): ValueID {
  return { commandClass: 99, endpoint: 0, property: 'userIdStatus', propertyKey: slot };
}
