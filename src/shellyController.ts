import * as fs from 'fs';
import * as crypto from 'crypto';
import { triggerIncident, resolveIncident } from './pagerduty.js';

const RPC_TIMEOUT_MS = 10_000;
const SWITCH_MAX_RETRIES = 3;
const SWITCH_RETRY_DELAY_MS = 2_000;
const TEMP_CHECK_INTERVAL_MS = 30_000;
const OVERHEAT_MARGIN_F = 15;

// How many consecutive check cycles a condition must persist before alerting.
// At 30s intervals this is 2.5 minutes.
const ALERT_THRESHOLD_CYCLES = 5;

// Minimum expected temperature rise (°F) over TEMP_RISE_WINDOW_MS when heater should be on.
// If temp doesn't rise by at least this much, something is wrong.
const TEMP_RISE_MIN_F = 2;
const TEMP_RISE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Warmup time in minutes (must match plan.ts constant)
const WARMUP_TIME_MINUTES = 60;

// How far below target a sauna can be when it should already be hot
const NOT_HOT_TOLERANCE_F = 30;

// Track active PagerDuty incidents so we can auto-resolve
const activeDeviceIncidents = new Map<string, string>();

// Track consecutive failure counts for threshold-based alerts
const failCounts = new Map<string, number>();

// Current operational plan (set when schedule is applied)
let currentPlan: OperationalPlan | null = null;

// Recent temperature readings per sauna for rate-of-change checks
const tempHistory: Record<string, { temperatureF: number; timestamp: number }[]> = {
  small: [],
  big: [],
};

interface ShellyConfig {
  small_sauna_heater_ip: string;
  small_sauna_lights_fan_ip: string;
  small_sauna_lights_switch_id: number;
  small_sauna_fan_switch_id: number;
  big_sauna_heater_ip: string;
  big_sauna_lights_fan_ip: string;
  big_sauna_lights_switch_id: number;
  big_sauna_fan_switch_id: number;
  temperature_threshold: number;
  password: string;
  sauna_server_url: string;
  daemon_secret?: string;
}

function loadShellyConfig(): ShellyConfig {
  const configPath = process.env.DAEMON_CONFIG_FILE || './config.json';
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(configData);
    if (!parsed.shelly) {
      throw new Error('No shelly configuration found in config.json');
    }
    if (parsed.shelly.sauna_server_url && !/^https?:\/\//.test(parsed.shelly.sauna_server_url)) {
      throw new Error(`shelly.sauna_server_url must start with http:// or https:// (got "${parsed.shelly.sauna_server_url}")`);
    }
    return parsed.shelly;
  } catch (error) {
    console.error(`Failed to load Shelly config from ${configPath}:`, error);
    throw error;
  }
}

const config = loadShellyConfig();

export interface Slot {
  start: Date;
  stop: Date;
}

export interface OperationalPlan {
  small: Slot[];
  big: Slot[];
  bookingCosts?: any[];
}

export interface Booking {
  start: Date;
  stop: Date;
  unitId: number; // 1 = small sauna, 2 = big sauna
}

// --- Digest auth ---

function parseDigestChallenge(header: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const params = header.replace(/^Digest\s+/i, '');
  const re = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
  let match;
  while ((match = re.exec(params)) !== null) {
    fields[match[1]] = match[2] ?? match[3];
  }
  return fields;
}

function buildDigestAuth(
  username: string,
  password: string,
  method: string,
  uri: string,
  challenge: Record<string, string>,
  nc: number
): string {
  const { realm, nonce, qop, algorithm } = challenge;
  const algo = (algorithm ?? 'MD5').toUpperCase();
  const hashFn = algo === 'SHA-256' ? 'sha256' : 'md5';

  const ncHex = nc.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(16).toString('hex');

  const ha1 = crypto.createHash(hashFn)
    .update(`${username}:${realm}:${password}`)
    .digest('hex');
  const ha2 = crypto.createHash(hashFn)
    .update(`${method}:${uri}`)
    .digest('hex');

  let response: string;
  if (qop === 'auth') {
    response = crypto.createHash(hashFn)
      .update(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
      .digest('hex');
  } else {
    response = crypto.createHash(hashFn)
      .update(`${ha1}:${nonce}:${ha2}`)
      .digest('hex');
  }

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=${algo}, response="${response}"`;
  if (qop) {
    header += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`;
  }
  return header;
}

