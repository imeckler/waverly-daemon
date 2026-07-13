// Ported from tololib/client.py + tololib/async_client.py.
//
// Node's UDP sockets are asynchronous, so — unlike upstream tololib, which ships
// both a blocking `ToloClient` and an `AsyncToloClient` — there is a single,
// promise-based `ToloClient` here (equivalent to the upstream async client).

import * as dgram from 'node:dgram';

import * as protocol from './protocol.js';
import { DEFAULT_PORT, DEFAULT_RETRY_COUNT, DEFAULT_RETRY_TIMEOUT, KEEP_ALIVE } from './const.js';
import { AromaTherapySlot, Command, LampMode } from './enums.js';
import { Message } from './message.js';
import { ToloSettings, ToloStatus } from './state.js';

export class ToloError extends Error {}
export class ToloCommunicationError extends ToloError {}

/** Sentinel returned by {@link AsyncQueue.get} when the wait times out. */
const TIMEOUT = Symbol('timeout');

/** Minimal async FIFO with a per-`get` timeout, mirroring asyncio.Queue usage. */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((value: T | typeof TIMEOUT) => void)[] = [];

  put(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  get(timeoutMs: number): Promise<T | typeof TIMEOUT> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(TIMEOUT);
      }, timeoutMs);

      const waiter = (value: T | typeof TIMEOUT) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
    });
  }
}

export class ToloClient {
  private socket: dgram.Socket | null = null;
  private queue: AsyncQueue<Buffer> | null = null;

  /**
   * @param retryTimeout Per-attempt UDP wait, in seconds.
   */
  constructor(
    readonly address: string,
    readonly port: number = DEFAULT_PORT,
    readonly retryTimeout: number = DEFAULT_RETRY_TIMEOUT,
    readonly retryCount: number = DEFAULT_RETRY_COUNT,
  ) {}

  async getStatus(): Promise<ToloStatus> {
    const response = await this.communicate(protocol.buildGetStatusMessage());
    return protocol.parseStatusResponse(response);
  }

  async getSettings(): Promise<ToloSettings> {
    const response = await this.communicate(protocol.buildGetSettingsMessage());
    return protocol.parseSettingsResponse(response);
  }

  setPowerOn(powerOn: boolean): Promise<boolean> {
    return this.sendSetCommand(Command.SET_POWER_ON, powerOn);
  }

  setFanOn(fanOn: boolean): Promise<boolean> {
    return this.sendSetCommand(Command.SET_FAN_ON, fanOn);
  }

  setAromaTherapyOn(aromaTherapyOn: boolean): Promise<boolean> {
    return this.sendSetCommand(Command.SET_AROMA_THERAPY_ON, aromaTherapyOn);
  }

  /**
   * Disable and directly re-enable aroma therapy, manually triggering the aroma
   * pump (otherwise fired automatically every 5 minutes, a fixed device value).
   */
  async pokeAromaTherapy(): Promise<boolean> {
    if (!(await this.sendSetCommand(Command.SET_AROMA_THERAPY_ON, false))) return false;
    return this.sendSetCommand(Command.SET_AROMA_THERAPY_ON, true);
  }

  setLampOn(lampOn: boolean): Promise<boolean> {
    return this.sendSetCommand(Command.SET_LAMP_ON, lampOn);
  }

  setSweepOn(sweepOn: boolean): Promise<boolean> {
    return this.sendSetCommand(Command.SET_SWEEP_ON, sweepOn);
  }

  setSaltBathOn(saltBathOn: boolean): Promise<boolean> {
    return this.sendSetCommand(Command.SET_SALT_BATH_ON, saltBathOn);
  }

  setTargetTemperature(targetTemperature: number): Promise<boolean> {
    return this.sendSetCommand(Command.SET_TARGET_TEMPERATURE, targetTemperature);
  }

  setTargetHumidity(targetHumidity: number): Promise<boolean> {
    return this.sendSetCommand(Command.SET_TARGET_HUMIDITY, targetHumidity);
  }

  setPowerTimer(powerTimer: number | null): Promise<boolean> {
    return this.sendSetCommand(Command.SET_POWER_TIMER, powerTimer);
  }

  setSaltBathTimer(saltBathTimer: number | null): Promise<boolean> {
    return this.sendSetCommand(Command.SET_SALT_BATH_TIMER, saltBathTimer);
  }

  setAromaTherapySlot(aromaTherapySlot: AromaTherapySlot): Promise<boolean> {
    return this.sendSetCommand(Command.SET_AROMA_THERAPY_SLOT, aromaTherapySlot);
  }

  setSweepTimer(sweepTimer: number | null): Promise<boolean> {
    return this.sendSetCommand(Command.SET_SWEEP_TIMER, sweepTimer);
  }

  setLampMode(lampMode: LampMode): Promise<boolean> {
    return this.sendSetCommand(Command.SET_LAMP_MODE, lampMode);
  }

  setFanTimer(fanTimer: number | null): Promise<boolean> {
    return this.sendSetCommand(Command.SET_FAN_TIMER, fanTimer);
  }

  /**
   * Change the RGB lamp's color to the next color in the loop.
   * Only possible when LampMode is MANUAL.
   */
  lampChangeColor(): Promise<boolean> {
    return this.sendSetCommand(Command.LAMP_CHANGE_COLOR, 1);
  }

