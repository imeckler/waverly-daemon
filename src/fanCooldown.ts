// Post-session fan cooldown: once a sauna's heater slot ends, the fan keeps
// running for as long as the room keeps cooling, and stops when it no longer
// does. Kept free of the shellyController module (which loads config.json at
// import) so the decision can be unit-tested; the controller owns the switch.

export interface FanCooldownLimits {
  /** A reading is a new low only if it is this far below the previous one. Absorbs sensor jitter. */
  minDropF: number;
  /** Stop once readings have gone on this long without a new low. Missing readings do not count. */
  stallMs: number;
  /** Stop this long after the slot ended no matter what. */
  maxMs: number;
}

export interface FanCooldownState {
  slotEndedAt: number;
  lowestF: number | null;
  /** When the lowest reading was seen, and when the latest one was; the slot end until there is one. */
  lowestAt: number;
  latestAt: number;
}

export function newFanCooldown(slotEndedAt: number): FanCooldownState {
  return { slotEndedAt, lowestF: null, lowestAt: slotEndedAt, latestAt: slotEndedAt };
}

/** The state after one monitor cycle's reading. A missing reading leaves it unchanged. */
export function withReading(
  state: FanCooldownState,
  now: number,
  temperatureF: number | null,
  minDropF: number,
): FanCooldownState {
  if (temperatureF === null) return state;
  const isNewLow = state.lowestF === null || temperatureF <= state.lowestF - minDropF;
  return isNewLow
    ? { ...state, lowestF: temperatureF, lowestAt: now, latestAt: now }
    : { ...state, latestAt: now };
}

/** Why the fan should stop now, or null while the room is still cooling. */
export function stopReason(
  state: FanCooldownState,
  now: number,
  heaterShouldBeOn: boolean,
  { stallMs, maxMs }: FanCooldownLimits,
): string | null {
  if (heaterShouldBeOn) return 'heater is back on';
  if (now - state.slotEndedAt >= maxMs) return `${maxMs / 60000}min cap reached`;
  if (state.latestAt - state.lowestAt >= stallMs) return `no new low in ${stallMs / 60000}min (lowest ${state.lowestF}°F)`;
  return null;
}