// --- RPC ---

export async function shellyRpc(ip: string, method: string, params: any = {}): Promise<any> {
  const uri = `/rpc/${method}`;
  const url = `http://${ip}${uri}`;
  const body = JSON.stringify(params);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });

    if (response.status !== 401) {
      if (!response.ok) {
        throw new Error(`Shelly RPC failed: ${response.status} ${response.statusText}`);
      }
      return await response.json();
    }

    // 401 — need digest auth
    const wwwAuth = response.headers.get('www-authenticate');
    if (!wwwAuth) {
      throw new Error('Shelly returned 401 but no WWW-Authenticate header');
    }

    const challenge = parseDigestChallenge(wwwAuth);
    const authorization = buildDigestAuth(
      'admin',
      config.password,
      'POST',
      uri,
      challenge,
      1
    );

    const authResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authorization,
      },
      body,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });

    if (!authResponse.ok) {
      throw new Error(`Shelly RPC (authed) failed: ${authResponse.status} ${authResponse.statusText}`);
    }

    return await authResponse.json();
  } catch (error) {
    console.error(`Error calling Shelly RPC ${method} on ${ip}:`, error);
    throw error;
  }
}

// --- Switch control with retries + PagerDuty ---

async function resolveDeviceIncident(ip: string, switchId: number): Promise<void> {
  const dedupKey = `shelly-${ip}-sw${switchId}`;
  if (activeDeviceIncidents.has(dedupKey)) {
    try {
      await resolveIncident(dedupKey);
      activeDeviceIncidents.delete(dedupKey);
      console.log(`Resolved PagerDuty incident for ${ip} switch:${switchId}`);
    } catch (e) {
      console.error(`Failed to resolve PagerDuty incident ${dedupKey}:`, e);
    }
  }
}

async function setSwitch(ip: string, switchId: number, on: boolean): Promise<void> {
  const label = `${ip} switch:${switchId}`;
  const desired = on ? 'ON' : 'OFF';

  for (let attempt = 1; attempt <= SWITCH_MAX_RETRIES; attempt++) {
    try {
      console.log(`Setting ${label} to ${desired} (attempt ${attempt}/${SWITCH_MAX_RETRIES})`);
      await shellyRpc(ip, 'Switch.Set', { id: switchId, on });

      const status = await shellyRpc(ip, 'Switch.GetStatus', { id: switchId });
      if (status.output === on) {
        await resolveDeviceIncident(ip, switchId);
        return;
      }

      console.warn(`${label} verification failed: expected ${desired}, got ${status.output ? 'ON' : 'OFF'}`);
    } catch (error) {
      console.error(`${label} attempt ${attempt} failed:`, error);
    }

    if (attempt < SWITCH_MAX_RETRIES) {
      await new Promise(r => setTimeout(r, SWITCH_RETRY_DELAY_MS));
    }
  }

  const dedupKey = `shelly-${ip}-sw${switchId}`;
  const summary = `Shelly device ${label} failed to set to ${desired} after ${SWITCH_MAX_RETRIES} attempts`;
  console.error(summary);

  try {
    await triggerIncident(summary, 'critical', dedupKey, { ip, switchId, desired });
    activeDeviceIncidents.set(dedupKey, dedupKey);
  } catch (e) {
    console.error('Failed to trigger PagerDuty incident:', e);
  }
}

// --- Helper functions ---

async function clearSchedules(ip: string): Promise<void> {
  console.log(`Clearing schedules on ${ip}`);
  await shellyRpc(ip, 'Schedule.DeleteAll');
}

async function setKVS(ip: string, key: string, value: any): Promise<void> {
  await shellyRpc(ip, 'KVS.Set', { key, value });
}

async function scheduleSetFlag(ip: string, time: Date, shouldBeOn: boolean, utcOffset: number): Promise<void> {
  const ts = formatCronWithOffset(time, utcOffset);
  console.log(`Scheduling ${ip} to set should_be_on=${shouldBeOn} at ${time.toISOString()} (device: ${ts})`);
  await shellyRpc(ip, 'Schedule.Create', {
    enable: true,
    timespec: ts,
    calls: [{ method: 'KVS.Set', params: { key: 'should_be_on', value: shouldBeOn } }],
  });
}

