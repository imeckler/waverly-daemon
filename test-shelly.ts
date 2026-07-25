/**
 * Shelly device connectivity and control test script.
 * Uses the same config and RPC code as the daemon.
 *
 * Usage:
 *   npx ts-node test-shelly.ts              # test connectivity to all devices
 *   npx ts-node test-shelly.ts status       # get switch status from all devices
 *   npx ts-node test-shelly.ts on <ip> <switch_id>
 *   npx ts-node test-shelly.ts off <ip> <switch_id>
 *   npx ts-node test-shelly.ts toggle <ip> <switch_id>  # toggle a switch on then off
 */

import { shellyRpc } from './src/shellyController.js';
import * as fs from 'fs';

interface ShellyConfig {
  small_sauna_heater_ip: string;
  small_sauna_lights_fan_ip: string;
  big_sauna_heater_ip: string;
  big_sauna_lights_fan_ip: string;
}

function loadConfig(): ShellyConfig {
  const configPath = process.env.DAEMON_CONFIG_FILE || './config.json';
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return parsed.shelly;
}

const config = loadConfig();

interface DeviceInfo {
  name: string;
  ip: string;
}

const allDevices: DeviceInfo[] = [
  { name: 'Small Sauna Heater (1PM)', ip: config.small_sauna_heater_ip },
  { name: 'Small Sauna Lights/Fan (2PM)', ip: config.small_sauna_lights_fan_ip },
  { name: 'Big Sauna Heater (1PM)', ip: config.big_sauna_heater_ip },
  { name: 'Big Sauna Lights/Fan (2PM)', ip: config.big_sauna_lights_fan_ip },
];

async function testConnectivity() {
  console.log('=== Shelly Device Connectivity Test ===\n');

  for (const device of allDevices) {
    process.stdout.write(`${device.name} (${device.ip}) ... `);
    try {
      const info = await shellyRpc(device.ip, 'Shelly.GetDeviceInfo');
      console.log(`OK  [${info.model ?? info.app}, fw: ${info.ver ?? info.fw_id}]`);
    } catch (e: any) {
      console.log(`FAIL  ${e.message}`);
    }
  }
}

async function testStatus() {
  console.log('=== Shelly Device Status ===\n');

  for (const device of allDevices) {
    console.log(`--- ${device.name} (${device.ip}) ---`);
    try {
      const info = await shellyRpc(device.ip, 'Shelly.GetStatus');

      for (const key of Object.keys(info)) {
        if (key.startsWith('switch:')) {
          const sw = info[key];
          const powerStr = sw.apower != null ? `, power: ${sw.apower}W` : '';
          const deviceTempStr = sw.temperature?.tF != null ? `, device: ${sw.temperature.tF}°F` : '';
          console.log(`  ${key}: ${sw.output ? 'ON' : 'OFF'}${powerStr}${deviceTempStr}`);
        }
      }

      for (const key of Object.keys(info)) {
        if (key.startsWith('temperature:')) {
          const t = info[key];
          console.log(`  ${key} (addon sensor): ${t.tF}°F / ${t.tC}°C`);
        }
      }

      if (info.wifi) {
        console.log(`  wifi: ${info.wifi.sta_ip}, rssi: ${info.wifi.rssi}`);
      }
    } catch (e: any) {
      console.log(`  ERROR: ${e.message}`);
    }
    console.log();
  }
}

async function testToggle(ip: string, switchId: number) {
  console.log(`=== Toggle Test: ${ip} switch:${switchId} ===\n`);

  const before = await shellyRpc(ip, 'Switch.GetStatus', { id: switchId });
  console.log(`Current state: ${before.output ? 'ON' : 'OFF'}`);

  console.log('Turning ON...');
  await shellyRpc(ip, 'Switch.Set', { id: switchId, on: true });
  const afterOn = await shellyRpc(ip, 'Switch.GetStatus', { id: switchId });
  console.log(`State after ON: ${afterOn.output ? 'ON' : 'OFF'}`);

  await new Promise(r => setTimeout(r, 2000));

  console.log('Turning OFF...');
  await shellyRpc(ip, 'Switch.Set', { id: switchId, on: false });
  const afterOff = await shellyRpc(ip, 'Switch.GetStatus', { id: switchId });
  console.log(`State after OFF: ${afterOff.output ? 'ON' : 'OFF'}`);

  console.log('\nToggle test complete.');
}

async function setSwitchCmd(ip: string, switchId: number, on: boolean) {
  const label = on ? 'ON' : 'OFF';
  console.log(`Setting ${ip} switch:${switchId} to ${label}...`);
  await shellyRpc(ip, 'Switch.Set', { id: switchId, on });
  const after = await shellyRpc(ip, 'Switch.GetStatus', { id: switchId });
  console.log(`State: ${after.output ? 'ON' : 'OFF'}`);
}

async function main() {
  const cmd = process.argv[2] ?? 'connectivity';

  switch (cmd) {
    case 'connectivity':
      await testConnectivity();
      break;
    case 'status':
      await testStatus();
      break;
    case 'on':
    case 'off': {
      const ip = process.argv[3];
      const switchId = parseInt(process.argv[4] ?? '0', 10);
      if (!ip) {
        console.error(`Usage: npx ts-node test-shelly.ts ${cmd} <ip> <switch_id>`);
        process.exit(1);
      }
      await setSwitchCmd(ip, switchId, cmd === 'on');
      break;
    }
    case 'toggle': {
      const ip = process.argv[3];
      const switchId = parseInt(process.argv[4] ?? '0', 10);
      if (!ip) {
        console.error('Usage: npx ts-node test-shelly.ts toggle <ip> <switch_id>');
        process.exit(1);
      }
      await testToggle(ip, switchId);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Commands: connectivity, status, on, off, toggle');
      process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
