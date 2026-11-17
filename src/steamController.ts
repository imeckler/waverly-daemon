// Control for the TOLO/STEAMTEC AIO steam room.
//
// Unlike the Shelly sauna heaters — which run an on-device mJS thermostat that
// self-enforces override expiry, duty-cycle limits, and heartbeat backstops — the
// TOLO unit is a dumb UDP endpoint with no on-device safety script. So the daemon
// enforces everything here.
//
// Powering the unit on takes two commands. `setPowerOn(true)` is what actually
// starts it — arming the power timer alone does NOT power the unit on (verified
// on the hardware: SET_POWER_TIMER leaves powerOn=0; only SET_POWER_ON flips it).
// The power timer is then re-armed on every control tick as a dead-man's-switch:
// if the daemon dies or loses its (WireGuard) link to the box, the timer lapses
// and the unit powers itself off. The unit is never left on without it armed.
//
// The room is driven by the operational plan from the server, with an admin
// override taking precedence. Where the Shelly heaters get their schedules
// *pushed onto the device* — so they keep running through a daemon outage — the
// TOLO box has no on-device scheduler, so the plan is held here in memory and
// enforced by the control tick. The consequence is deliberate and worth stating:
// if this daemon stops, the steam room stops with it. That is the safe direction
// to fail for a unit with no independent supervision.
//
// After a session the unit's ventilation fan runs while the room is still
// cooling and stops once it no longer is (fanCooldown.ts, shared with the sauna
// fans). The fan is driven the same way as the heater: its own timer is re-armed
// every tick as a dead-man's switch, so a daemon outage mid-cooldown leaves the
// fan to switch itself off within minutes.
//
// During a session the fan can also run a set share of each cycle (fanDuty.ts;
// the share and the cycle length are set from the admin page and carried on
// the plan). The unit stops making steam once the room sits at its target, so
// without some airflow the room goes stale; the fan cycles on and off from the
// moment the room first reaches its target. At 0% the fan is left alone
// during sessions.

import { ToloClient, ToloCommunicationError, Calefaction } from './tolo/index.js';
import type { ToloStatus } from './tolo/index.js';
import { FanCooldownLimits, FanCooldownState, newFanCooldown, withReading, stopReason } from './fanCooldown.js';
import { dutyFanOn, FanDuty, NO_FAN_DUTY } from './fanDuty.js';
import { heaterOnOrDue, HEATER_DUE_WINDOW_MS } from './alertUrgency.js';

// Structurally compatible with shellyController's SaunaStatus so it can be dropped
// straight into the status report posted to the server.
export type SteamStatus = {
  on: boolean;
  temperatureF: number | null;
  powerW: number | null;
  reachable: boolean;
  heartbeatOk: boolean;
  manualResetRequired: boolean | null;
  override: 'on' | 'off' | 'none';
  overrideExpiresAt: number | null;
};

// An 'on' override auto-reverts to 'none' after this long (matches the heaters).
const OVERRIDE_ON_DURATION_MS = 60 * 60 * 1000;

// Minutes the TOLO power timer is (re-)armed to while the room should be on. Short
// enough to fail safe if control is lost, long enough to survive a missed tick or
// two. Must be <= POWER_TIMER_MAX (60).
const POWER_TIMER_MINUTES = 10;

// Target temperature the room is driven to whenever it's on. Re-asserted every
// tick alongside the power timer, so a change made at the wall panel is undone
// within a tick. Must be within TARGET_TEMPERATURE_MIN..MAX (35..60).
const TARGET_TEMPERATURE_C = 50;

const DEFAULT_CONTROL_INTERVAL_MS = 30_000;

// Post-session fan cooldown limits. The daemon itself enforces the cap (the
// unit's fan timer is at most 60 minutes). The stall window is longer than the
// sauna fans' because the unit reports whole degrees Celsius: a reading only
// moves once the room has dropped 1.8°F, which took 6-10 minutes early in the
// cooldown and 20-40 minutes an hour in on 2026-10-14, with a plateau of up to
// 13 minutes right after the session. A 5-minute window ended every cooldown
// at its first tick.
const DEFAULT_FAN_COOLDOWN: FanCooldownLimits = {
  minDropF: 0.5,
  stallMs: 30 * 60 * 1000,
  maxMs: 3 * 60 * 60 * 1000,
};

