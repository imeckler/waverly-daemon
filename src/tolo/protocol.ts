// Ported from tololib/protocol.py.
//
// Pure, I/O-free helpers for building TOLO protocol request messages and parsing
// their responses. Shared by the client so wire-protocol knowledge lives in one
// place.

import { Command } from './enums.js';
import { Message } from './message.js';
import { NativeValue } from './commandValueHandler.js';
import { ToloSettings, ToloStatus } from './state.js';

export function buildGetStatusMessage(): Message {
  return new Message(Command.GET_STATUS, 0x11, Buffer.from([0xff]));
}

export function parseStatusResponse(response: Message): ToloStatus {
  return ToloStatus.fromBytes(response.extra);
}

export function buildGetSettingsMessage(): Message {
  return new Message(Command.GET_SETTINGS, 0x08, Buffer.from([0xff]));
}

export function parseSettingsResponse(response: Message): ToloSettings {
  return ToloSettings.fromBytes(response.extra);
}

export function buildSetCommandMessage(command: Command, value: NativeValue): Message {
  return new Message(command, command.valueHandler.native2byte(value), Buffer.from([0xff]));
}

export function parseSetCommandResponse(response: Message): boolean {
  return response.extra.length === 1 && response.extra[0] === 0x00;
}

export function buildGetCommandMessage(command: Command): Message {
  return new Message(command, 0x00, Buffer.from([0xff]));
}

export function parseGetCommandResponse(command: Command, response: Message): NativeValue {
  return command.valueHandler.byte2native(response.commandValue);
}

export function buildDiscoverMessage(): Message {
  return new Message(Command.GET_STATUS, 0x00, Buffer.from([0xff]));
}