  async getAromaTherapySlot(): Promise<AromaTherapySlot> {
    const result = await this.sendGetCommand(Command.GET_AROMA_THERAPY_SLOT);
    if (typeof result === 'number') return result as AromaTherapySlot;
    throw new Error(`unexpected type ${typeof result}, expecting AromaTherapySlot`);
  }

  async getFanTimer(): Promise<number | null> {
    const result = await this.sendGetCommand(Command.GET_FAN_TIMER);
    if (result === null || typeof result === 'number') return result;
    throw new Error(`unexpected type ${typeof result}, expecting number | null`);
  }

  async getSaltBathTimer(): Promise<number | null> {
    const result = await this.sendGetCommand(Command.GET_SALT_BATH_TIMER);
    if (result === null || typeof result === 'number') return result;
    throw new Error(`unexpected type ${typeof result}, expecting number | null`);
  }

  async getLampMode(): Promise<LampMode> {
    const result = await this.sendGetCommand(Command.GET_LAMP_MODE);
    if (typeof result === 'number') return result as LampMode;
    throw new Error(`unexpected type ${typeof result}, expecting LampMode`);
  }

  async getSweepTimer(): Promise<number | null> {
    const result = await this.sendGetCommand(Command.GET_SWEEP_TIMER);
    if (result === null || typeof result === 'number') return result;
    throw new Error(`unexpected type ${typeof result}, expecting number | null`);
  }

  /** Close the underlying UDP socket. */
  async close(): Promise<void> {
    if (this.socket !== null) {
      const socket = this.socket;
      this.socket = null;
      this.queue = null;
      await new Promise<void>((resolve) => socket.close(resolve));
    }
  }

  private async sendSetCommand(command: Command, value: boolean | number | null): Promise<boolean> {
    const response = await this.communicate(protocol.buildSetCommandMessage(command, value));
    return protocol.parseSetCommandResponse(response);
  }

  private async sendGetCommand(command: Command): Promise<boolean | number | null> {
    const response = await this.communicate(protocol.buildGetCommandMessage(command));
    return protocol.parseGetCommandResponse(command, response);
  }

  private ensureEndpoint(): { socket: dgram.Socket; queue: AsyncQueue<Buffer> } {
    if (this.socket === null || this.queue === null) {
      const socket = dgram.createSocket('udp4');
      const queue = new AsyncQueue<Buffer>();
      socket.on('message', (data) => queue.put(data));
      socket.on('error', () => {
        /* surfaced to callers via per-attempt timeouts */
      });
      this.socket = socket;
      this.queue = queue;
    }
    return { socket: this.socket, queue: this.queue };
  }

  /**
   * Send a message with retry logic. UDP is unreliable, so if no matching reply
   * arrives within `retryTimeout` the message is re-sent, up to `retryCount`.
   */
  private async communicate(message: Message): Promise<Message> {
    const { socket, queue } = this.ensureEndpoint();
    const timeoutMs = this.retryTimeout * 1000;
    const payload = message.toBytes();

    for (let attempt = 0; attempt < this.retryCount; attempt++) {
      socket.send(payload, this.port, this.address);

      // Keep reading until this attempt's budget is exhausted, skipping
      // keep-alive packets and replies for other commands.
      let responseMessage: Message | null = null;
      while (responseMessage === null) {
        const responseBytes = await queue.get(timeoutMs);
        if (responseBytes === TIMEOUT) break;

        if (responseBytes.length === 1 && responseBytes[0] === KEEP_ALIVE) continue;

        const parsed = Message.fromBytes(responseBytes);
        if (parsed.command.code === message.command.code) responseMessage = parsed;
      }
      if (responseMessage !== null) return responseMessage;
    }

    throw new ToloCommunicationError(`failed to send message after ${this.retryCount} attempts`);
  }

  /**
   * Discover available TOLO devices on the local network by broadcasting a probe
   * and yielding each responding device's address and status.
   *
   * @param timeout Per-round wait for replies, in seconds.
   */
  static async *discover(
    broadcastAddress = '255.255.255.255',
    port: number = DEFAULT_PORT,
    timeout: number = DEFAULT_RETRY_TIMEOUT,
    maxRetries: number = DEFAULT_RETRY_COUNT,
  ): AsyncGenerator<[{ address: string; port: number }, ToloStatus]> {
    const socket = dgram.createSocket('udp4');
    const queue = new AsyncQueue<{ data: Buffer; sender: dgram.RemoteInfo }>();
    socket.on('message', (data, sender) => queue.put({ data, sender }));

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.setBroadcast(true);
        socket.removeListener('error', reject);
        resolve();
      });
    });

    const timeoutMs = timeout * 1000;
    const probe = protocol.buildDiscoverMessage().toBytes();

    try {
      for (let round = 0; round < maxRetries; round++) {
        socket.send(probe, port, broadcastAddress);
        for (;;) {
          const next = await queue.get(timeoutMs);
          if (next === TIMEOUT) return;
          const message = Message.fromBytes(next.data);
          yield [{ address: next.sender.address, port: next.sender.port }, protocol.parseStatusResponse(message)];
        }
      }
    } finally {
      await new Promise<void>((resolve) => socket.close(resolve));
    }
  }
}
