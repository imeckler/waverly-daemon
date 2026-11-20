# TOLO controller bring-up plan

**Goal:** find out whether the steam controller answers `GET_STATUS` over its serial port, and at what settings.

## Status at the end of 2026-11-19

Parts 1 and 2 are done apart from one check. Nothing has been connected to the controller through the MAX3232 module yet: no listen run and no probe.

**Resume here:**

1. ~~Confirm the last firmware change worked: DB9 pin 2 idles at about -6V against pin 5.~~ Done 2026-11-20.
2. ~~Wire the two listen wires and do Part 3.~~ Done 2026-11-20: no bytes.
3. ~~Do Part 4.~~ Done 2026-11-20: valid status reply at 9600 8N1. Next is "After a valid reply".

**Wiring that is settled:**

| From                     | To                 | When                    |
| ------------------------ | ------------------ | ----------------------- |
| ESP32 `3V3`              | Module `VCC`       | Always                  |
| ESP32 `GND`              | Module `GND`       | Always                  |
| ESP32 `RX2` (GPIO16)     | Module `RXD`       | Always                  |
| ESP32 `TX2` (GPIO17)     | Module `TXD`       | Always                  |
| USB terminal 4 (ground)  | DB9 pin 5          | Listen and probe        |
| USB terminal 3 (send)    | DB9 pin 3          | Listen and probe        |
| USB terminal 2 (receive) | DB9 pin 2          | Probe only              |
| USB terminal 1 (+5V)     | Nothing            | Never, for now          |

The firmware in `src/main.cpp` is flashed and current. It is not committed (`firmware/` is untracked).

## What we know

The App Box died from water damage. It was a serial-to-Ethernet module with an SP3232E RS-232 chip. Its only link to the controller is a 4-wire cable with a USB-A plug on the box end and a round 4-hole plug on the controller end. **The cable is not real USB, so never plug it into a laptop, charger, or the ESP32's USB port.** It carries RS-232 levels, so it also never connects to an ESP32 pin directly, only to the DB9 side of the MAX3232 module.

The controller's socket is too hard to probe directly, so everything is measured at the USB-A breakout with the cable's USB end plugged into it. The breakout's four non-shell terminals are numbered 1 to 4, left to right; the fifth terminal is the plug's metal shell, which connects to none of the others. Ignore the breakout's printed labels. **The shell terminal is not terminal 1 and is never counted.** By voltage the four run +5V, 0V, -5.5V, 0V.

| Terminal | Voltage, controller on | Role                               |
| -------- | ---------------------- | ---------------------------------- |
| 1        | +5V                    | 5V supply, left disconnected       |
| 2        | 0V                     | Controller's receive line (RX)     |
| 3        | -5.5V                  | Controller's send line (TX), idle  |
| 4        | 0V                     | Ground                             |

This matches the standard USB layout (1 power, 4 ground, 2 and 3 data). Earlier readings taken at the socket showed two negative pins; these replace them.

The ESP32 is a 30-pin DevKit whose pins are labelled `RX2` and `TX2` rather than 16 and 17. `RX0`/`TX0` are the USB serial port and are not used.

## Parts

- [x] ESP32 dev board and a USB-C data cable
- [x] MAX3232 module
- [x] DB9 screw-terminal breakout that mates with the module
- [x] USB-A female breakout
- [x] Female-to-female jumper wires (ESP32 to module), and bare-ended wire between the two breakouts
- [ ] Phone charger or power bank for the ESP32
- [x] Multimeter

## Part 1: identify the cable's wires (done)

All measured at the USB breakout.

**Controller on, DC volts** (black to red):

| Pair | Reading | Pair | Reading |
| ---- | ------- | ---- | ------- |
| 1→2  | -5V     | 2→3  | -5.5V   |
| 1→3  | -10.5V  | 2→4  | 0V      |
| 1→4  | -5V     | 3→4  | +5.5V   |

So terminal 1 is +5V, terminal 3 is -5.5V, and terminals 2 and 4 sit together at 0V. Terminals 2 and 3 differ by 5.5V, so the send and receive lines are not shorted.

**Breaker off, resistance:**

| Pair             | Reading       | Meaning                                                     |
| ---------------- | ------------- | ----------------------------------------------------------- |
| 2-4              | 4.57kΩ        | One is ground, the other a receive input with its pull-down |
| Shell-2, Shell-4 | No continuity | The shell is floating and can't identify ground             |
| 1-2              | 8.64kΩ        | Terminal 2 reads 5.36kΩ higher than terminal 4 from the     |
| 1-4              | 3.28kΩ        | supply, so terminal 2 is behind the pull-down               |

**Result:** terminal 4 is ground and terminal 2 is the controller's receive line.

If this is ever in doubt, the powered check is: unit off and nobody in the steam room, a 1kΩ to 10kΩ resistor from terminal 1 to terminal 2, then measure terminal 2 against terminal 4. Near 0V means terminal 2 is ground; a few volts means it is the receive line.

## Part 2: set up the ESP32 at the desk (done, one check left)

- [x] Flash the firmware from `firmware/tolo-probe`:

  ```sh
  uvx --python 3.12 platformio run -t upload
  ```

