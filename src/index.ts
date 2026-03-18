/* TODO:
  * Consider just doing a polling version of this where the server holds onto the state of who should have
* access at any time, and we just grab that from the server, query the lock and make sure they are in sync.
  *
  * Or better, the server sends a diff (or we compute it)
*/
import { exit } from 'process';
import { UsagePollingService } from './usagePollingService';
import { TranslatedValueID, Driver, isTransportServiceEncapsulation, ZWaveNode } from 'zwave-js';
import { runLockManager } from './lockManager';
import { SaunaScheduleClient } from './saunaScheduleClient.js';
import { startTemperatureMonitor } from './shellyController.js';
import * as fs from 'fs';
import * as path from 'path';

class SaunaManager {
  static TARGET_TEMP = 180;
}

// On start up, request the schedule from the server.
//
// Should maintain a websocket. On opening, the server sends all the scheduled acceses,
// and as new bookings or cancellations occur, the server should send them.
//
// Initialize usage polling service
/*
const usageService = new UsagePollingService(
  process.env.RISO_ADMIN_URL || 'http://192.168.1.100/admin',
  {
    serverUrl: process.env.CLOUD_SERVER_URL || 'https://your-server.com',
    daemonSecret: process.env.DAEMON_SECRET || 'your-secret-here'
  },
  parseInt(process.env.POLLING_INTERVAL_MINUTES || '5') * 60 * 1000
);
*/

// Store references for graceful shutdown
let wsClients: any[] = [];
let saunaScheduleClient: SaunaScheduleClient | null = null;

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down services...');
  wsClients.forEach(client => client.disconnect());
  if (saunaScheduleClient) {
    saunaScheduleClient.disconnect();
  }
  // await usageService.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down services...');
  wsClients.forEach(client => client.disconnect());
  if (saunaScheduleClient) {
    saunaScheduleClient.disconnect();
  }
  // await usageService.stop();
  process.exit(0);
});

//const driver = new Driver('/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick_533D004242-if00', {
// const device = fs.existsSync('/dev/zwave') ? '/dev/zwave' : '/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick_533D004242-if00';
const device = '/dev/zwave';
const driver = new Driver(device, {
  securityKeys: {
    S2_Unauthenticated: Buffer.from('13B96916151EC4CA3D77ACC3172192DF', 'hex'),
    S2_Authenticated: Buffer.from('A7DB49DD6B56241D0546E79C31B9F754', 'hex'),
    S2_AccessControl: Buffer.from('518A862A10E17916E5DEC4C658C2E4DF', 'hex'),
    S0_Legacy: Buffer.from('859944F70CA0D853C4780EDEB48B9669', 'hex'),
  },
  securityKeysLongRange: {
    S2_Authenticated: Buffer.from('7132A23DCDE55F851CC9C5ECE94BA129', 'hex'),
    S2_AccessControl: Buffer.from('01D29357F3D6C7EBBA5C201588D49EB8', 'hex'),
  },
  storage: {
    cacheDir: './zwave-cache'
  }
});

driver.disableStatistics();

// Start usage polling service
/*
usageService.start().then(() => {
  console.log('Usage polling service started successfully');
}).catch((error) => {
  console.error('Failed to start usage polling service:', error);
});
*/

// Lock server configuration
interface LockServerConfig {
  serverUrl: string;
  lockNodeIds: number[];
  description?: string;
}

interface ShellyConfig {
  small_sauna_heater_ip: string;
  small_sauna_lights_fan_ip: string;
  big_sauna_heater_ip: string;
  big_sauna_lights_fan_ip: string;
  temperature_threshold: number;
  sauna_server_url: string;
  daemon_secret?: string;
}

interface DaemonConfig {
  lockServers: LockServerConfig[];
  shelly?: ShellyConfig;
}

// Load daemon configuration
function loadDaemonConfig(): DaemonConfig {
  const configPath = process.env.DAEMON_CONFIG_FILE || './config.json';
  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(configData);
    console.log(`Loaded daemon config from ${configPath}`);
    return parsed;
  } catch (error) {
    console.error(`Failed to read/parse config file ${configPath}:`, error);
    throw error;
  }
}

driver.start().then(async () => {
  return driver.on('all nodes ready', () => {
    console.log('All Z-Wave nodes are ready');

    const daemonConfig = loadDaemonConfig();
    const lockServerConfigs = daemonConfig.lockServers;
    console.log(`Initializing ${lockServerConfigs.length} booking server connection(s)...`);

    // Group lock nodes by server URL
    const serverToLocks = new Map<string, ZWaveNode[]>();

    for (const config of lockServerConfigs) {
      const locks: ZWaveNode[] = [];

      for (const nodeId of config.lockNodeIds) {
        const lockNode = driver.controller.nodes.get(nodeId);
        if (!lockNode) {
          console.error(`Lock node ${nodeId} not found, skipping`);
          continue;
        }

        console.log(`Found lock node ${nodeId}`);
        locks.push(lockNode);

        // Get ALL values for the node (for debugging)
        const allValues = lockNode.getDefinedValueIDs();
        console.log(`Lock ${nodeId} has ${allValues.length} defined values`);

        // Get specific User Code values
        const userCodeValues = allValues.filter(v => v.commandClass === 99); // User Code CC
        console.log(`Lock ${nodeId}: Found ${userCodeValues.length} user code-related values`);

        // Log initial user code slots
        userCodeValues.forEach(valueId => {
          const value = lockNode.getValue(valueId);
          if (valueId.property === 'userCode' && value) {
            console.log(`Lock ${nodeId} user slot ${valueId.propertyKey}: ${value}`);
          }
          if (valueId.property === 'userIdStatus') {
            console.log(`Lock ${nodeId} user slot ${valueId.propertyKey} status: ${value}`);
          }
        });
      }

      if (locks.length > 0) {
        serverToLocks.set(config.serverUrl, locks);
      }
    }

    if (serverToLocks.size === 0) {
      console.error('No lock nodes found, exiting');
      exit(1);
    }

    // Initialize lock managers for each server
    for (const [serverUrl, locks] of serverToLocks.entries()) {
      console.log(`Initializing lock manager for ${serverUrl} with ${locks.length} lock(s)...`);
      const { managers, wsClient } = runLockManager(locks, serverUrl);
      wsClients.push(wsClient);
      console.log(`Lock manager for ${serverUrl} initialized with ${managers.length} lock(s)`);
    }

    console.log('All lock managers initialized successfully');

    // Initialize Sauna Schedule Client if shelly config exists
    try {
      const shellyConfig = daemonConfig.shelly;

      if (shellyConfig && shellyConfig.sauna_server_url) {
        console.log(`Initializing sauna schedule client for ${shellyConfig.sauna_server_url}...`);
        saunaScheduleClient = new SaunaScheduleClient(shellyConfig.sauna_server_url);
        saunaScheduleClient.connect();
        startTemperatureMonitor();
        console.log('Sauna schedule client and temperature monitor initialized');
      } else {
        console.log('No shelly config found, skipping sauna schedule client');
      }
    } catch (error) {
      console.error('Failed to initialize sauna schedule client:', error);
    }
  })
});
