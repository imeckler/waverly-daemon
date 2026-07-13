// Ported from tololib/message.py.

import { Command } from './enums.js';

/**
 * A message sent over the network to/from a TOLO App Box.
 *
 * By default the TOLO App Box listens on UDP port 51500. Each message it
 * receives is answered with a message of the same structure but different
 * values. Every message has the following structure:
 *
 *   - 2 bytes fixed `0xAAAA`
 *   - 1 byte  command code (see {@link Command})
 *   - 1 byte  command value
 *   - x bytes extra / response payload (depends on the command)
 *   - 2 bytes fixed `0x5555`
 *   - 1 byte  checksum: byte-wise XOR of all preceding bytes
 *
 * The command value is represented here as a single byte (0..255).
 */
export class Message {
  static readonly PREFIX = Buffer.from([0xaa, 0xaa]);
  static readonly SUFFIX = Buffer.from([0x55, 0x55]);

  constructor(
    readonly command: Command,
    readonly commandValue: number,
    readonly extra: Buffer,
  ) {
    if (!Number.isInteger(commandValue) || commandValue < 0 || commandValue > 255) {
      throw new Error('command value not a single byte');
    }
  }

  static fromBytes(messageBytes: Buffer): Message {
    const command = Command.fromCode(messageBytes[2]);
    const commandValue = messageBytes[3];
    // Everything between the command value and the trailing SUFFIX (2) + CRC (1).
    const extra = messageBytes.subarray(4, messageBytes.length - 3);
    return new Message(command, commandValue, Buffer.from(extra));
  }

  toBytes(): Buffer {
    const data = Buffer.concat([
      Message.PREFIX,
      Buffer.from([this.command.code, this.commandValue]),
      this.extra,
      Message.SUFFIX,
    ]);
    return Buffer.concat([data, Buffer.from([Message.generateCrc(data)])]);
  }

  toString(): string {
    return `<Message ${this.command.name}(${this.commandValue}): ${this.extra.toString('hex')}>`;
  }

  /** Byte-wise XOR checksum. */
  static generateCrc(data: Buffer): number {
    let crc = 0x00;
    for (const b of data) crc ^= b;
    return crc;
  }

  static validateCrc(rawBytes: Buffer): boolean {
    return Message.generateCrc(rawBytes.subarray(0, rawBytes.length - 1)) === rawBytes[rawBytes.length - 1];
  }

  /**
   * Validate the metadata (prefix, suffix and CRC) of raw message bytes.
   * Does NOT check for a valid command code or payload.
   */
  static validateMeta(rawBytes: Buffer): boolean {
    if (!rawBytes.subarray(0, Message.PREFIX.length).equals(Message.PREFIX)) return false;
    const beforeCrc = rawBytes.subarray(0, rawBytes.length - 1);
    if (!beforeCrc.subarray(beforeCrc.length - Message.SUFFIX.length).equals(Message.SUFFIX)) return false;
    return Message.validateCrc(rawBytes);
  }
}
