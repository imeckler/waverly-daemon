// Ported from tololib/state.py.

import { CommandValueHandler } from './commandValueHandler.js';
import { AromaTherapySlot, Calefaction, LampMode, Model } from './enums.js';

/** The current status of a TOLO device (as reported by GET_STATUS). */
export class ToloStatus {
  constructor(
    readonly powerOn: boolean,
    readonly currentTemperature: number,
    readonly powerTimer: number | null,
    readonly flowIn: boolean,
    readonly flowOut: boolean,
    readonly calefaction: Calefaction,
    readonly aromaTherapyOn: boolean,
    readonly sweepOn: boolean,
    readonly sweepTimer: number,
    readonly lampOn: boolean,
    readonly waterLevel: number,
    readonly fanOn: boolean,
    readonly fanTimer: number | null,
    readonly currentHumidity: number,
    readonly tankTemperature: number,
    readonly model: Model,
    readonly saltBathOn: boolean,
    readonly saltBathTimer: number | null,
  ) {}

  get waterLevelPercent(): number {
    switch (this.waterLevel) {
      case 0:
        return 0;
      case 1:
        return 33;
      case 2:
        return 66;
      case 3:
        return 100;
      default:
        throw new Error(`unsupported water level ${this.waterLevel}`);
    }
  }

  /**
   * Build a ToloStatus from a binary status payload (17 bytes):
   *
   *    0: {0, 1} power on
   *    1: current temperature
   *    2: 61 if power timer disabled, else duration (1..60) minutes
   *    3: (64 if flow-in) + (16 if flow-out) + Calefaction state (0..3)
   *    4: {0, 1} aroma therapy on
   *    5: {0, 1} sweep on
   *    6: sweep timer remaining (1..8) hours, or 0 when off
   *    7: {0, 1} lamp on
   *    8: water level (0..3)
   *    9: {0, 1} fan on
   *   10: 61 if fan timer disabled, else remaining minutes
   *   11: current humidity
   *   12: tank temperature
   *   13: 0  (unused?)
   *   14: model
   *   15: {0, 1} salt bath on
   *   16: 0 if salt bath timer disabled, else remaining minutes
   */
  static fromBytes(data: Buffer): ToloStatus {
    return new ToloStatus(
      Boolean(data[0]),
      data[1],
      new CommandValueHandler('int', undefined, 0x3d).byte2native(data[2]) as number | null,
      Boolean(data[3] & 64),
      Boolean(data[3] & 16),
      (data[3] & 3) as Calefaction,
      Boolean(data[4]),
      Boolean(data[5]),
      data[6],
      Boolean(data[7]),
      data[8],
      Boolean(data[9]),
      new CommandValueHandler('int', undefined, 0x3d).byte2native(data[10]) as number | null,
      data[11],
      data[12],
      data[14] as Model,
      Boolean(data[15]),
      new CommandValueHandler('int', undefined, 0x00).byte2native(data[16]) as number | null,
    );
  }
}

/** The current settings of a TOLO device (as reported by GET_SETTINGS). */
export class ToloSettings {
  constructor(
    readonly targetTemperature: number,
    readonly powerTimer: number | null,
    readonly aromaTherapySlot: AromaTherapySlot,
    readonly sweepTimer: number | null,
    readonly fanTimer: number | null,
    readonly targetHumidity: number,
    readonly saltBathTimer: number | null,
    readonly lampMode: LampMode,
  ) {}

  /**
   * Build a ToloSettings from a binary settings payload (8 bytes):
   *
   *   0: target temperature
   *   1: 255 if power timer disabled, else minutes
   *   2: aroma therapy slot
   *   3: 0 if sweep timer disabled, else hours
   *   4: 61 if fan timer disabled, else minutes
   *   5: target humidity
   *   6: 255 if salt bath timer disabled, else minutes
   *   7: lamp mode (defaults to MANUAL if absent)
   */
  static fromBytes(data: Buffer): ToloSettings {
    const targetTemperature = data[0];
    const powerTimer = new CommandValueHandler('int', undefined, 0xff).byte2native(data[1]) as number | null;
    const aromaTherapySlot = data[2] as AromaTherapySlot;
    const sweepTimer = new CommandValueHandler('int', undefined, 0x00).byte2native(data[3]) as number | null;
    const fanTimer = new CommandValueHandler('int', undefined, 0x3d).byte2native(data[4]) as number | null;
    const targetHumidity = data[5];
    const saltBathTimer = new CommandValueHandler('int', undefined, 0xff).byte2native(data[6]) as number | null;
    const lampMode = (data.length > 7 ? data[7] : LampMode.MANUAL) as LampMode;

    return new ToloSettings(
      targetTemperature,
      powerTimer,
      aromaTherapySlot,
      sweepTimer,
      fanTimer,
      targetHumidity,
      saltBathTimer,
      lampMode,
    );
  }
}