- [x] Wire the ESP32 to the module as in the table under Status. This module labels its pins like-to-like (`RXD` to `RX2`, `TXD` to `TX2`); crossed, **Check wiring** reads low.
- [x] Power the ESP32, join WiFi `tolo-probe` (password `steam-probe`), and open `http://192.168.4.1`.
- [x] **Check wiring** reads GPIO16 high.
- [x] DB9 pin 3 reads 0V against pin 5, so it is the module's **receive** pin. DB9 pin 2 is its **transmit** pin.
- [x] Loopback: with DB9 pin 2 wired to pin 3 and nothing else attached, **Probe** reports `ECHO`. This is the real test of the ESP32-to-module wiring in both directions.
- [x] DB9 pin 2 reads about -6V against pin 5 when idle (checked 2026-11-20, after the `idleTx` reflash).

The last item is open because pin 2 first read **+6.23V**. The firmware held its transmit line idle with only a weak pull-up, which this module overpowers, so the RS-232 output sat at the wrong level (a break). The firmware now drives the line (`idleTx` in `src/main.cpp`) and has been reflashed, but the pin has not been measured since. If it still reads positive, do not do Part 4.

The pin still sits at +6V briefly while the ESP32 boots, before the firmware takes control. Part 4 works around this by powering the ESP32 first.

## Part 3: listen (nothing is transmitted)

Turn the breaker off while changing wires. Remove the loopback wire. Leave DB9 pin 2 and terminals 1 and 2 empty, and check no stray strands bridge the terminals.

- [x] Connect terminal 4 to DB9 pin 5.
- [x] Connect terminal 3 to DB9 pin 3.
- [x] Power the ESP32 from a charger or power bank, plug the cable into the USB breakout, and turn the breaker on.
- [x] DB9 pin 3 reads about -5.5V against pin 5 (the controller's idle send level arriving at the module).
- [x] Press **Listen**, and use the wall panel during the scan of about 48 seconds. Save the output.

**Result, 2026-11-20:** no bytes at any setting, with DB9 pin 3 confirmed at about -5.5V and the wall panel in use. Inconclusive, as below: the controller does not send unprompted.

**Void run, 2026-11-20:** a first Listen heard no bytes at any setting, but the wires were on the wrong terminals: the shell terminal had been counted as terminal 1, so the real terminals 2 and 3 were wired and ground (4) was not. DB9 pin 3 read 0V against pin 5. Redo it.

| Result  | Meaning                                                         |
| ------- | --------------------------------------------------------------- |
| Bytes   | Terminal 3 is confirmed as the controller's send line           |
| Nothing | Inconclusive: the controller may only answer requests. Carry on |

Garbled bytes still count as activity. Most of the scan uses the wrong baud rate.

## Part 4: probe (transmits `GET_STATUS`)

**Do this only if** DB9 pin 2 idles at about -6V (Part 2).

- [x] Make sure nobody is in the steam room, and the unit is off.
- [x] Stay by the controller with the breaker within reach.
- [x] Breaker off. Keep the two listen wires and add terminal 2 to DB9 pin 2. Leave terminal 1 empty.
- [x] Power the ESP32 and wait a few seconds before turning the breaker on, so the controller never sees the module's transmit pin at +6V while the ESP32 boots.
- [x] Breaker on, press **Probe**, confirm, and watch the panel during the scan of up to about 25 seconds.
- [x] If the unit starts, heats, fills, or behaves oddly, turn off the breaker.
- [x] Save the page output.

**Result, 2026-11-20: the controller answers at 9600 8N1**, the first setting tried.

```
Sending GET_STATUS: AA AA 61 11 FF 55 55 8F
  9600 8N1: 24 bytes: AA AA 61 11 00 0E 2D 11 00 00 00 00 00 00 05 00 0E 00 00 00 1E 55 55 57
```

The 17 status bytes, read with the layout in `src/tolo/state.ts`: power off, room 14°C, power timer 45 min, flow-out on, calefaction 1 (`INACTIVE`, so not heating; the probe page prints this as `heating=1`), aroma, sweep and lamp off, water level 0, fan off, fan timer 5 min, humidity 0%, tank 14°C, model 0 (domestic), salt bath off with its timer at 30 min. The frame is the same one the App Box carried over UDP, so the box passed the serial bytes through unchanged.

| Result                           | Next step                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `VALID STATUS REPLY` and `FOUND` | Record the baud rate and format. Check that temperature and humidity look right |
| `ECHO`                           | Our transmission is coming back, so look for a short or a leftover loopback wire |
| Other bytes, no valid reply      | Save them for analysis                                                          |
| Nothing                          | Recheck the wiring, then consider the wall-panel bus or a working App Box       |

## Done for the day

- [x] Listen and probe output saved
- [x] Working baud rate and format recorded, if found: 9600 8N1
- [ ] Controller left connected safely, or its cable left unplugged and dry

## After a valid reply

1. ~~Write the real bridge firmware, keeping the ESP32 as a relay and turning the unit off if it loses contact with the daemon.~~ Written 2026-11-20 in `../tolo-bridge`; it builds, and its protocol code was run against the daemon's client on a laptop, but it has not been flashed or run against the controller. `../tolo-bridge/README.md` is the build guide.
2. Point the daemon at the ESP32. `ToloClient` takes the bridge's key (`tolo_key` in `config.json`); the change is in the working tree, not committed or deployed.
3. Check whether terminal 1's 5V (5.0V with nothing connected) can power the ESP32 without dropping below about 4.5V (Step 6 of the build guide).
4. Confirm 2.4GHz WiFi reaches the controller, and mount everything in a sealed enclosure.

---

numbering, looking up at the socket for the app box:
1 2
4 3

therefore, with the notch pointing up, looking at the plug end:

2 1
3 4