// Minutes the TOLO fan timer is (re-)armed to on every tick the daemon wants the
// fan running (a cooldown, or the on stretch of the session duty cycle): the
// fan's dead-man's switch, as POWER_TIMER_MINUTES is the heater's. Must be <=
// FAN_TIMER_MAX (60).
const FAN_TIMER_MINUTES = 10;

// The room counts as having reached its target, and the session duty cycle
// starts, once the unit reads within this much of TARGET_TEMPERATURE_C. The
// unit reports whole degrees, and a room that levels off a degree short is
// just as idle.
const TARGET_REACHED_MARGIN_C = 1;

function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/** A period the plan wants the steam room powered for. */
export type SteamPeriod = { start: Date; stop: Date; hotFrom: Date | null };

let client: ToloClient | null = null;
let steamOverride: 'on' | 'off' | 'none' = 'none';
let steamOverrideExpiresAt = 0; // epoch ms; 0 unless an 'on' override is active
let controlInterval: ReturnType<typeof setInterval> | null = null;
let schedule: SteamPeriod[] = [];
let schedulePlanDate: string | null = null;
// Last state we drove towards, so the tick only logs transitions rather than
// narrating every 30 seconds.
let lastDesiredOn: boolean | null = null;
let fanCooldownLimits: FanCooldownLimits = DEFAULT_FAN_COOLDOWN;
// The cooldown in progress, if any.
let fanCooldown: FanCooldownState | null = null;
// When the most recent period that had already ended when the plan arrived
// ended, if that was within the cooldown cap. A daemon restarted (or a plan
// re-sent) mid-cooldown finds the fan running and picks the cooldown up from
// here; the next tick consumes it.
let endedBeforePlanAt: number | null = null;
// Session fan duty cycle: the share and cycle length from the latest plan, when
// the room first reached its target in the session under way, and whether the
// duty cycle last drove the fan on (so it only ever switches off a fan it
// switched on, and a fan started at the panel is left be).
let fanDuty: FanDuty = NO_FAN_DUTY;
let reachedTargetAt: number | null = null;
let dutyDroveFanOn = false;
// The unit's heating state as last logged, so a session's log shows when it
// stops making steam and at what temperature and humidity.
let lastCalefaction: Calefaction | null = null;

/** Apply an admin override to the steam room (relayed from the server). */
export function setSteamOverride(override: 'on' | 'off' | 'none'): void {
  steamOverride = override;
  steamOverrideExpiresAt = override === 'on' ? Date.now() + OVERRIDE_ON_DURATION_MS : 0;
  // Drive the change now rather than waiting for the next control tick.
  requestApply();
}

const describeDuty = (d: FanDuty) => `${d.percent}% of every ${d.cycleMs / 60_000}min`;

/**
 * Set how the fan runs during a session once the room is at temperature: on
 * for `percent` (0-100) of every cycle of `cycleMs`. Arrives with every plan;
 * the caller has validated it (parseFanDuty). A change takes effect on the next
 * tick, with the cycle still counted from when the room reached its target.
 */
export function setSteamFanDuty(duty: FanDuty): void {
  if (duty.percent !== fanDuty.percent || duty.cycleMs !== fanDuty.cycleMs) {
    console.log(`steam: session fan duty ${describeDuty(fanDuty)} -> ${describeDuty(duty)}`);
  }
  fanDuty = duty;
}

/**
 * Take the steam room's periods from a new operational plan.
 *
 * Replaces the schedule wholesale — the server sends the whole day every time,
 * and a replan can withdraw a period as readily as add one, so merging would let
 * a cancelled period linger. Periods that have already passed are dropped on the
 * way in; they can't affect anything and they clutter the logs.
 */