async function scheduleSwitch(ip: string, switchId: number, time: Date, on: boolean, utcOffset: number): Promise<void> {
  const ts = formatCronWithOffset(time, utcOffset);
  console.log(`Scheduling switch ${switchId} on ${ip} to ${on ? 'ON' : 'OFF'} at ${time.toISOString()} (device: ${ts})`);
  await shellyRpc(ip, 'Schedule.Create', {
    enable: true,
    timespec: ts,
    calls: [{ method: 'Switch.Set', params: { id: switchId, on } }],
  });
}

/**
 * Shelly schedules use device local time. Query the UTC offset from a device,
 * cache it, and use it to convert UTC dates to device-local timespecs.
 */
let deviceUtcOffsetSeconds: number | null = null;

async function getDeviceUtcOffset(): Promise<number> {
  if (deviceUtcOffsetSeconds !== null) return deviceUtcOffsetSeconds;
  try {
    const status = await shellyRpc(config.small_sauna_heater_ip, 'Shelly.GetStatus');
    deviceUtcOffsetSeconds = status.sys?.utc_offset ?? -25200;
  } catch {
    deviceUtcOffsetSeconds = -25200; // default to UTC-7
  }
  return deviceUtcOffsetSeconds!;
}

function formatCronWithOffset(date: Date, utcOffsetSeconds: number): string {
  const local = new Date(date.getTime() + utcOffsetSeconds * 1000);
  const minutes = local.getUTCMinutes();
  const hours = local.getUTCHours();
  const day = local.getUTCDate();
  const month = local.getUTCMonth() + 1;
  return `0 ${minutes} ${hours} ${day} ${month} *`;
}

// --- Temperature monitoring script (deployed to device) ---

async function deployTemperatureMonitor(
  heaterIp: string,
  tempThresholdF: number
): Promise<void> {
  console.log(`Deploying temperature monitor to ${heaterIp}`);

  const hysteresisF = 5;
  const offAt = tempThresholdF;
  const onAt = tempThresholdF - hysteresisF;
  const lookaheadSeconds = 180;

  const script = `
// Temperature monitoring script — reads from addon sensor (temperature:100)
// Predictive control: estimates where temp will be in ${lookaheadSeconds}s based on rate of change,
// to compensate for thermal lag (~5min from heater mass continuing to radiate after shutoff).
// Hard limits: OFF at ${offAt}F, ON at ${onAt}F (unchanged safety bounds)
// Override KVS key: "on" = force on, "off" = force off, "none" = follow schedule
let TEMP_OFF = ${offAt};
let TEMP_ON = ${onAt};
let LOOKAHEAD_S = ${lookaheadSeconds};

let prevTempF = null;
let prevTimeS = null;

function checkTemperature() {
  Shelly.call("KVS.Get", { key: "override" }, function(ovr, oe) {
    let override = (oe === 0 && ovr) ? ovr.value : "none";

    Shelly.call("KVS.Get", { key: "should_be_on" }, function(result, error_code, error_message) {
      if (error_code !== 0) {
        print("Error getting should_be_on flag:", error_message);
        return;
      }

      let scheduleSaysOn = result.value || false;
      let shouldBeOn = override === "on" ? true : override === "off" ? false : scheduleSaysOn;

      let temp = Shelly.getComponentStatus("temperature", 100);
      if (!temp || typeof temp.tF === 'undefined') {
        print("No addon temperature sensor found");
        return;
      }

      let tempF = temp.tF;
      let nowS = Date.now() / 1000;

      // Predict future temperature based on rate of change
      let predictedF = tempF;
      if (prevTempF !== null && prevTimeS !== null) {
        let dtS = nowS - prevTimeS;
        if (dtS > 0) {
          let ratePerS = (tempF - prevTempF) / dtS;
          predictedF = tempF + ratePerS * LOOKAHEAD_S;
        }
      }
      prevTempF = tempF;
      prevTimeS = nowS;

      let sw = Shelly.getComponentStatus("switch", 0);
      let switchOn = sw ? sw.output : false;

      if (override === "off" && switchOn) {
        print("Override OFF - turning heater OFF");
        Shelly.call("Switch.Set", { id: 0, on: false });
      } else if (tempF >= TEMP_OFF && switchOn) {
        print("Temperature " + JSON.stringify(tempF) + "F >= " + JSON.stringify(TEMP_OFF) + "F - turning OFF (hard limit)");
        Shelly.call("Switch.Set", { id: 0, on: false });
      } else if (predictedF >= TEMP_OFF && switchOn) {
        print("Predicted " + JSON.stringify(predictedF) + "F >= " + JSON.stringify(TEMP_OFF) + "F (current " + JSON.stringify(tempF) + "F) - turning OFF early");
        Shelly.call("Switch.Set", { id: 0, on: false });
      } else if (tempF <= TEMP_ON && !switchOn && shouldBeOn) {
        print("Temperature " + JSON.stringify(tempF) + "F <= " + JSON.stringify(TEMP_ON) + "F - turning ON (hard limit)");
        Shelly.call("Switch.Set", { id: 0, on: true });
      } else if (predictedF <= TEMP_ON && !switchOn && shouldBeOn) {
        print("Predicted " + JSON.stringify(predictedF) + "F <= " + JSON.stringify(TEMP_ON) + "F (current " + JSON.stringify(tempF) + "F) - turning ON early");
        Shelly.call("Switch.Set", { id: 0, on: true });
      }
    });
  });
}

Timer.set(10000, true, checkTemperature);
`;

  // Ensure script slot exists
  const list = await shellyRpc(heaterIp, 'Script.List');
  const existing = list.scripts?.find((s: any) => s.id === 1);
  if (!existing) {
    await shellyRpc(heaterIp, 'Script.Create', { name: 'temp_monitor' });
  }

  try { await shellyRpc(heaterIp, 'Script.Stop', { id: 1 }); } catch { /* not running */ }

  await shellyRpc(heaterIp, 'Script.PutCode', { id: 1, code: script });
  await shellyRpc(heaterIp, 'Script.SetConfig', { id: 1, config: { enable: true } });
  await shellyRpc(heaterIp, 'Script.Start', { id: 1 });
}

