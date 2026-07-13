// TypeScript port of tololib (https://gitlab.com/MatthiasLohr/tololib),
// a client for TOLO / STEAMTEC AIO steam bath units. See ./README.md.

export { ToloClient, ToloError, ToloCommunicationError } from './client.js';
export { ToloDeviceSimulator } from './deviceSimulator.js';
export { ToloSettings, ToloStatus } from './state.js';
export { AromaTherapySlot, Calefaction, Command, LampMode, Model } from './enums.js';
export { Message } from './message.js';
export { CommandValueHandler } from './commandValueHandler.js';
export type { NativeValue, ValueKind } from './commandValueHandler.js';
export {
  DEFAULT_PORT,
  DEFAULT_RETRY_TIMEOUT,
  DEFAULT_RETRY_COUNT,
  TARGET_TEMPERATURE_MIN,
  TARGET_TEMPERATURE_MAX,
  TARGET_TEMPERATURE_DEFAULT,
  TARGET_HUMIDITY_MIN,
  TARGET_HUMIDITY_MAX,
  TARGET_HUMIDITY_DEFAULT,
  POWER_TIMER_MAX,
  SALT_BATH_TIMER_MAX,
  SWEEP_TIMER_MAX,
  FAN_TIMER_MAX,
} from './const.js';
