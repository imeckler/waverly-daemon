// Ported from tololib/enums.py.

import { CommandValueHandler } from './commandValueHandler.js';
import {
  FAN_TIMER_MAX,
  POWER_TIMER_MAX,
  SALT_BATH_TIMER_MAX,
  SWEEP_TIMER_MAX,
  TARGET_HUMIDITY_MAX,
  TARGET_HUMIDITY_MIN,
  TARGET_TEMPERATURE_MAX,
  TARGET_TEMPERATURE_MIN,
} from './const.js';

/** Aroma therapy slot. */
export enum AromaTherapySlot {
  A = 0,
  B = 1,
}

/** Calefaction (heating) status. */
export enum Calefaction {
  HEAT = 0,
  INACTIVE = 1,
  UNCLEAR = 2, // TODO find correct meaning (as in upstream tololib)
  KEEP = 3,
}

/** Mode of RGB light control. */
export enum LampMode {
  MANUAL = 0,
  AUTOMATIC = 1,
}

/** TOLO device model. */
export enum Model {
  DOMESTIC = 0,
  COMMERCIAL = 1,
}

/**
 * Commands and their command-code encoding, combined with the value handler
 * describing how to (de)serialize the associated value.
 *
 * In upstream tololib this is a Python `Enum`; here each command is a singleton
 * `Command` instance and the collection lives on static members plus `Command.ALL`.
 */
export class Command {
  private constructor(
    readonly name: string,
    readonly code: number,
    readonly valueHandler: CommandValueHandler,
  ) {}

  static readonly SET_TARGET_TEMPERATURE = new Command(
    'SET_TARGET_TEMPERATURE',
    4,
    new CommandValueHandler('int', (x) => TARGET_TEMPERATURE_MIN <= x && x <= TARGET_TEMPERATURE_MAX),
  );
  static readonly SET_POWER_TIMER = new Command(
    'SET_POWER_TIMER',
    8,
    new CommandValueHandler('int', (x) => 1 <= x && x <= POWER_TIMER_MAX, 0xff),
  );
  static readonly SET_POWER_ON = new Command('SET_POWER_ON', 14, new CommandValueHandler('bool'));
  static readonly SET_AROMA_THERAPY_ON = new Command('SET_AROMA_THERAPY_ON', 18, new CommandValueHandler('bool'));
  static readonly SET_AROMA_THERAPY_SLOT = new Command('SET_AROMA_THERAPY_SLOT', 20, new CommandValueHandler('int'));
  static readonly GET_AROMA_THERAPY_SLOT = new Command('GET_AROMA_THERAPY_SLOT', 21, new CommandValueHandler('int'));
  static readonly SET_SWEEP_ON = new Command('SET_SWEEP_ON', 26, new CommandValueHandler('bool'));
  static readonly SET_SWEEP_TIMER = new Command(
    'SET_SWEEP_TIMER',
    28,
    new CommandValueHandler('int', (x) => 1 <= x && x <= SWEEP_TIMER_MAX, 0x00),
  );
  static readonly SET_LAMP_ON = new Command('SET_LAMP_ON', 30, new CommandValueHandler('bool'));
  static readonly SET_FAN_ON = new Command('SET_FAN_ON', 34, new CommandValueHandler('bool'));
  static readonly SET_FAN_TIMER = new Command(
    'SET_FAN_TIMER',
    36,
    new CommandValueHandler('int', (x) => 1 <= x && x <= FAN_TIMER_MAX, 0x3d), // 0x3d == 61
  );
  static readonly SET_TARGET_HUMIDITY = new Command(
    'SET_TARGET_HUMIDITY',
    38,
    new CommandValueHandler('int', (x) => TARGET_HUMIDITY_MIN <= x && x <= TARGET_HUMIDITY_MAX),
  );
  static readonly GET_SWEEP_TIMER = new Command(
    'GET_SWEEP_TIMER',
    51,
    new CommandValueHandler('int', (x) => 0 <= x && x <= SWEEP_TIMER_MAX, 0x00),
  );
  static readonly GET_FAN_TIMER = new Command(
    'GET_FAN_TIMER',
    53,
    new CommandValueHandler('int', (x) => 0 <= x && x <= FAN_TIMER_MAX, 0x3d), // 0x3d == 61
  );
  static readonly SET_SALT_BATH_ON = new Command('SET_SALT_BATH_ON', 54, new CommandValueHandler('bool'));
  static readonly SET_SALT_BATH_TIMER = new Command(
    'SET_SALT_BATH_TIMER',
    56,
    new CommandValueHandler('int', (x) => 1 <= x && x <= SALT_BATH_TIMER_MAX, 0xff),
  );
  static readonly GET_SALT_BATH_TIMER = new Command(
    'GET_SALT_BATH_TIMER',
    59,
    new CommandValueHandler('int', (x) => 0 <= x && x <= SALT_BATH_TIMER_MAX, 0xff),
  );
  static readonly SET_LAMP_MODE = new Command('SET_LAMP_MODE', 60, new CommandValueHandler('int'));
  static readonly GET_LAMP_MODE = new Command('GET_LAMP_MODE', 61, new CommandValueHandler('int'));
  static readonly LAMP_CHANGE_COLOR = new Command(
    'LAMP_CHANGE_COLOR',
    62,
    new CommandValueHandler('bool', (x) => x === 1),
  );
  static readonly GET_STATUS = new Command('GET_STATUS', 97, new CommandValueHandler('int'));
  static readonly GET_SETTINGS = new Command('GET_SETTINGS', 99, new CommandValueHandler('int'));

  /** Every known command, used for reverse code lookups. */
  static readonly ALL: readonly Command[] = [
    Command.SET_TARGET_TEMPERATURE,
    Command.SET_POWER_TIMER,
    Command.SET_POWER_ON,
    Command.SET_AROMA_THERAPY_ON,
    Command.SET_AROMA_THERAPY_SLOT,
    Command.GET_AROMA_THERAPY_SLOT,
    Command.SET_SWEEP_ON,
    Command.SET_SWEEP_TIMER,
    Command.SET_LAMP_ON,
    Command.SET_FAN_ON,
    Command.SET_FAN_TIMER,
    Command.SET_TARGET_HUMIDITY,
    Command.GET_SWEEP_TIMER,
    Command.GET_FAN_TIMER,
    Command.SET_SALT_BATH_ON,
    Command.SET_SALT_BATH_TIMER,
    Command.GET_SALT_BATH_TIMER,
    Command.SET_LAMP_MODE,
    Command.GET_LAMP_MODE,
    Command.LAMP_CHANGE_COLOR,
    Command.GET_STATUS,
    Command.GET_SETTINGS,
  ];

  /** Return the Command instance with the given command code. */
  static fromCode(code: number): Command {
    for (const command of Command.ALL) {
      if (command.code === code) return command;
    }
    throw new Error(`unknown command code ${code}`);
  }
}
