# Waverly Daemon Configuration

The waverly-daemon manages multiple locks and Shelly sauna devices from a single unified configuration file.

## Configuration File

Create a `config.json` file in the daemon directory:

```json
{
  "lockServers": [
    {
      "serverUrl": "http://localhost:8080",
      "lockNodeIds": [6, 7],
      "description": "Printshop - front door and shop entrance"
    },
    {
      "serverUrl": "http://localhost:3000",
      "lockNodeIds": [8],
      "description": "Sauna entrance"
    }
  ],
  "shelly": {
    "small_sauna_heater_ip": "192.168.1.100",
    "small_sauna_lights_fan_ip": "192.168.1.101",
    "big_sauna_heater_ip": "192.168.1.102",
    "big_sauna_lights_fan_ip": "192.168.1.103",
    "temperature_threshold": 185,
    "sauna_server_url": "http://localhost:3000",
    "daemon_secret": "your-daemon-secret-here"
  }
}
```

**Custom config path**: Set `DAEMON_CONFIG_FILE` environment variable:
```bash
export DAEMON_CONFIG_FILE="/path/to/my-config.json"
```

## Lock Servers Configuration

The `lockServers` array defines which locks are controlled by which booking servers:

- **serverUrl**: URL of the booking server (exposes `/ws/bookings` WebSocket)
- **lockNodeIds**: Array of Z-Wave lock node IDs to control
- **description**: Optional description for documentation

## Shelly Configuration

The `shelly` object configures sauna heater control (optional):

- **IP addresses**: Four Shelly Gen4 devices (heater + lights/fan for each sauna)
- **temperature_threshold**: Maximum temperature in Fahrenheit before safety shutoff
- **sauna_server_url**: URL of sauna booking server (exposes `/ws/sauna-schedules` WebSocket)
- **daemon_secret**: Authentication secret for sauna server API calls

## How It Works

### Lock Management
1. Daemon connects to each booking server's `/ws/bookings` endpoint
2. Receives booking messages with PIN codes and time ranges
3. Programs Z-Wave locks to grant access during booking times
4. Auto-reconnects on connection drop

### Shelly Control (Sauna)
1. Daemon connects to sauna server's `/ws/sauna-schedules` endpoint
2. Receives operational plan when computed (daily at 2AM or when bookings change)
3. Applies schedules to Shelly devices:
   - **Heaters**: Temperature-monitored on/off based on optimal heating plan
   - **Lights**: On during bookings only
   - **Fans**: On during bookings + 30 minutes after HOT period ends

## Finding Lock Node IDs

To find your lock node IDs:

1. Start the daemon
2. Look for log messages like "Found lock node X"
3. Use those IDs in your configuration

## WebSocket Endpoints

### Booking Server (`/ws/bookings`)
```typescript
type BookingMessage =
  | { kind: 'addAccess', code: string, start: number, stop: number }
  | { kind: 'removeAccess', code: string, start: number, stop: number };
```

### Sauna Server (`/ws/sauna-schedules`)
```typescript
type ScheduleUpdate = {
  kind: 'scheduleUpdate',
  planDate: string,
  plan: { small: Slot[], big: Slot[] },
  bookings: Booking[]
};
```

## Re-paired locks

A lock that is excluded and included again gets a new node id. Because
`config.json` is baked into the image, the daemon keeps the mapping it actually
runs with in `zwave-cache/lock-nodes.json` (the one writable directory), written
by the assisted pairing flow on the admin page. On startup that file's node ids
win over `lockNodeIds` in `config.json` for the servers it lists. Delete the file
to go back to `config.json`.
