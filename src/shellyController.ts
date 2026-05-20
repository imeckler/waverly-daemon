import * as fs from 'fs';
import * as crypto from 'crypto';
import { triggerIncident, resolveIncident } from './pagerduty.js';

const RPC_TIMEOUT_MS = 10_000;
const SWITCH_MAX_RETRIES = 3;
const SWITCH_RETRY_DELAY_MS = 2_000;
const TEMP_CHECK_INTERVAL_MS = 30_000;
const MANUAL_RESET_CHECK_INTERVAL_MS = 60_000;
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

// Hardware backstop: Shelly opens its own relay after this many seconds of
// continuous on, even if the script is dead. Must exceed the script's own
// 60-min duty-cycle limit so normal operation never trips it.
const HEATER_AUTO_OFF_DELAY_S = 3700;

// Power-metering thresholds. Shelly switches the contactor coil (a few watts),
// NOT the heater element (kW). So thresholds are coil-scale.
// Welded Shelly relay: commanded OFF but coil still drawing power → relay didn't open.
// Coil broken: commanded ON but ~0W → coil open, broken wiring, or low supply voltage.
const COIL_BROKEN_POWER_THRESHOLD_W = 0.1;

// Sensor-stuck check: if temp moves less than this much over the window while
// the heater should be running, the sensor is probably disconnected.
const TEMP_STUCK_WINDOW_MS = 3 * 60 * 1000;
const TEMP_STUCK_EPSILON_F = 0.5;

