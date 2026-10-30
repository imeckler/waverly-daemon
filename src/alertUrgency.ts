// How urgently a connectivity or monitoring fault should page.
//
// The daemon's device alerts (Shelly unreachable, no temperature reading,
// temp-monitor script down, TOLO unreachable) are safety-relevant only while a
// heater is on or about to be: a cold room nobody is due in for hours can wait
// for the morning. The same fault at 6PM with a booking at 6:30 cannot. So the
// severity sent to PagerDuty is a function of heater state, not of the alert
// kind, and PagerDuty's dynamic urgency (critical/error = high, warning/info =
// low) turns that into "phone call now" versus "email".
//
// Overheat, welded relay, and should-be-hot-but-isn't are not routed through
// here: they are critical whenever they fire.

export type Severity = 'critical' | 'error' | 'warning' | 'info';

/** A heater due to start within this long counts as "on" for urgency. */
export const HEATER_DUE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Whether a room is on, or scheduled to be on within `windowMs` of `now`.
 * `on` is the physically observed relay state (an override can turn a heater
 * on with no plan slot), `slots` the plan's heater-on periods.
 */
export function heaterOnOrDue(
  slots: { start: Date; stop: Date }[],
  now: number,
  on: boolean,
  windowMs = HEATER_DUE_WINDOW_MS,
): boolean {
  if (on) return true;
  return slots.some(s => now < s.stop.getTime() && s.start.getTime() <= now + windowMs);
}

/** The severity for a connectivity/monitoring fault given heater urgency. */
export function linkFaultSeverity(urgent: boolean): Severity {
  return urgent ? 'critical' : 'warning';
}

/**
 * PagerDuty fixes an incident's urgency when it opens, so a low-urgency
 * incident that later becomes urgent would stay low. Low-urgency triggers
 * therefore get their own dedup key: escalating opens a fresh high-urgency
 * incident instead of appending to the quiet one. Critical keeps the bare key
 * so existing incidents and runbooks keep their names.
 */
export function dedupKeyFor(dedupKey: string, severity: Severity): string {
  return severity === 'critical' || severity === 'error' ? dedupKey : `${dedupKey}-low`;
}

/** Both keys an incident may be open under, for resolving. */
export function dedupKeysFor(dedupKey: string): string[] {
  return [dedupKey, `${dedupKey}-low`];
}

/**
 * Whether the daemon has lost its own network, as opposed to a device having
 * lost its. When every device is unreachable at once and the booking server
 * is too, the fault is on the Pi's side (WiFi dropped, router rebooted), and
 * nothing here is observable: the booking server's dead-man's switch owns that
 * condition. Paging per device would turn one outage into one page per
 * device, all delivered in a burst when the link returns, about conditions
 * that never existed.
 */
export function localNetworkOutage(
  devices: { reachable: boolean }[],
  serverConnected: boolean,
): boolean {
  if (serverConnected) return false;
  if (devices.length === 0) return false;
  return devices.every(d => !d.reachable);
}