// --- Merge bookings ---

function mergeBookings(bookings: Booking[]): Slot[] {
  if (bookings.length === 0) return [];

  const sorted = [...bookings].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Slot[] = [];
  let current = { start: sorted[0].start, stop: sorted[0].stop };

  for (let i = 1; i < sorted.length; i++) {
    const booking = sorted[i];
    if (booking.start <= current.stop) {
      current.stop = new Date(Math.max(current.stop.getTime(), booking.stop.getTime()));
    } else {
      merged.push(current);
      current = { start: booking.start, stop: booking.stop };
    }
  }
  merged.push(current);
  return merged;
}

// --- Clear + Apply ---

export async function clearAllSchedulesAndScripts(): Promise<void> {
  const devices = [
    { ip: config.small_sauna_heater_ip, name: 'Small Sauna Heater' },
    { ip: config.small_sauna_lights_fan_ip, name: 'Small Sauna Lights/Fan' },
    { ip: config.big_sauna_heater_ip, name: 'Big Sauna Heater' },
    { ip: config.big_sauna_lights_fan_ip, name: 'Big Sauna Lights/Fan' },
  ];

  for (const device of devices) {
    console.log(`Clearing ${device.name} (${device.ip})`);

    try { await clearSchedules(device.ip); }
    catch (e) { console.error(`  Failed to clear schedules:`, e); }

    try { await setKVS(device.ip, 'should_be_on', false); }
    catch { /* KVS key may not exist yet */ }

    try {
      const list = await shellyRpc(device.ip, 'Script.List');
      if (list.scripts?.some((s: any) => s.id === 1)) {
        try { await shellyRpc(device.ip, 'Script.Stop', { id: 1 }); } catch { /* not running */ }
        await shellyRpc(device.ip, 'Script.SetConfig', { id: 1, config: { enable: false } });
      }
    } catch { /* scripting may not be relevant for this device */ }
  }
}

