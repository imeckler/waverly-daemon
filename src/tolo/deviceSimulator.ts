// Ported from tololib/device_simulator.py.
//
// A tiny in-process UDP server that speaks enough of the TOLO protocol to test
// clients (and the planner) without real hardware. It stores a 17-byte status
// buffer and an 8-byte settings buffer and mutates them in response to commands.

import * as dgram from 'node:dgram';

import { DEFAULT_PORT } from './const.js';
import { Command } from './enums.js';
import { Message } from './message.js';

export class ToloDeviceSimulator {
  private readonly status = Buffer.alloc(17);
  private readonly settings = Buffer.alloc(8);
  private socket: dgram.Socket | null = null;

  constructor(
    private readonly address = '127.0.0.1',
    private readonly port: number = DEFAULT_PORT,
  ) {}

  /** Bind the UDP socket and begin answering messages. */
  start(): Promise<void> {
    const socket = dgram.createSocket('udp4');
    this.socket = socket;

    socket.on('message', (data, sender) => {
      let response: Message;
      try {
        response = this.handleMessage(Message.fromBytes(data));
      } catch {
        // Could not generate a response (unknown/invalid message); drop it.
        return;
      }
      socket.send(response.toBytes(), sender.port, sender.address);
    });

    return new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.port, this.address, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return Promise.resolve();
    return new Promise<void>((resolve) => socket.close(resolve));
  }

  private static handleSet(message: Message, field: Buffer, index: number): Message {
    field[index] = message.commandValue;
    return new Message(message.command, message.commandValue, Buffer.from([0x00]));
  }

  private static handleGet(message: Message, field: Buffer, index: number): Message {
    return new Message(message.command, field[index], Buffer.from([0x00]));
  }

  private handleMessage(message: Message): Message {
    switch (message.command) {
      case Command.GET_STATUS:
        return new Message(message.command, 0x11, Buffer.from(this.status));
      case Command.GET_SETTINGS:
        return new Message(message.command, 0x08, Buffer.from(this.settings));
      case Command.SET_TARGET_TEMPERATURE:
        return ToloDeviceSimulator.handleSet(message, this.settings, 0);
      case Command.SET_POWER_TIMER:
        this.status[2] = message.commandValue;
        return ToloDeviceSimulator.handleSet(message, this.settings, 1);
      case Command.SET_POWER_ON:
        return ToloDeviceSimulator.handleSet(message, this.status, 0);
      case Command.SET_AROMA_THERAPY_ON:
        return ToloDeviceSimulator.handleSet(message, this.status, 4);
      case Command.SET_AROMA_THERAPY_SLOT:
        return ToloDeviceSimulator.handleSet(message, this.settings, 2);
      case Command.GET_AROMA_THERAPY_SLOT:
        return ToloDeviceSimulator.handleGet(message, this.settings, 2);
      case Command.SET_SWEEP_TIMER:
        this.status[6] = message.commandValue;
        return ToloDeviceSimulator.handleSet(message, this.settings, 3);
      case Command.SET_LAMP_ON:
        return ToloDeviceSimulator.handleSet(message, this.status, 7);
      case Command.SET_FAN_ON:
        return ToloDeviceSimulator.handleSet(message, this.status, 9);
      case Command.SET_FAN_TIMER:
        this.status[10] = message.commandValue;
        return ToloDeviceSimulator.handleSet(message, this.settings, 4);
      case Command.SET_TARGET_HUMIDITY:
        return ToloDeviceSimulator.handleSet(message, this.settings, 5);
      case Command.SET_SWEEP_ON:
        return ToloDeviceSimulator.handleSet(message, this.status, 5);
      case Command.GET_FAN_TIMER:
        return ToloDeviceSimulator.handleGet(message, this.status, 10);
      case Command.SET_SALT_BATH_ON:
        return ToloDeviceSimulator.handleSet(message, this.status, 15);
      case Command.SET_SALT_BATH_TIMER:
        this.status[16] = message.commandValue;
        return ToloDeviceSimulator.handleSet(message, this.settings, 6);
      case Command.GET_SALT_BATH_TIMER:
        return ToloDeviceSimulator.handleGet(message, this.status, 16);
      case Command.SET_LAMP_MODE:
        return ToloDeviceSimulator.handleSet(message, this.settings, 7);
      case Command.GET_LAMP_MODE:
        return ToloDeviceSimulator.handleGet(message, this.settings, 7);
      case Command.GET_SWEEP_TIMER:
        return ToloDeviceSimulator.handleGet(message, this.status, 6);
      case Command.LAMP_CHANGE_COLOR:
        return new Message(message.command, message.commandValue, Buffer.from([0x00]));
      default:
        throw new Error(`unrecognized message ${message.toString()}`);
    }
  }
}