// Track consecutive failure counts for threshold-based alerts.
// Incident state itself lives in PagerDuty (dedup_key) — we send trigger/resolve
// every cycle and let PagerDuty handle deduplication and reopening.
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
  try {
    await resolveIncident(dedupKey);
  } catch (e) {
    console.error(`Failed to resolve PagerDuty incident ${dedupKey}:`, e);
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

  // Hardware-level safety on switch 0:
  // - initial_state OFF so brownouts / power cycles open the relay
  // - auto_off + delay so the relay opens after HEATER_AUTO_OFF_DELAY_S of continuous on,
  //   even if the script is wedged or crashed.
  // If we can't apply this config, abort: we won't run a heater without the hardware backstop.
  await shellyRpc(heaterIp, 'Switch.SetConfig', {
    id: 0,
    config: {
      initial_state: 'off',
      auto_off: true,
      auto_off_delay: HEATER_AUTO_OFF_DELAY_S,
    },
  });

  const hysteresisF = 5;
  const offAt = tempThresholdF;
  const onAt = tempThresholdF - hysteresisF;
  const lookaheadSeconds = 180;
  // Clock sanity floor: deploy time minus 10s margin for clock skew.
  // The device clock cannot legitimately be older than the moment we wrote the script.
  const clockMinSaneS = Math.floor(Date.now() / 1000) - 10;

  const script = `
// Temperature monitoring script — reads from addon sensor (temperature:100)
// Predictive control: estimates where temp will be in ${lookaheadSeconds}s based on rate of change,
// to compensate for thermal lag (~5min from heater mass continuing to radiate after shutoff).
// Hard limits: OFF at ${offAt}F, ON at ${onAt}F (unchanged safety bounds)
// Override KVS key: "on" = force on, "off" = force off, "none" = follow schedule
let TEMP_OFF = ${offAt};
let TEMP_ON = ${onAt};
let LOOKAHEAD_S = ${lookaheadSeconds};
let OVERHEAT_TEMP_F = ${tempThresholdF + OVERHEAT_MARGIN_F};

// Sanity bound: if Date.now()/1000 is less than this, NTP hasn't synced.
// Time-based comparisons (offUntil, duty cycle, heartbeat) would be unsafe.
// Templated from the daemon's clock at deploy time (minus 10s margin for skew).
let CLOCK_MIN_SANE_S = ${clockMinSaneS};

// Daemon POSTs to the heartbeat HTTP endpoint every monitor cycle (~30s) to update
// lastHeartbeatMs in memory. Using HTTP instead of KVS avoids wearing out the flash
// (KVS writes are flash-backed; 2880 writes/day would burn through endurance).
// If lastHeartbeatMs falls behind by this much, the daemon is dead — turn off (no lockout).
let HEARTBEAT_STALE_S = 5 * 60;
let lastHeartbeatMs = 0;

let farFuture = 8640000000000000;

let prevTempF = null;
let prevTimeS = null;

let thermostatTimer = null;

// A ring buffer is an object { arr: ArrayBuffer, start: number, length: number }
function emptyRingBuffer(capacity) {
  let arr = new Uint32Array(capacity);
  for (let i = 0; i < capacity; ++i) {
    arr[i] = null;
  }

  return { arr: arr, start: 0, length: 0 };
}

function pushRingBuffer(buf, x) {
  if (buf.length < buf.arr.length) {
    let i = (buf.start + buf.length) % buf.arr.length;
    buf.arr[i] = x;
    buf.length += 1;
    return true;
  } 
  return false;
}

function popFrontRingBuffer(buf) {
  if (buf.length > 0) {
    let x = buf.arr[buf.start];
    buf.start = (buf.start + 1) % buf.arr.length;
    buf.length -= 1;
    return x;
  } else {
    return undefined;
  }
}

function setRingBuffer(buf, i, x) {
  if (i < buf.length) {
    buf.arr[(buf.start + i) % buf.arr.length] = x;
    return true;
  } else {
    return undefined;
  }
}

function getRingBuffer(buf, i) {
  if (i < buf.length) {
    return buf.arr[(buf.start + i) % buf.arr.length];
  } else {
    return undefined;
  }
}

// We make sure the heater is never on for more than one hour at a time, and if it is we disable it until it is
// manually overriden. This events array is for keeping track of the on-time.
// A flat array of numbers, corresponding to when the switch is switched on or off
// Invariant:
// The first element is the first "on" time. Each on is followed by the corresponding "off" time
// Even length <=> currently off
// Odd length <=> currently on
let events = emptyRingBuffer(1000);
let totalTimeOnForCompleteIntervals = 0;

function markTemporaryShutoff(untilS) {
  Shelly.call("KVS.Set", { key: "offUntil", value: untilS.toString() });
}

function markManualResetRequired() {
  Shelly.call("KVS.Set", { key: "manualResetRequired", value: "true" });
}

function switchOff(nowS) {
  // Always issue the Switch.Set — cheap, harmless if already off, and the safer
  // posture in the case where hardware/log have desynced.
  Shelly.call("Switch.Set", { id: 0, on: false });

  // Idempotent on log state: if we're already in an "off" interval per the events log
  // (even length), this is a redundant call from heartbeat/wifi-grace/etc. Don't
  // record a duplicate off — that would corrupt duty-cycle accounting.
  if (events.length % 2 === 1) {
    if (!pushRingBuffer(events, nowS)) {
      switchOffUntilManualReset(nowS, 'ring buffer overflow (switchOff)');
    }
  }
}

function switchOffUntilManualReset(nowS, reason) {
  switchOff(nowS);
  Shelly.call("KVS.Set", { key: "manualResetReason", value: reason });
  markManualResetRequired();
}

function trimTimeLog(nowS) {
  let toDrop = 0;
  let completeIntervals = (events.length - (events.length % 2)) / 2;
  let lookbackCutoffTime = nowS - 70*60;

  for (let i = 0; i < completeIntervals; ++i)  {
    let onTime = getRingBuffer(events, 2*i);
    let offTime = getRingBuffer(events, 2*i + 1);

    if (onTime > offTime) {
      switchOffUntilManualReset(nowS, 'invalid events array');
      return;
    }

    // on ---- off ---- now

    if (offTime < lookbackCutoffTime) {
      // on <= off < lookbackCutoff < now
      toDrop++;
      continue;
    } else if (onTime < lookbackCutoffTime) {
      // on < lookbackCutoff <= off < now
      //
      // bump the interval
      setRingBuffer(events, 2*i, lookbackCutoffTime);
      totalTimeOnForCompleteIntervals -= (lookbackCutoffTime - onTime);
    } else {
      // lookbackCutoff <= on <= off < now
      break;
    }
  }

  for (let i = 0; i < toDrop; ++i) {
    let onTime = popFrontRingBuffer(events);
    let offTime = popFrontRingBuffer(events);
    totalTimeOnForCompleteIntervals -= (offTime - onTime);
  }
}

 /* nowS: current time in seconds */
function switchOn(currentlyOn, nowS) {
  if (!currentlyOn) {
    Shelly.call("Switch.Set", { id: 0, on: true });
    if (!pushRingBuffer(events, nowS)) {
      switchOffUntilManualReset(nowS, 'ring buffer overflow (switchOn)');
    }
  }
}

// If the heater is ever on for more than 60 out of 70 minutes, there is a problem.

function checkTemperatureManualResetWrapper(resetRequiredRes, resetRequiredErr, resetRequiredErrMsg) {
  if (resetRequiredErr != 0 || (resetRequiredRes.value !== "false" && resetRequiredRes.value !== false)) {
    Shelly.call("Switch.Set", { id: 0, on: false });
    return;
  }

  Shelly.call("KVS.Get", { key: "offUntil" }, checkTemperatureOffUntilWrapper);
}


function isNumeric(str) {
  if (typeof str != "string") return false // we only process strings!  
  return !isNaN(str) && !isNaN(parseFloat(str));
}

function checkTemperatureOffUntilWrapper(offUntilRes, offUntilErr, offUntilErrMsg) {
  let nowS = Math.floor(Date.now() / 1000);

  // Clock sanity — every time-based check below assumes nowS is real.
  // If the clock is older than the deploy time, NTP hasn't synced yet.
  if (nowS < CLOCK_MIN_SANE_S) {
    print("Clock unset / NTP not synced (nowS=" + JSON.stringify(nowS) + ") — locking heater off");
    switchOffUntilManualReset(nowS, 'device clock unset / NTP not synced');
    return;
  }

  if (offUntilErr == 0 && typeof offUntilRes.value == 'string') {
    if (isNumeric(offUntilRes.value)) {
      let offUntil = Number(offUntilRes.value);
      if (nowS < offUntil) {
        Shelly.call("Switch.Set", { id: 0, on: false });
        return;
      } else {
        checkTemperatureHeartbeatWrapper(nowS);
        return;
      }
    } else {
      // Something is funky
      Shelly.call("Switch.Set", { id: 0, on: false });
      return;
    }
  } else {
    checkTemperatureHeartbeatWrapper(nowS);
    return;
  }
}

function checkTemperatureHeartbeatWrapper(nowS) {
  // Heartbeat lives in RAM (updated by the HTTP endpoint registered below) — no flash wear.
  // lastHeartbeatMs starts at 0; first daemon ping will set it. Until then we treat as stale.
  let staleS = nowS - (lastHeartbeatMs / 1000);
  if (staleS > HEARTBEAT_STALE_S) {
    print("Daemon heartbeat stale (" + JSON.stringify(staleS) + "s) — turning heater OFF (no lockout)");
    switchOff(nowS);
    return;
  }
  checkTemperatureInner(nowS);
}

function heartbeatEndpoint(request, response) {
  lastHeartbeatMs = Date.now();
  response.code = 200;
  response.send();
}
HTTPServer.registerEndpoint("heartbeat", heartbeatEndpoint);

function checkTemperatureInner(nowS) {
  let temp = Shelly.getComponentStatus("temperature", 100);
  // Catches missing component, missing/null/undefined tF, and NaN (typeof NaN === 'number' but NaN !== NaN).
  if (!temp || typeof temp.tF !== 'number' || temp.tF !== temp.tF) {
    print("No usable addon temperature reading");
    switchOffUntilManualReset(nowS, 'no usable temperature reading');
    return;
  }

  let tempF = temp.tF;

  if (tempF > OVERHEAT_TEMP_F) {
    switchOffUntilManualReset(nowS, 'temp exceeded overheat temp');
    return;
  }

  trimTimeLog(nowS);
  let totalTimeOn = totalTimeOnForCompleteIntervals;
  if ((events.length % 2) !== 0) {
    totalTimeOn += nowS - getRingBuffer(events, events.length - 1);
  }

  if (totalTimeOn > 3600) {
    // heater has been on for more than 1 hour in the last 70 minutes. something is wrong.
    let s = "Heater on " + JSON.stringify(totalTimeOn) + "s in last 70min - manual reset required";
    switchOffUntilManualReset(nowS, s);
    return;
  }

  Shelly.call("KVS.Get", { key: "override" }, function(ovr, oe) {
    let override = (oe === 0 && ovr) ? ovr.value : "none";
    Shelly.call("KVS.Get", { key: "should_be_on" }, function(result, error_code, error_message) {
      if (error_code !== 0) {
        print("Error getting should_be_on flag:", error_message);
        switchOff(nowS);
        return;
      }

      let scheduleSaysOn = result.value || false;
      let shouldBeOn = override === "on" ? true : override === "off" ? false : scheduleSaysOn;

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
      let switchIsOn = sw ? sw.output : false;
      if ((!switchIsOn || (events.length % 2 == 0)) && sw && typeof sw.apower == 'number' && sw.apower > 0) {
        // We or the switch thinks it's off but there is power going through it
        switchOffUntilManualReset(nowS, 'off switch has power');
        return;
      }

      if (override === "off" && switchIsOn) {
        print("Override OFF - turning heater OFF");
        switchOff(nowS);
      } else if (!shouldBeOn && override !== "on" && switchIsOn) {
        print("Schedule says off and override is not ON - turning heater OFF");
        switchOff(nowS);
      } else if (tempF >= TEMP_OFF && switchIsOn) {
        print("Temperature " + JSON.stringify(tempF) + "F >= " + JSON.stringify(TEMP_OFF) + "F - turning OFF (hard limit)");
        switchOff(nowS);
      } else if (predictedF >= TEMP_OFF && switchIsOn) {
        print("Predicted " + JSON.stringify(predictedF) + "F >= " + JSON.stringify(TEMP_OFF) + "F (current " + JSON.stringify(tempF) + "F) - turning OFF early");
        switchOff(nowS);
      } else if (tempF <= TEMP_ON && !switchIsOn && shouldBeOn) {
        print("Temperature " + JSON.stringify(tempF) + "F <= " + JSON.stringify(TEMP_ON) + "F - turning ON (hard limit)");
        switchOn(switchIsOn, nowS);
      } else if (predictedF <= TEMP_ON && !switchIsOn && shouldBeOn) {
        print("Predicted " + JSON.stringify(predictedF) + "F <= " + JSON.stringify(TEMP_ON) + "F (current " + JSON.stringify(tempF) + "F) - turning ON early");
        switchOn(switchIsOn, nowS);
      }
    });
  });
}

function checkTemperature() {
  Shelly.call("KVS.Get", { key: "manualResetRequired" }, checkTemperatureManualResetWrapper);
}

let WIFI_GRACE_S = 600;
let wifiKillTimer = null;

Shelly.addStatusHandler(function(notification) {
  if (notification.component !== "wifi") return;

  let s = notification.delta.status;
  if (s === "disconnected" || s === "connecting") {
    if (wifiKillTimer === null) {
      wifiKillTimer = Timer.set(WIFI_GRACE_S * 1000, false, function() {
        print("WiFi down >" + WIFI_GRACE_S + "s — locking heater off");
        // Reuse your existing safety path
        let nowS = Math.floor(Date.now() / 1000);
        switchOffUntilManualReset(nowS, 'wifi down for over 10 minutes');
        wifiKillTimer = null;
      });
    }
  } else if (s === "got ip") {
    if (wifiKillTimer !== null) {
      Timer.clear(wifiKillTimer);
      wifiKillTimer = null;
    }
  }
});

function startupTimerInit() {
  thermostatTimer = Timer.set(10000, true, checkTemperature);
}

// Config sanity check on startup: if temperature limits got templated in as anything
// other than ordered finite numbers, refuse to run and require manual reset.
if (typeof TEMP_OFF !== 'number' || typeof TEMP_ON !== 'number'
    || typeof OVERHEAT_TEMP_F !== 'number' || typeof CLOCK_MIN_SANE_S !== 'number'
    || TEMP_OFF !== TEMP_OFF || TEMP_ON !== TEMP_ON || OVERHEAT_TEMP_F !== OVERHEAT_TEMP_F
    || TEMP_OFF <= TEMP_ON || TEMP_OFF > OVERHEAT_TEMP_F) {
  print("Invalid temperature config (TEMP_OFF=" + JSON.stringify(TEMP_OFF)
    + ", TEMP_ON=" + JSON.stringify(TEMP_ON)
    + ", OVERHEAT_TEMP_F=" + JSON.stringify(OVERHEAT_TEMP_F)
    + ") — refusing to start thermostat");
  Shelly.call("Switch.Set", { id: 0, on: false });
  Shelly.call("KVS.Set", { key: "manualResetRequired", value: "true" });
  // Timer is intentionally not started.
} else {
  Shelly.call("KVS.Set", { key: "manualResetRequired", value: "false" }, startupTimerInit);
}
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

  // Bootstrap the heartbeat — the endpoint isn't registered until after Script.Start runs.
  // First cycle (~10s later) will then see a fresh lastHeartbeatMs.
  await pingHeartbeat(heaterIp).catch(e =>
    console.error(`Initial heartbeat ping to ${heaterIp} failed:`, e)
  );
}

async function pingHeartbeat(ip: string): Promise<void> {
  // Hits the script-registered endpoint at /script/1/heartbeat (script id is always 1 here).
  // The script handler just sets lastHeartbeatMs = Date.now() in RAM; no flash writes.
  // Method must be GET: on Gen4 firmware 1.5.99, POST to a script-registered endpoint
  // RSTs the connection from any Node client (verified with fetch/undici, node:http,
  // and raw sockets). GET returns properly (200 or 401). Auth may or may not be required
  // depending on device state, so do the digest dance on 401.
  const uri = '/script/1/heartbeat';
  const url = `http://${ip}${uri}`;
  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (response.status !== 401) {
    if (!response.ok) {
      throw new Error(`Heartbeat ping failed: ${response.status} ${response.statusText}`);
    }
    return;
  }
  const wwwAuth = response.headers.get('www-authenticate');
  if (!wwwAuth) {
    throw new Error('Heartbeat ping returned 401 but no WWW-Authenticate header');
  }
  const challenge = parseDigestChallenge(wwwAuth);
  const authorization = buildDigestAuth('admin', config.password, 'GET', uri, challenge, 1);
  const authResponse = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': authorization },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!authResponse.ok) {
    throw new Error(`Heartbeat ping (authed) failed: ${authResponse.status} ${authResponse.statusText}`);
  }
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
    { ip: config.small_sauna_heater_ip, name: 'Small Sauna Heater', isHeater: true },
    { ip: config.small_sauna_lights_fan_ip, name: 'Small Sauna Lights/Fan', isHeater: false },
    { ip: config.big_sauna_heater_ip, name: 'Big Sauna Heater', isHeater: true },
    { ip: config.big_sauna_lights_fan_ip, name: 'Big Sauna Lights/Fan', isHeater: false },
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

    // Heater contract: relay must be OFF before the temperature monitor script (re)starts,
    // so its events-log invariant holds. Do this after stopping the script so it can't fight us.
    if (device.isHeater) {
      await setSwitch(device.ip, 0, false);
    }
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

  // Per-sauna isolation: one sauna being unreachable must not strand the other's deploy.
  let smallOk = false;
  let bigOk = false;

  try {
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
    smallOk = true;
  } catch (e) {
    console.error('Failed to apply Small sauna schedule:', e);
  }

  try {
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
    bigOk = true;
  } catch (e) {
    console.error('Failed to apply Big sauna schedule:', e);
  }

  if (smallOk && bigOk) {
    console.log('Operational plan applied successfully');
  } else if (!smallOk && !bigOk) {
    console.error('Operational plan failed for both saunas');
  } else {
    console.error(`Operational plan applied to ${smallOk ? 'Small' : 'Big'} only; ${smallOk ? 'Big' : 'Small'} failed`);
  }
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

