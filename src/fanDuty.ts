// Steam-room fan duty cycle: during a session, once the room has reached its
// target, the ventilation fan runs a set share of each cycle. The TOLO stops
// making steam while the room sits at its setpoint, so the room goes stale;
// airing it out brings the temperature down a touch and the steam back on.
// Both the share and the cycle length are set from the admin page and carried
// on the plan. Kept free of the controller (which holds the TOLO socket) so the
// timing can be unit-tested; the controller owns the switch.

import {
  STEAM_FAN_CYCLE_MINUTES_DEFAULT,
  STEAM_FAN_CYCLE_MINUTES_MAX,
  STEAM_FAN_CYCLE_MINUTES_MIN,
} from '@waverly/sauna-protocol';

export interface FanDuty {
  /** Share of each cycle the fan is on, 0-100. */
  percent: number;
  /** Length of one on/off cycle. */
  cycleMs: number;
}

/** No fan during sessions, at the default cycle: what the daemon does until a plan says otherwise. */
export const NO_FAN_DUTY: FanDuty = { percent: 0, cycleMs: STEAM_FAN_CYCLE_MINUTES_DEFAULT * 60_000 };

/**
 * Whether the fan should be on at `now`, for `percent` of each cycle, counting
 * cycles from `since` (when the room first reached its target this session).
 * Each cycle opens with the on stretch, since reaching the setpoint is exactly
 * when the steam stops.
 */
export function dutyFanOn({ percent, cycleMs }: FanDuty, since: number, now: number): boolean {
  if (percent <= 0 || now < since) return false;
  if (percent >= 100) return true;
  const intoCycle = (now - since) % cycleMs;
  return intoCycle < (percent / 100) * cycleMs;
}

const show = (value: unknown) => (typeof value === 'number' ? String(value) : JSON.stringify(value));

/**
 * The fan duty carried by a schedule update. A missing field takes its default
 * (a server predating the setting): 0% and STEAM_FAN_CYCLE_MINUTES_DEFAULT. A
 * value out of range is a server bug; it is reported and the default used, so
 * a bad percentage leaves the fan alone during sessions as before.
 */
export function parseFanDuty(percent: unknown, cycleMinutes: unknown): FanDuty {
  let p = NO_FAN_DUTY.percent;
  if (percent !== undefined && percent !== null) {
    if (typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
      p = percent;
    } else {
      console.error(`steam: ignoring invalid fan duty ${show(percent)}%; fan left alone during sessions`);
    }
  }
  let minutes = STEAM_FAN_CYCLE_MINUTES_DEFAULT;
  if (cycleMinutes !== undefined && cycleMinutes !== null) {
    if (
      typeof cycleMinutes === 'number' && Number.isFinite(cycleMinutes) &&
      cycleMinutes >= STEAM_FAN_CYCLE_MINUTES_MIN && cycleMinutes <= STEAM_FAN_CYCLE_MINUTES_MAX
    ) {
      minutes = cycleMinutes;
    } else {
      console.error(`steam: ignoring invalid fan cycle ${show(cycleMinutes)}min; using ${STEAM_FAN_CYCLE_MINUTES_DEFAULT}min`);
    }
  }
  return { percent: p, cycleMs: minutes * 60_000 };
}
