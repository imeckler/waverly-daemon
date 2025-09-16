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
let wsClient: any = null;

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down services...');
  if (wsClient) {
    wsClient.disconnect();
  }
  // await usageService.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down services...');
  if (wsClient) {
    wsClient.disconnect();
  }
  // await usageService.stop();
  process.exit(0);
});

const driver = new Driver('/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick_533D004242-if00', {
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

driver.start().then(async () => {
  return driver.on('all nodes ready', () => {
    console.log('All Z-Wave nodes are ready');
    const lockNode = driver.controller.nodes.get(2);
    if (lockNode == undefined) {
      console.error('Lock node (node 2) not found');
      exit(1);
    }

    console.log('Lock node found, initializing lock manager...');

    // Initialize lock manager with WebSocket connection
    const serverUrl = process.env.BOOKING_SERVER_URL || 'ws://localhost:8080';
    const { manager, wsClient: lockWsClient } = runLockManager(lockNode, serverUrl);

    // Store reference for graceful shutdown
    wsClient = lockWsClient;

    // Get ALL values for the node (for debugging)
    const allValues = lockNode.getDefinedValueIDs();
    console.log(`Lock has ${allValues.length} defined values`);

    // Get specific User Code values
    const userCodeValues = allValues.filter(v => v.commandClass === 99); // User Code CC
    console.log(`Found ${userCodeValues.length} user code-related values`);

    // Log initial user code slots
    userCodeValues.forEach(valueId => {
      const value = lockNode.getValue(valueId);
      if (valueId.property === 'userCode' && value) {
        console.log(`User slot ${valueId.propertyKey}: ${value}`);
      }
      if (valueId.property === 'userIdStatus') {
        console.log(`User slot ${valueId.propertyKey} status: ${value}`);
      }
    });

    console.log('Lock manager initialized successfully');
  })
});