async function getHeaterStatus(ip: string): Promise<{ on: boolean; temperatureF: number | null; powerW: number | null }> {
  try {
    const status = await shellyRpc(ip, 'Shelly.GetStatus');
    const apower = status['switch:0']?.apower;
    return {
      on: status['switch:0']?.output ?? false,
      temperatureF: status['temperature:100']?.tF ?? null,
      powerW: typeof apower === 'number' ? apower : null,
    };
  } catch {
    return { on: false, temperatureF: null, powerW: null };
  }
}

function checkOverheatFromStatus(name: string, ip: string, temperatureF: number | null): void {
  if (temperatureF == null) return;

  const dedupKey = `sauna-overheat-${name.toLowerCase()}`;
  const threshold = config.temperature_threshold;
  const alertTemp = threshold + OVERHEAT_MARGIN_F;

  if (temperatureF >= alertTemp) {
    const summary = `${name} sauna temperature ${temperatureF}°F exceeds safe limit (${threshold}°F + ${OVERHEAT_MARGIN_F}°F margin)`;
    console.error(summary);
    triggerIncident(summary, 'critical', dedupKey, {
      sauna: name,
      ip,
      temperatureF,
      threshold,
      alertThreshold: alertTemp,
    }).catch(e => console.error('Failed to trigger overheat PagerDuty incident:', e));
  } else {
    resolveIncident(dedupKey)
      .catch(e => console.error('Failed to resolve overheat PagerDuty incident:', e));
  }
}

