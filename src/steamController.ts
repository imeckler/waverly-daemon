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

import { ToloClient, ToloCommunicationError } from './tolo/index.js';
import { FanCooldownLimits, FanCooldownState, newFanCooldown, withReading, stopReason } from './fanCooldown.js';

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
const TARGET_TEMPERATURE_C = 48;

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

// Minutes the TOLO fan timer is (re-)armed to on every tick of a cooldown: the
// fan's dead-man's switch, as POWER_TIMER_MINUTES is the heater's. Must be <=
// FAN_TIMER_MAX (60).
const FAN_TIMER_MINUTES = 10;

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

/** Apply an admin override to the steam room (relayed from the server). */
export function setSteamOverride(override: 'on' | 'off' | 'none'): void {
  steamOverride = override;
  steamOverrideExpiresAt = override === 'on' ? Date.now() + OVERRIDE_ON_DURATION_MS : 0;
  // Drive the change now rather than waiting for the next control tick.
  requestApply();
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
    const status = await c.getStatus();
    if (!status.powerOn) {
      console.log('steam: unit is off, powering on');
      await c.setPowerOn(true);
    }
  } else {
    await c.setPowerOn(false);
  }

  await driveFanCooldown(c, desiredOn, sessionEndedNow, now);
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
  if (c) await c.close();
}
