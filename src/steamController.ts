// Control for the TOLO/STEAMTEC AIO steam room.
//
// Unlike the Shelly sauna heaters — which run an on-device mJS thermostat that
// self-enforces override expiry, duty-cycle limits, and heartbeat backstops — the
// TOLO unit is a dumb UDP endpoint with no on-device safety script. So the daemon
// enforces everything here.
//
// Turning the unit ON is done ONLY via `setPowerTimer`, re-armed on every control
// tick. That doubles as a dead-man's-switch: if the daemon dies or loses its
// (WireGuard) link to the box, the power timer lapses and the unit powers itself
// off. `setPowerOn(true)` is deliberately never used — it has no such backstop.
//
// The room is driven by the operational plan from the server, with an admin
// override taking precedence. Where the Shelly heaters get their schedules
// *pushed onto the device* — so they keep running through a daemon outage — the
// TOLO box has no on-device scheduler, so the plan is held here in memory and
// enforced by the control tick. The consequence is deliberate and worth stating:
// if this daemon stops, the steam room stops with it. That is the safe direction
// to fail for a unit with no independent supervision.

import { ToloClient, ToloCommunicationError } from './tolo/index.js';

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

const CONTROL_INTERVAL_MS = 30_000;

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

/** Apply an admin override to the steam room (relayed from the server). */
export function setSteamOverride(override: 'on' | 'off' | 'none'): void {
  steamOverride = override;
  steamOverrideExpiresAt = override === 'on' ? Date.now() + OVERRIDE_ON_DURATION_MS : 0;
  // Drive the change now rather than waiting for the next control tick.
  void applySteamState().catch(e => console.error('steam: apply after override failed:', e));
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
  void applySteamState().catch(e => console.error('steam: apply after schedule failed:', e));
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

async function applySteamState(): Promise<void> {
  if (!client) return;
  expireOverrideIfNeeded();

  // An admin override wins outright, in both directions: 'off' keeps the room
  // shut through a scheduled period (a member reported a fault, say), 'on' opens
  // it outside one. With no override in force the plan decides.
  const desiredOn =
    steamOverride === 'on' ? true :
    steamOverride === 'off' ? false :
    scheduledOn(Date.now());

  if (desiredOn !== lastDesiredOn) {
    const why = steamOverride === 'none' ? `plan ${schedulePlanDate ?? '(none)'}` : `override "${steamOverride}"`;
    console.log(`steam: turning ${desiredOn ? 'on' : 'off'} (${why})`);
    lastDesiredOn = desiredOn;
  }

  if (desiredOn) {
    // Re-arm the power timer: this both powers the unit on and refreshes the
    // auto-off countdown. Never setPowerOn(true).
    await client.setPowerTimer(POWER_TIMER_MINUTES);
  } else {
    await client.setPowerOn(false);
  }
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
export function startSteamController(host: string, port?: number): void {
  if (controlInterval) return;
  client = new ToloClient(host, port);
  console.log(
    `Starting steam controller (TOLO ${host}:${port ?? 51500}, control every ${CONTROL_INTERVAL_MS / 1000}s)`,
  );
  controlInterval = setInterval(() => {
    void applySteamState().catch(e => console.error('steam: control tick failed:', e));
  }, CONTROL_INTERVAL_MS);
}

/**
 * Stop the control loop and release the socket.
 *
 * Note what this deliberately does *not* do: switch the unit off. The power
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
  if (c) await c.close();
}