export async function applyOperationalPlan(
  plan: OperationalPlan,
  bookings: Booking[]
): Promise<void> {
  console.log('Applying operational plan to Shelly devices...');

  // Store plan so the health monitor can check expected heater state
  currentPlan = plan;

  // Reset temp history since new plan may change expectations
  tempHistory.small = [];
  tempHistory.big = [];

  await clearAllSchedulesAndScripts();

  const utcOffset = await getDeviceUtcOffset();
  const smallBookings = bookings.filter(b => b.unitId === 1);
  const bigBookings = bookings.filter(b => b.unitId === 2);

  await applySaunaSchedule(
    config.small_sauna_heater_ip,
    config.small_sauna_lights_fan_ip,
    config.small_sauna_lights_switch_id ?? 0,
    config.small_sauna_fan_switch_id ?? 1,
    plan.small,
    smallBookings,
    'Small',
    utcOffset
  );

  await applySaunaSchedule(
    config.big_sauna_heater_ip,
    config.big_sauna_lights_fan_ip,
    config.big_sauna_lights_switch_id ?? 0,
    config.big_sauna_fan_switch_id ?? 1,
    plan.big,
    bigBookings,
    'Big',
    utcOffset
  );

  console.log('Operational plan applied successfully');
}

async function applySaunaSchedule(
  heaterIp: string,
  lightsFanIp: string,
  lightsSwitchId: number,
  fanSwitchId: number,
  heaterSlots: Slot[],
  bookings: Booking[],
  saunaName: string,
  utcOffset: number
): Promise<void> {
  console.log(`Applying ${saunaName} sauna schedule with ${heaterSlots.length} heater slots and ${bookings.length} bookings`);

  const now = new Date();

  // Determine current should_be_on state: true if we're inside any heater slot
  let shouldBeOnNow = false;
  for (const slot of heaterSlots) {
    if (now >= slot.start && now < slot.stop) {
      shouldBeOnNow = true;
      break;
    }
  }
  await setKVS(heaterIp, 'should_be_on', shouldBeOnNow);
  if (shouldBeOnNow) {
    console.log(`${saunaName} heater should_be_on set to true (currently inside a heating slot)`);
  }

  // Schedule future flag changes
  for (const slot of heaterSlots) {
    if (slot.start > now) {
      await scheduleSetFlag(heaterIp, slot.start, true, utcOffset);
    }
    if (slot.stop > now) {
      await scheduleSetFlag(heaterIp, slot.stop, false, utcOffset);
    }
  }

  await deployTemperatureMonitor(heaterIp, config.temperature_threshold);

  // Determine current lights/fan state and schedule future changes
  const mergedBookings = mergeBookings(bookings);

  let lightsOnNow = false;
  for (const period of mergedBookings) {
    if (now >= period.start && now < period.stop) {
      lightsOnNow = true;
      break;
    }
  }
  if (lightsOnNow) {
    console.log(`${saunaName} lights on now (currently inside a booking)`);
    await setSwitch(lightsFanIp, lightsSwitchId, true);
  }

  for (const period of mergedBookings) {
    if (period.start > now) {
      await scheduleSwitch(lightsFanIp, lightsSwitchId, period.start, true, utcOffset);
    }
    if (period.stop > now) {
      await scheduleSwitch(lightsFanIp, lightsSwitchId, period.stop, false, utcOffset);
    }
  }

  // Fan: on during bookings that overlap heater slots, off 30min after heater stops
  for (const heaterSlot of heaterSlots) {
    const overlappingBookings = bookings.filter(b =>
      b.start < heaterSlot.stop && b.stop > heaterSlot.start
    );

    if (overlappingBookings.length > 0) {
      const mergedOccupancy = mergeBookings(overlappingBookings);

      for (const period of mergedOccupancy) {
        if (now >= period.start && now < period.stop) {
          await setSwitch(lightsFanIp, fanSwitchId, true);
        } else if (period.start > now) {
          await scheduleSwitch(lightsFanIp, fanSwitchId, period.start, true, utcOffset);
        }
      }

      const fanOffTime = new Date(heaterSlot.stop.getTime() + 30 * 60 * 1000);
      if (fanOffTime > now) {
        await scheduleSwitch(lightsFanIp, fanSwitchId, fanOffTime, false, utcOffset);
      }
    }
  }
}

