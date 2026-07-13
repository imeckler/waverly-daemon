// Protocol constants for TOLO / STEAMTEC AIO steam bath units.
// Ported from tololib (https://gitlab.com/MatthiasLohr/tololib), tololib/const.py.

export const DEFAULT_PORT = 51500;

/** Per-attempt UDP wait, in seconds. */
export const DEFAULT_RETRY_TIMEOUT = 1;
export const DEFAULT_RETRY_COUNT = 3;

export const TARGET_TEMPERATURE_MIN = 35;
export const TARGET_TEMPERATURE_MAX = 60;
export const TARGET_TEMPERATURE_DEFAULT = 43;

export const TARGET_HUMIDITY_MIN = 60;
export const TARGET_HUMIDITY_MAX = 99;
export const TARGET_HUMIDITY_DEFAULT = 95;

export const POWER_TIMER_MAX = 60;
export const SALT_BATH_TIMER_MAX = 60;
export const SWEEP_TIMER_MAX = 8;
export const FAN_TIMER_MAX = 60;

/** Single-byte keep-alive packet the device may emit; ignored by clients. */
export const KEEP_ALIVE = 0x2b;