// --- Threshold-based alerting helpers ---

/**
 * Bump a failure counter. Once it crosses the threshold, send a trigger every cycle —
 * PagerDuty dedupes by dedup_key, so this is cheap. If someone resolves the incident
 * out-of-band while the condition still holds, the next trigger reopens it.
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

  if (count >= threshold) {
    if (count === threshold) {
      console.error(`[monitor] ALERT: ${summary}`);
    }
    try {
      await triggerIncident(summary, severity, dedupKey);
    } catch (e) {
      console.error(`[monitor] Failed to trigger PagerDuty:`, e);
    }
  }
}

/**
 * Clear the failure counter and send a resolve to PagerDuty. Resolve is idempotent;
 * if no incident is open under this dedup_key, PagerDuty no-ops.
 */
async function resolveIfClear(key: string, dedupKey: string): Promise<void> {
  failCounts.delete(key);
  try {
    await resolveIncident(dedupKey);
  } catch (e) {
    console.error(`[monitor] Failed to resolve PagerDuty:`, e);
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
 * Push a reading into the rolling temperature history and prune anything outside
 * the longest window we use. Callers query via checkTempRising / checkTempStuck.
 */
function recordTemp(sauna: string, temperatureF: number): void {
  const now = Date.now();
  const history = tempHistory[sauna];
  history.push({ temperatureF, timestamp: now });

  const cutoff = now - TEMP_RISE_WINDOW_MS;
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift();
  }
}

/**
 * True if the sauna has warmed by at least TEMP_RISE_MIN_F over the rise window.
 * Null if we don't have enough data yet.
 */
function checkTempRising(sauna: string): boolean | null {
  const history = tempHistory[sauna];
  if (history.length < 2) return null;
  const now = Date.now();
  if ((now - history[0].timestamp) < TEMP_RISE_WINDOW_MS * 0.8) return null;
  const rise = history[history.length - 1].temperatureF - history[0].temperatureF;
  return rise >= TEMP_RISE_MIN_F;
}

/**
 * True if temperature has barely moved (max-min < epsilon) over the stuck window.
 * Distinct from "not rising" — catches a sensor that reports plausible but static values.
 * Null if we don't have enough data yet.
 */
function checkTempStuck(sauna: string): boolean | null {
  const history = tempHistory[sauna];
  if (history.length < 2) return null;
  const now = Date.now();
  const windowStart = now - TEMP_STUCK_WINDOW_MS;
  const inWindow = history.filter(h => h.timestamp >= windowStart);
  if (inWindow.length < 2) return null;
  if ((now - inWindow[0].timestamp) < TEMP_STUCK_WINDOW_MS * 0.8) return null;
  let min = inWindow[0].temperatureF;
  let max = min;
  for (const h of inWindow) {
    if (h.temperatureF < min) min = h.temperatureF;
    if (h.temperatureF > max) max = h.temperatureF;
  }
  return (max - min) < TEMP_STUCK_EPSILON_F;
}

/**
 * Bump a failure counter and trigger PagerDuty once it crosses the threshold.
 * Unlike alertIfThreshold + resolveIfClear, this NEVER auto-resolves — the incident
 * stays open in PagerDuty until a human acks it. Used for failure modes where
 * "condition cleared by itself" still warrants investigation (welded relay etc).
 */
async function alertIfThresholdManualOnly(
  key: string,
  summary: string,
  severity: 'critical' | 'error' | 'warning' | 'info',
  dedupKey: string,
  threshold = ALERT_THRESHOLD_CYCLES,
): Promise<void> {
  const count = (failCounts.get(key) || 0) + 1;
  failCounts.set(key, count);

  if (count >= threshold) {
    if (count === threshold) {
      console.error(`[monitor] ALERT (manual-resolve): ${summary}`);
    }
    try {
      await triggerIncident(summary, severity, dedupKey);
    } catch (e) {
      console.error(`[monitor] Failed to trigger PagerDuty:`, e);
    }
  }
}

/**
 * Run health checks for a single sauna after status is fetched.
 */
function checkSaunaHealth(
  name: 'Small' | 'Big',
  ip: string,
  status: { on: boolean; temperatureF: number | null; powerW: number | null; reachable: boolean },
  planSlots: Slot[],
): void {
  const id = name.toLowerCase();

  // Always record temp so checks have history available regardless of branch taken below
  if (status.reachable && status.temperatureF !== null) {
    recordTemp(id, status.temperatureF);
  }

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
      const rising = checkTempRising(id);
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

  // 5. Temperature stuck: heater should be running but temp barely moves.
  // Catches a sensor reporting plausible-but-static values (which the rising check
  // can miss if the static value happens to be near the target).
  if (shouldBeOn && status.reachable && status.temperatureF !== null) {
    const stuck = checkTempStuck(id);
    if (stuck === true) {
      alertIfThreshold(
        `temp-stuck-${id}`,
        `${name} sauna temperature stuck near ${status.temperatureF}°F over ${TEMP_STUCK_WINDOW_MS / 60000}min (sensor likely disconnected)`,
        'error',
        `sauna-temp-stuck-${id}`,
      );
    } else {
      resolveIfClear(`temp-stuck-${id}`, `sauna-temp-stuck-${id}`);
    }
  } else {
    resolveIfClear(`temp-stuck-${id}`, `sauna-temp-stuck-${id}`);
  }

  // 6. Welded Shelly relay: commanded OFF but the contactor coil is still drawing
  // power. The Shelly's own relay didn't open → coil energized → contactor closed →
  // heater still being supplied. FIRE HAZARD. Alert is manual-resolve only.
  // Also fire a retry of the off command — might be sticky rather than truly welded.
  if (status.reachable && status.powerW !== null && !status.on && status.powerW > 0) {
    alertIfThresholdManualOnly(
      `welded-relay-${id}`,
      `${name} sauna Shelly relay reports OFF but coil drawing ${status.powerW}W — possible welded relay (FIRE HAZARD, manual investigation required)`,
      'critical',
      `sauna-welded-relay-${id}`,
    );
    // Retry switching off (setSwitch has its own retry+alert path for the switch itself)
    setSwitch(ip, 0, false).catch(e => console.error(`Retry switch-off on welded-relay detection failed:`, e));
  }
  // NOTE: no resolveIfClear pair — incident must be manually resolved in PagerDuty.

  // 7. Coil/wiring broken: commanded ON but no power flow → contactor isn't engaging,
  // heater won't actually heat. Lower urgency than welded; covered by "not-heating"
  // too, but this catches it sooner and is more diagnostic.
  if (shouldBeOn && status.reachable && status.powerW !== null && status.on
    && status.powerW < COIL_BROKEN_POWER_THRESHOLD_W) {
    alertIfThreshold(
      `coil-open-${id}`,
      `${name} sauna relay ON but coil drawing only ${status.powerW}W (broken coil, wiring, or low supply voltage)`,
      'error',
      `sauna-coil-open-${id}`,
    );
  } else {
    resolveIfClear(`coil-open-${id}`, `sauna-coil-open-${id}`);
  }
}

export async function getAllSaunaStatus(): Promise<{
  small: { on: boolean; temperatureF: number | null; powerW: number | null; reachable: boolean };
  big: { on: boolean; temperatureF: number | null; powerW: number | null; reachable: boolean };
}> {
  const [small, big] = await Promise.all([
    getHeaterStatus(config.small_sauna_heater_ip)
      .then(s => ({ ...s, reachable: true }))
      .catch(() => ({ on: false, temperatureF: null, powerW: null, reachable: false })),
    getHeaterStatus(config.big_sauna_heater_ip)
      .then(s => ({ ...s, reachable: true }))
      .catch(() => ({ on: false, temperatureF: null, powerW: null, reachable: false })),
  ]);

  checkOverheatFromStatus('Small', config.small_sauna_heater_ip, small.temperatureF);
  checkOverheatFromStatus('Big', config.big_sauna_heater_ip, big.temperatureF);

  checkSaunaHealth('Small', config.small_sauna_heater_ip, small, currentPlan?.small ?? []);
  checkSaunaHealth('Big', config.big_sauna_heater_ip, big, currentPlan?.big ?? []);

  return { small, big };
}

type SaunaStatus = {
  on: boolean;
  temperatureF: number | null;
  powerW: number | null;
  reachable: boolean;
  heartbeatOk: boolean;
  manualResetRequired: boolean | null;
};

async function reportStatusToServer(status: {
  small: SaunaStatus;
  big: SaunaStatus;
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

async function pingAllHeartbeats(): Promise<{ small: boolean; big: boolean }> {
  const [small, big] = await Promise.all([
    pingHeartbeat(config.small_sauna_heater_ip).then(() => true).catch(e => {
      console.error('Heartbeat ping to small heater failed:', e);
      return false;
    }),
    pingHeartbeat(config.big_sauna_heater_ip).then(() => true).catch(e => {
      console.error('Heartbeat ping to big heater failed:', e);
      return false;
    }),
  ]);
  return { small, big };
}

export function startTemperatureMonitor(): void {
  if (tempMonitorInterval) return;
  const alertTemp = config.temperature_threshold + OVERHEAT_MARGIN_F;
  console.log(`Starting temperature monitor (every ${TEMP_CHECK_INTERVAL_MS / 1000}s, alert at ${alertTemp}°F)`);
  tempMonitorInterval = setInterval(async () => {
    const heartbeats = await pingAllHeartbeats();
    const status = await getAllSaunaStatus();
    const [smallManualReset, bigManualReset] = await Promise.all([
      getManualResetRequired(config.small_sauna_heater_ip),
      getManualResetRequired(config.big_sauna_heater_ip),
    ]);
    await reportStatusToServer({
      small: { ...status.small, heartbeatOk: heartbeats.small, manualResetRequired: smallManualReset },
      big: { ...status.big, heartbeatOk: heartbeats.big, manualResetRequired: bigManualReset },
    });
  }, TEMP_CHECK_INTERVAL_MS);
}

export function stopTemperatureMonitor(): void {
  if (tempMonitorInterval) {
    clearInterval(tempMonitorInterval);
    tempMonitorInterval = null;
  }
}

// Returns true if the heater's safety-lockout flag is set, false if explicitly cleared,
// null if unknown (key missing or device unreachable).
async function getManualResetRequired(ip: string): Promise<boolean | null> {
  try {
    const result = await shellyRpc(ip, 'KVS.Get', { key: 'manualResetRequired' });
    if (!result || result.value === undefined) return null;
    return result.value !== 'false' && result.value !== false;
  } catch {
    return null;
  }
}

async function checkManualResetRequired(): Promise<void> {
  const saunas: Array<{ name: 'Small' | 'Big'; ip: string }> = [
    { name: 'Small', ip: config.small_sauna_heater_ip },
    { name: 'Big', ip: config.big_sauna_heater_ip },
  ];

  for (const { name, ip } of saunas) {
    const dedupKey = `sauna-manual-reset-${name.toLowerCase()}`;
    const required = await getManualResetRequired(ip);

    if (required === true) {
      const summary = `${name} sauna heater requires manual reset (safety lockout tripped)`;
      console.error(summary);
      triggerIncident(summary, 'critical', dedupKey, { sauna: name, ip })
        .catch(e => console.error('Failed to trigger manual-reset incident:', e));
    } else if (required === false) {
      resolveIncident(dedupKey)
        .catch(e => console.error('Failed to resolve manual-reset incident:', e));
    }
    // required === null: device unreachable or key missing — do nothing
  }
}

let manualResetMonitorInterval: ReturnType<typeof setInterval> | null = null;

export function startManualResetMonitor(): void {
  if (manualResetMonitorInterval) return;
  console.log(`Starting manual-reset monitor (every ${MANUAL_RESET_CHECK_INTERVAL_MS / 1000}s)`);
  manualResetMonitorInterval = setInterval(checkManualResetRequired, MANUAL_RESET_CHECK_INTERVAL_MS);
}

export function stopManualResetMonitor(): void {
  if (manualResetMonitorInterval) {
    clearInterval(manualResetMonitorInterval);
    manualResetMonitorInterval = null;
  }
}

export async function deployTemperatureMonitors(): Promise<void> {
  console.log('Deploying temperature monitor scripts to all heaters...');
  // Per-heater isolation: one heater being unreachable must not strand the other's deploy.
  let smallOk = false;
  let bigOk = false;

  try {
    await deployTemperatureMonitor(config.small_sauna_heater_ip, config.temperature_threshold);
    smallOk = true;
  } catch (e) {
    console.error(`Failed to deploy temperature monitor to small heater (${config.small_sauna_heater_ip}):`, e);
  }
  try {
    await deployTemperatureMonitor(config.big_sauna_heater_ip, config.temperature_threshold);
    bigOk = true;
  } catch (e) {
    console.error(`Failed to deploy temperature monitor to big heater (${config.big_sauna_heater_ip}):`, e);
  }

  if (smallOk && bigOk) {
    console.log('Temperature monitor scripts deployed');
  } else if (!smallOk && !bigOk) {
    console.error('Temperature monitor deploy failed for both heaters');
  } else {
    console.error(`Temperature monitor deployed to ${smallOk ? 'small' : 'big'} only; ${smallOk ? 'big' : 'small'} failed`);
  }
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