// --- Status + temperature monitoring ---

async function getHeaterStatus(ip: string): Promise<{ on: boolean; temperatureF: number | null }> {
  try {
    const status = await shellyRpc(ip, 'Shelly.GetStatus');
    return {
      on: status['switch:0']?.output ?? false,
      temperatureF: status['temperature:100']?.tF ?? null,
    };
  } catch {
    return { on: false, temperatureF: null };
  }
}

function checkOverheatFromStatus(name: string, ip: string, temperatureF: number | null): void {
  if (temperatureF == null) return;

  const dedupKey = `sauna-overheat-${name.toLowerCase()}`;
  const threshold = config.temperature_threshold;
  const alertTemp = threshold + OVERHEAT_MARGIN_F;

  if (temperatureF >= alertTemp) {
    if (!activeDeviceIncidents.has(dedupKey)) {
      const summary = `${name} sauna temperature ${temperatureF}°F exceeds safe limit (${threshold}°F + ${OVERHEAT_MARGIN_F}°F margin)`;
      console.error(summary);
      activeDeviceIncidents.set(dedupKey, dedupKey);
      triggerIncident(summary, 'critical', dedupKey, {
        sauna: name,
        ip,
        temperatureF,
        threshold,
        alertThreshold: alertTemp,
      }).catch(e => console.error('Failed to trigger overheat PagerDuty incident:', e));
    }
  } else if (activeDeviceIncidents.has(dedupKey)) {
    activeDeviceIncidents.delete(dedupKey);
    console.log(`${name} sauna temperature back to ${temperatureF}°F — overheat incident resolved`);
    resolveIncident(dedupKey)
      .catch(e => console.error('Failed to resolve overheat PagerDuty incident:', e));
  }
}

// --- Threshold-based alerting helpers ---

/**
 * Bump a failure counter and trigger a PagerDuty incident when it crosses the threshold.
 * Only fires on the exact threshold crossing to avoid spamming.
 */
async function alertIfThreshold(
  key: string,
  summary: string,
  severity: 'critical' | 'error' | 'warning' | 'info',
  dedupKey: string,
  threshold = ALERT_THRESHOLD_CYCLES,
): Promise<void> {
  const count = (failCounts.get(key) || 0) + 1;
  failCounts.set(key, count);

  if (count === threshold) {
    try {
      await triggerIncident(summary, severity, dedupKey);
      activeDeviceIncidents.set(dedupKey, dedupKey);
      console.error(`[monitor] ALERT: ${summary}`);
    } catch (e) {
      console.error(`[monitor] Failed to trigger PagerDuty:`, e);
    }
  }
}

/**
 * Clear a failure counter and auto-resolve the PagerDuty incident if one was fired.
 */
async function resolveIfClear(key: string, dedupKey: string): Promise<void> {
  const count = failCounts.get(key) || 0;
  failCounts.delete(key);

  if (count >= ALERT_THRESHOLD_CYCLES && activeDeviceIncidents.has(dedupKey)) {
    try {
      await resolveIncident(dedupKey);
      activeDeviceIncidents.delete(dedupKey);
      console.log(`[monitor] Resolved: ${dedupKey}`);
    } catch (e) {
      console.error(`[monitor] Failed to resolve PagerDuty:`, e);
    }
  }
}

/**
 * Check whether a sauna's heater should currently be on (warming up or holding hot)
 * based on the operational plan. Plan slots cover the full period from heater-on to heater-off.
 */