export function applySteamSchedule(periods: SteamPeriod[], planDate: string): void {
  const now = Date.now();
  schedule = periods
    .filter(p => p.stop.getTime() > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  schedulePlanDate = planDate;
  const recentlyEnded = periods
    .map(p => p.stop.getTime())
    .filter(stop => stop <= now && now - stop < fanCooldownLimits.maxMs);
  endedBeforePlanAt = recentlyEnded.length ? Math.max(...recentlyEnded) : null;

  if (schedule.length === 0) {
    console.log(`steam: plan ${planDate} has no upcoming periods`);
  } else {
    const summary = schedule
      .map(p => `${p.start.toISOString()} → ${p.stop.toISOString()}`)
      .join(', ');
    console.log(`steam: plan ${planDate}, ${schedule.length} period(s): ${summary}`);
  }

  // Drive the change now rather than waiting for the next control tick — a plan
  // can land at the exact moment a period should already have started.
  requestApply();
}

/** Whether the plan wants the room powered at `now`. */
function scheduledOn(now: number): boolean {
  return schedule.some(p => now >= p.start.getTime() && now < p.stop.getTime());
}

/**
 * Whether the steam room is on, or due on within `windowMs`: the observed power
 * state, an 'on' override, or a plan period in progress or about to start.
 * Decides how urgently a TOLO fault pages (see alertUrgency).
 */
export function steamOnOrDue(now: number, on: boolean, windowMs = HEATER_DUE_WINDOW_MS): boolean {
  if (on || steamOverride === 'on') return true;
  return heaterOnOrDue(schedule, now, false, windowMs);
}

function expireOverrideIfNeeded(): void {
  if (steamOverride === 'on' && steamOverrideExpiresAt > 0 && Date.now() >= steamOverrideExpiresAt) {
    console.log('steam: override "on" expired, reverting to "none"');
    steamOverride = 'none';
    steamOverrideExpiresAt = 0;
  }
}

// Applies never overlap. Powering on is several round-trips to the box, and an
// override or replan can land in the middle of one; if its apply ran
// concurrently, the older apply's remaining commands could undo the newer
// decision (an "on" re-powering the unit after an "off" had shut it). Instead
// a request made while an apply is running is folded into one more run after
// it, which reads the (now current) desired state afresh.
let applyRunning = false;
let applyRequested = false;

function requestApply(): void {
  if (applyRunning) {
    applyRequested = true;
    return;
  }
  applyRunning = true;
  void (async () => {
    do {
      applyRequested = false;
      try {
        await applySteamState();
      } catch (e) {
        console.error('steam: apply failed:', e);
      }
    } while (applyRequested);
    applyRunning = false;
  })();
}

async function applySteamState(): Promise<void> {
  // Pin the client for the whole apply: stopSteamController() may null the
  // module-level one while we're between round-trips.
  const c = client;
  if (!c) return;
  expireOverrideIfNeeded();

  // An admin override wins outright, in both directions: 'off' keeps the room
  // shut through a scheduled period (a member reported a fault, say), 'on' opens
  // it outside one. With no override in force the plan decides.
  const now = Date.now();
  const desiredOn =
    steamOverride === 'on' ? true :
      steamOverride === 'off' ? false :
        scheduledOn(now);

  // A session ends when we go from driving the room on to driving it off; the
  // first decision after a start is not one (see endedBeforePlanAt for that).
  const sessionEndedNow = lastDesiredOn === true && !desiredOn;
  if (desiredOn !== lastDesiredOn) {
    const why = steamOverride === 'none' ? `plan ${schedulePlanDate ?? '(none)'}` : `override "${steamOverride}"`;
    console.log(`steam: turning ${desiredOn ? 'on' : 'off'} (${why})`);
    lastDesiredOn = desiredOn;
  }

  if (desiredOn) {
    // Arm the auto-off backstop first, then make sure the unit is actually
    // running. Arming the timer does not power the unit on by itself, and
    // SET_POWER_ON is only sent when the unit reports itself off — so a unit
    // that is already running isn't poked every tick, and a unit that its own
    // timer (or someone at the panel) switched off gets brought back within one
    // tick, visibly in the log.
    await c.setPowerTimer(POWER_TIMER_MINUTES);
    await c.setTargetTemperature(TARGET_TEMPERATURE_C);
    // A cooldown still running from an earlier session ends here (the room is
    // back on) and switches the fan off, so it goes before the status read the
    // duty cycle decides from.
    await driveFanCooldown(c, desiredOn, sessionEndedNow, now);
    const status = await c.getStatus();
    if (!status.powerOn) {
      console.log('steam: unit is off, powering on');
      await c.setPowerOn(true);
    }
    await logHeatingState(c, status);
    await driveFanDuty(c, status, now);
  } else {
    reachedTargetAt = null;
    dutyDroveFanOn = false;
    lastCalefaction = null;
    await c.setPowerOn(false);
    // A fan the duty cycle left on is simply carried into the cooldown.
    await driveFanCooldown(c, desiredOn, sessionEndedNow, now);
  }
}

/**
 * Log the unit's heating state when it changes during a session, with the
 * room's temperature and humidity and the humidity target, so the log shows
 * whether it stops making steam on temperature or on humidity.
 */
async function logHeatingState(c: ToloClient, status: ToloStatus): Promise<void> {
  if (status.calefaction === lastCalefaction) return;
  const was = lastCalefaction === null ? 'session start' : Calefaction[lastCalefaction];
  lastCalefaction = status.calefaction;
  const settings = await c.getSettings();
  console.log(
    `steam: heating ${was} -> ${Calefaction[status.calefaction]}; room ${status.currentTemperature}°C ` +
    `(target ${settings.targetTemperature}°C), humidity ${status.currentHumidity}% ` +
    `(target ${settings.targetHumidity}%), fan ${status.fanOn ? 'on' : 'off'}`,
  );
}

/**
 * One tick of the session duty cycle, while the room is driven on. Once the
 * room first reaches its target, the fan runs fanDuty.percent of each cycle
 * (fanDuty.ts). While it should be on its timer is re-armed every tick as its
 * dead-man's switch and it is switched back on if found off (a lapsed timer);
 * at the end of an on stretch it is switched off only if the duty cycle had
 * switched it on, so a fan someone started at the panel is left alone. At 0%
 * the duty cycle never switches the fan on.
 */
async function driveFanDuty(c: ToloClient, status: ToloStatus, now: number): Promise<void> {
  if (reachedTargetAt === null && status.currentTemperature >= TARGET_TEMPERATURE_C - TARGET_REACHED_MARGIN_C) {
    reachedTargetAt = now;
    console.log(`steam: room at ${status.currentTemperature}°C, at temperature; session fan duty ${describeDuty(fanDuty)}`);
  }
  const wantOn = reachedTargetAt !== null && dutyFanOn(fanDuty, reachedTargetAt, now);
  if (wantOn) {
    // Timer first, so the fan is never running without its backstop armed.
    await c.setFanTimer(FAN_TIMER_MINUTES);
    if (!status.fanOn) {
      await c.setFanOn(true);
      if (dutyDroveFanOn) console.log('steam: duty fan found off mid-stretch; switching it back on');
    }
    if (!dutyDroveFanOn) console.log(`steam: duty fan on (${describeDuty(fanDuty)})`);
    dutyDroveFanOn = true;
  } else if (dutyDroveFanOn) {
    dutyDroveFanOn = false;
    console.log('steam: duty fan off');
    await c.setFanOn(false);
  }
}

/**
 * One tick's worth of post-session fan cooldown. Starts the fan when a session
 * ends, feeds the room's temperature in while it runs, and switches the fan off
 * once the room has stopped cooling, the cap hits, or the room is back on.
 * Setting the fan timer does not start the fan (like the power timer, verified
 * on the hardware for power), so the fan is switched on explicitly, and only
 * here: a cooldown that has already ended is never restarted.
 */
async function driveFanCooldown(c: ToloClient, desiredOn: boolean, sessionEndedNow: boolean, now: number): Promise<void> {
  if (sessionEndedNow) {
    // Timer first, so the fan is never running without its backstop armed.
    await c.setFanTimer(FAN_TIMER_MINUTES);
    await c.setFanOn(true);
    fanCooldown = newFanCooldown(now);
    endedBeforePlanAt = null;
    console.log('steam: session over; fan on while the room keeps cooling');
    return;
  }

  if (!fanCooldown) {
    if (endedBeforePlanAt === null) return;
    const endedAt = endedBeforePlanAt;
    endedBeforePlanAt = null;
    if (desiredOn) return;
    // Mid-cooldown (daemon restart or a plan re-sent): pick it up where it is,
    // but only if the fan is still running. A finished cooldown stays finished.
    const status = await c.getStatus();
    if (!status.fanOn) return;
    fanCooldown = newFanCooldown(endedAt);
    console.log(`steam: fan is running after a period that ended ${new Date(endedAt).toISOString()}; picking up the cooldown`);
  }

  const status = await c.getStatus();
  if (!status.fanOn) {
    // The timer lapsed (ticks were missed) or someone switched it off at the
    // panel. Either way the cooldown is over; don't bring the fan back.
    fanCooldown = null;
    console.log('steam: fan is off mid-cooldown; leaving it off');
    return;
  }
  fanCooldown = withReading(fanCooldown, now, celsiusToFahrenheit(status.currentTemperature), fanCooldownLimits.minDropF);
  const reason = stopReason(fanCooldown, now, desiredOn, fanCooldownLimits);
  if (reason === null) {
    await c.setFanTimer(FAN_TIMER_MINUTES);
    return;
  }
  fanCooldown = null;
  console.log(`steam: fan cooldown over (${reason}); turning fan off`);
  await c.setFanOn(false);
}

/**
 * Read current steam-room status for the daemon's status report. Returns null when
 * the steam room isn't configured (so it's simply omitted from the report).
 */
export async function getSteamStatus(): Promise<SteamStatus | null> {
  if (!client) return null;
  expireOverrideIfNeeded();
  const override = steamOverride;
  const overrideExpiresAt = override === 'on' && steamOverrideExpiresAt > 0 ? steamOverrideExpiresAt : null;
  try {
    const status = await client.getStatus();
    return {
      on: status.powerOn,
      temperatureF: celsiusToFahrenheit(status.currentTemperature),
      powerW: null,
      reachable: true,
      heartbeatOk: true,
      manualResetRequired: null,
      override,
      overrideExpiresAt,
    };
  } catch (e) {
    if (!(e instanceof ToloCommunicationError)) console.error('steam: getStatus failed:', e);
    return {
      on: false,
      temperatureF: null,
      powerW: null,
      reachable: false,
      heartbeatOk: false,
      manualResetRequired: null,
      override,
      overrideExpiresAt,
    };
  }
}

/** Construct the TOLO client and start the control tick loop. */
export function startSteamController(
  host: string,
  port?: number,
  // Tests run a fast tick and short cooldown limits against the simulator.
  options: { controlIntervalMs?: number; fanCooldown?: FanCooldownLimits } = {},
): void {
  if (controlInterval) return;
  const intervalMs = options.controlIntervalMs ?? DEFAULT_CONTROL_INTERVAL_MS;
  fanCooldownLimits = options.fanCooldown ?? DEFAULT_FAN_COOLDOWN;
  client = new ToloClient(host, port);
  console.log(
    `Starting steam controller (TOLO ${host}:${port ?? 51500}, control every ${intervalMs / 1000}s)`,
  );
  controlInterval = setInterval(requestApply, intervalMs);
}

/**
 * Stop the control loop and release the socket.
 *
 * Note what this deliberately does *not* do: switch the unit (or its fan) off. The power
 * timer is the backstop — it lapses within POWER_TIMER_MINUTES of the last tick
 * and the unit powers itself down — so a daemon shutting down leaves the room to
 * fail safe on its own rather than depending on one last packet landing.
 */
export async function stopSteamController(): Promise<void> {
  if (controlInterval) {
    clearInterval(controlInterval);
    controlInterval = null;
  }
  const c = client;
  client = null;
  schedule = [];
  schedulePlanDate = null;
  steamOverride = 'none';
  steamOverrideExpiresAt = 0;
  lastDesiredOn = null;
  // The fan is left to its timer for the same reason as the heater.
  fanCooldown = null;
  endedBeforePlanAt = null;
  fanCooldownLimits = DEFAULT_FAN_COOLDOWN;
  fanDuty = NO_FAN_DUTY;
  reachedTargetAt = null;
  dutyDroveFanOn = false;
  lastCalefaction = null;
  if (c) await c.close();
}
