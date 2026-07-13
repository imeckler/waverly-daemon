# tolo

TypeScript port of [tololib](https://gitlab.com/MatthiasLohr/tololib) by Matthias
Lohr (MIT), a client for **TOLO / STEAMTEC AIO** steam bath units — the same
protocol Home Assistant's TOLO integration uses.

The unit runs a "TOLO App Box" that listens on **UDP port 51500**. Control is a
simple request/response protocol: each packet is `0xAAAA | command | value |
extra | 0x5555 | crc`, where `crc` is a byte-wise XOR of everything preceding it.
Every request is answered by a packet with the same command code.

## Usage

```ts
import { ToloClient, LampMode } from './lib/tolo';

const client = new ToloClient('192.168.1.50'); // port defaults to 51500

const status = await client.getStatus();   // ToloStatus (power, temp, humidity, …)
const settings = await client.getSettings(); // ToloSettings (targets, timers, …)

await client.setPowerOn(true);
await client.setTargetTemperature(50);       // clamped to 35..60
await client.setLampMode(LampMode.AUTOMATIC);

await client.close();
```

Discover devices on the LAN:

```ts
for await (const [addr, status] of ToloClient.discover()) {
  console.log(addr.address, status.currentTemperature);
}
```

Test without hardware using the in-process simulator:

```ts
const sim = new ToloDeviceSimulator('127.0.0.1', 51500);
await sim.start();
// ... point a ToloClient at 127.0.0.1:51500 ...
await sim.stop();
```

## Differences from upstream

- **One async client.** Upstream ships a blocking `ToloClient` and an
  `AsyncToloClient`. Node's UDP sockets are asynchronous, so this port exposes a
  single promise-based `ToloClient` equivalent to the upstream async client.
- **`CommandValueHandler` carries an explicit `kind`** (`'bool' | 'int'`).
  Upstream recovers the native type via Python generic reflection
  (`__orig_class__`), which has no TypeScript runtime equivalent. IntEnum values
  (`AromaTherapySlot`, `LampMode`, `Model`) are plain numbers here and use
  `'int'`.
- **`Command` is a class with singleton static members** plus `Command.ALL`,
  standing in for Python's `Enum`. Singletons compare with `===`.
- **Command values are `number` (0..255)** rather than one-byte `bytes`; message
  `extra` payloads are `Buffer`s.

## Files

| file                    | upstream            | purpose                                   |
| ----------------------- | ------------------- | ----------------------------------------- |
| `const.ts`              | `const.py`          | protocol constants and ranges             |
| `commandValueHandler.ts`| `command_value_handler.py` | value ⇄ byte conversion            |
| `enums.ts`              | `enums.py`          | enums + `Command` registry                |
| `message.ts`            | `message.py`        | packet framing / CRC                      |
| `state.ts`              | `state.py`          | `ToloStatus` / `ToloSettings` decoding    |
| `protocol.ts`           | `protocol.py`       | pure request builders / response parsers  |
| `client.ts`             | `client.py` + `async_client.py` | UDP client + `discover()`     |
| `deviceSimulator.ts`    | `device_simulator.py` | in-process test device                  |
```