function saunaHeaterShouldBeOn(slots: Slot[]): boolean {
  if (!slots.length) return false;
  const now = Date.now();
  for (const slot of slots) {
    if (now >= slot.start.getTime() && now < slot.stop.getTime()) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether a sauna should be HOT right now — i.e. we're past the warmup
 * period within a plan slot.
 */
function saunaShouldBeHot(slots: Slot[]): boolean {
  if (!slots.length) return false;
  const now = Date.now();
  const warmupMs = WARMUP_TIME_MINUTES * 60 * 1000;
  for (const slot of slots) {
    const hotStart = slot.start.getTime() + warmupMs;
    if (now >= hotStart && now < slot.stop.getTime()) {
      return true;
    }
  }
  return false;
}

/**
 * Record a temperature reading and check whether temperature is rising.
 * Returns true if we have enough history and the sauna has warmed by at
 * least TEMP_RISE_MIN_F over the last TEMP_RISE_WINDOW_MS.
 * Returns null if we don't have enough data yet.
 */
function recordTempAndCheckRising(sauna: string, temperatureF: number): boolean | null {
  const now = Date.now();
  const history = tempHistory[sauna];
  history.push({ temperatureF, timestamp: now });

  // Prune entries older than the window
  const cutoff = now - TEMP_RISE_WINDOW_MS;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }

  // Need at least the window's worth of data
  if (history.length < 2 || (now - history[0].timestamp) < TEMP_RISE_WINDOW_MS * 0.8) {
    return null; // Not enough data yet
  }

  const oldest = history[0];
  const rise = temperatureF - oldest.temperatureF;
  return rise >= TEMP_RISE_MIN_F;
}

/**
 * Run health checks for a single sauna after status is fetched.
 */
function checkSaunaHealth(
  name: 'Small' | 'Big',
  status: { on: boolean; temperatureF: number | null; reachable: boolean },
  planSlots: Slot[],
): void {
  const id = name.toLowerCase();

  // 1. Device unreachable
  if (!status.reachable) {
    alertIfThreshold(
      `unreachable-${id}`,
      `${name} sauna Shelly device is unreachable`,
      'critical',
      `sauna-unreachable-${id}`,
    );
  } else {
    resolveIfClear(`unreachable-${id}`, `sauna-unreachable-${id}`);
  }

  // 2. No temperature reading (device reachable but sensor gives null)
  if (status.reachable && status.temperatureF === null) {
    alertIfThreshold(
      `no-temp-${id}`,
      `${name} sauna has no temperature reading (sensor may be disconnected)`,
      'error',
      `sauna-no-temp-${id}`,
    );
  } else {
    resolveIfClear(`no-temp-${id}`, `sauna-no-temp-${id}`);
  }

  // 3. Heater should be on (warming up or hot) but temperature isn't rising
  const shouldBeOn = saunaHeaterShouldBeOn(planSlots);
  if (shouldBeOn && status.reachable && status.temperatureF !== null) {
    // Already at target — no problem
    if (status.temperatureF >= config.temperature_threshold - OVERHEAT_MARGIN_F) {
      resolveIfClear(`not-heating-${id}`, `sauna-not-heating-${id}`);
    } else {
      const rising = recordTempAndCheckRising(id, status.temperatureF);
      if (rising === false) {
        // We have enough data and temp is NOT rising
        alertIfThreshold(
          `not-heating-${id}`,
          `${name} sauna should be heating but temperature is not rising (${status.temperatureF}°F, target ${config.temperature_threshold}°F)`,
          'error',
          `sauna-not-heating-${id}`,
        );
      } else {
        // Either rising or not enough data yet — clear any prior alert
        resolveIfClear(`not-heating-${id}`, `sauna-not-heating-${id}`);
      }
    }
  } else {
    resolveIfClear(`not-heating-${id}`, `sauna-not-heating-${id}`);
  }

  // 4. Should be hot (past warmup) but significantly under target temperature
  const shouldBeHot = saunaShouldBeHot(planSlots);
  if (shouldBeHot && status.reachable && status.temperatureF !== null &&
      status.temperatureF < config.temperature_threshold - NOT_HOT_TOLERANCE_F) {
    alertIfThreshold(
      `not-hot-${id}`,
      `${name} sauna should be hot but is only ${status.temperatureF}°F (target ${config.temperature_threshold}°F)`,
      'critical',
      `sauna-not-hot-${id}`,
    );
  } else {
    resolveIfClear(`not-hot-${id}`, `sauna-not-hot-${id}`);
  }
}

export async function getAllSaunaStatus(): Promise<{
  small: { on: boolean; temperatureF: number | null; reachable: boolean };
  big: { on: boolean; temperatureF: number | null; reachable: boolean };
}> {
  const [small, big] = await Promise.all([
    getHeaterStatus(config.small_sauna_heater_ip)
      .then(s => ({ ...s, reachable: true }))
      .catch(() => ({ on: false, temperatureF: null, reachable: false })),
    getHeaterStatus(config.big_sauna_heater_ip)
      .then(s => ({ ...s, reachable: true }))
      .catch(() => ({ on: false, temperatureF: null, reachable: false })),
  ]);

  checkOverheatFromStatus('Small', config.small_sauna_heater_ip, small.temperatureF);
  checkOverheatFromStatus('Big', config.big_sauna_heater_ip, big.temperatureF);

  checkSaunaHealth('Small', small, currentPlan?.small ?? []);
  checkSaunaHealth('Big', big, currentPlan?.big ?? []);

  return { small, big };
}

async function reportStatusToServer(status: {
  small: { on: boolean; temperatureF: number | null; reachable: boolean };
  big: { on: boolean; temperatureF: number | null; reachable: boolean };
}): Promise<void> {
  if (!config.sauna_server_url || !config.daemon_secret) return;

  try {
    await fetch(`${config.sauna_server_url}/api/daemon/sauna-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.daemon_secret}`,
      },
      body: JSON.stringify(status),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('Failed to report sauna status to server:', e);
  }
}

let tempMonitorInterval: ReturnType<typeof setInterval> | null = null;

export function startTemperatureMonitor(): void {
  if (tempMonitorInterval) return;
  const alertTemp = config.temperature_threshold + OVERHEAT_MARGIN_F;
  console.log(`Starting temperature monitor (every ${TEMP_CHECK_INTERVAL_MS / 1000}s, alert at ${alertTemp}°F)`);
  tempMonitorInterval = setInterval(async () => {
    const status = await getAllSaunaStatus();
    await reportStatusToServer(status);
  }, TEMP_CHECK_INTERVAL_MS);
}

export function stopTemperatureMonitor(): void {
  if (tempMonitorInterval) {
    clearInterval(tempMonitorInterval);
    tempMonitorInterval = null;
  }
}

export async function deployTemperatureMonitors(): Promise<void> {
  console.log('Deploying temperature monitor scripts to all heaters...');
  await deployTemperatureMonitor(config.small_sauna_heater_ip, config.temperature_threshold);
  await deployTemperatureMonitor(config.big_sauna_heater_ip, config.temperature_threshold);
  console.log('Temperature monitor scripts deployed');
}

export async function setSaunaOverride(sauna: 'small' | 'big', override: 'on' | 'off' | 'none'): Promise<void> {
  const heaterIp = sauna === 'small' ? config.small_sauna_heater_ip : config.big_sauna_heater_ip;
  console.log(`Setting override=${override} on ${sauna} sauna (${heaterIp})`);
  await setKVS(heaterIp, 'override', override);

  // When clearing an override, sync should_be_on with the current plan
  // so the device doesn't keep running on a stale flag
  if (override === 'none') {
    const slots = sauna === 'small' ? currentPlan?.small : currentPlan?.big;
    const shouldBeOnNow = saunaHeaterShouldBeOn(slots ?? []);
    console.log(`Syncing should_be_on=${shouldBeOnNow} on ${sauna} sauna after clearing override`);
    await setKVS(heaterIp, 'should_be_on', shouldBeOnNow);
  }
}

export async function manualControl(
  device: 'small_heater' | 'small_lights' | 'small_fan' | 'big_heater' | 'big_lights' | 'big_fan',
  on: boolean
): Promise<void> {
  const deviceMap = {
    small_heater: { ip: config.small_sauna_heater_ip, switchId: 0 },
    small_lights: { ip: config.small_sauna_lights_fan_ip, switchId: config.small_sauna_lights_switch_id ?? 0 },
    small_fan: { ip: config.small_sauna_lights_fan_ip, switchId: config.small_sauna_fan_switch_id ?? 1 },
    big_heater: { ip: config.big_sauna_heater_ip, switchId: 0 },
    big_lights: { ip: config.big_sauna_lights_fan_ip, switchId: config.big_sauna_lights_switch_id ?? 0 },
    big_fan: { ip: config.big_sauna_lights_fan_ip, switchId: config.big_sauna_fan_switch_id ?? 1 },
  };

  const { ip, switchId } = deviceMap[device];
  await setSwitch(ip, switchId, on);
}
