// Blink a Shelly switch a few times, ending in the state it started in.
//
// Used to flash a sauna's lights when its heater slot ends. Kept free of the
// shellyController module (which loads config.json at import) so it can be
// unit-tested against a fake RPC.

export type Rpc = (ip: string, method: string, params?: any) => Promise<any>;

export interface BlinkOptions {
  /** Number of off/on (or on/off) cycles. */
  count: number;
  /** Time the switch spends in each state before flipping again, in ms. */
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Read the switch's current state, then flip it away and back `count` times.
 * Whatever state the switch was in when we started is the state it ends in, so
 * a blink never changes what the schedule already decided.
 */
export async function blinkSwitch(
  rpc: Rpc,
  ip: string,
  switchId: number,
  { count, intervalMs, sleep = defaultSleep }: BlinkOptions,
): Promise<void> {
  const status = await rpc(ip, 'Switch.GetStatus', { id: switchId });
  const resting: boolean = status.output ?? false;

  for (let i = 0; i < count; i++) {
    await rpc(ip, 'Switch.Set', { id: switchId, on: !resting });
    await sleep(intervalMs);
    await rpc(ip, 'Switch.Set', { id: switchId, on: resting });
    if (i < count - 1) await sleep(intervalMs);
  }
}
