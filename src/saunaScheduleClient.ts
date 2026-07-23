import WebSocket from 'ws';
import { applyOperationalPlan, Booking, OperationalPlan, setSaunaOverride } from './shellyController.js';
import { applySteamSchedule, setSteamOverride, SteamPeriod } from './steamController.js';
import { getLockCodes, setLockCode } from './lockRegistry.js';
import {
  ServerToDaemonMessage,
  DaemonToServerMessage,
  ScheduleUpdateMessage,
  SaunaOverrideMessage,
  GetLockCodesRequest,
  SetLockCodeRequest,
  assertNever,
} from '@waverly/sauna-protocol';

export class SaunaScheduleClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private reconnectInterval = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  // Watchdog: Cloudflare in front of the sauna server idle-closes WebSockets
  // after ~100s and the FIN can fail to reach us, leaving a zombie socket.
  // If we don't receive any frame (message or pong) within this window, force
  // a reconnect.
  private readonly watchdogTimeoutMs = 90_000;
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      console.warn('Sauna schedule WebSocket watchdog: no traffic, forcing reconnect');
      if (this.ws) {
        try { this.ws.terminate(); } catch {}
      }
    }, this.watchdogTimeoutMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  connect(): void {
    try {
      const wsUrl = this.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://');
      const fullUrl = `${wsUrl}/ws/sauna-schedules`;

      console.log(`Connecting to sauna schedule WebSocket: ${fullUrl}`);
      this.ws = new WebSocket(fullUrl);

      this.ws.on('open', () => {
        console.log('Connected to sauna schedule WebSocket');
        this.isConnected = true;
        this.resetWatchdog();

        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      });

      this.ws.on('message', (data) => {
        this.resetWatchdog();
        let message: ServerToDaemonMessage;
        try {
          message = JSON.parse(data.toString()) as ServerToDaemonMessage;
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
          return;
        }
        this.handleMessage(message);
      });

      // Any ping/pong frame also counts as liveness.
      this.ws.on('ping', () => this.resetWatchdog());
      this.ws.on('pong', () => this.resetWatchdog());

      this.ws.on('close', () => {
        console.log('Sauna schedule WebSocket connection closed');
        this.isConnected = false;
        this.ws = null;
        this.clearWatchdog();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('Sauna schedule WebSocket error:', error.message);
        // Error is always followed by close for established connections,
        // but for connection failures close may not fire. Clean up and
        // ensure reconnect is scheduled.
        if (this.ws) {
          this.ws.removeAllListeners();
          this.ws = null;
        }
        this.isConnected = false;
        this.clearWatchdog();
        this.scheduleReconnect();
      });

    } catch (error) {
      console.error('Failed to connect to sauna schedule WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    console.log(`Scheduling reconnect in ${this.reconnectInterval}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  // Send a reply back to the server. Every outgoing message is a
  // DaemonToServerMessage, so the compiler forbids sending, say, a server->daemon
  // command back up this socket.
  private send(message: DaemonToServerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn(`Cannot send ${message.kind}: sauna schedule socket not open`);
    }
  }

  // Single typed entry point for everything arriving on the socket. The
  // exhaustive switch (assertNever default) guarantees every server->daemon
  // message kind — schedule, override, or lock admin — is handled distinctly.
  private handleMessage(message: ServerToDaemonMessage): void {
    console.log('Received WebSocket message:', message.kind);
    switch (message.kind) {
      case 'scheduleUpdate':
        void this.handleScheduleUpdate(message);
        break;
      case 'saunaOverride':
        void this.handleSaunaOverride(message);
        break;
      case 'getLockCodes':
        this.handleGetLockCodes(message);
        break;
      case 'setLockCode':
        void this.handleSetLockCode(message);
        break;
      default:
        assertNever(message);
    }
  }

  private handleGetLockCodes(message: GetLockCodesRequest): void {
    try {
      const locks = getLockCodes();
      this.send({ kind: 'lockCodesResult', requestId: message.requestId, ok: true, locks });
    } catch (e) {
      this.send({
        kind: 'lockCodesResult',
        requestId: message.requestId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async handleSetLockCode(message: SetLockCodeRequest): Promise<void> {
    const action = message.code.trim() === '' ? 'clear' : `set to ${message.code}`;
    console.log(`Manual lock code request: node ${message.nodeId} slot ${message.slot} — ${action}`);
    const result = await setLockCode(message.nodeId, message.slot, message.code);
    if (result.ok) {
      console.log(`Manual lock code ${action} on node ${message.nodeId} slot ${message.slot}: ${result.status}`);
    } else {
      console.error(`Manual lock code ${action} on node ${message.nodeId} slot ${message.slot} FAILED: ${result.error}`);
    }
    this.send({
      kind: 'setLockCodeResult',
      requestId: message.requestId,
      ok: result.ok,
      status: result.status,
      error: result.error,
    });
  }

  private async handleScheduleUpdate(message: ScheduleUpdateMessage): Promise<void> {
    try {
      const steamPeriods = message.plan.steam ?? [];
      console.log(`Applying schedule for ${message.planDate}...`);
      console.log(`  Small sauna: ${message.plan.small.length} slots`);
      console.log(`  Big sauna: ${message.plan.big.length} slots`);
      console.log(`  Steam room: ${steamPeriods.length} slots`);
      console.log(`  Bookings: ${message.bookings.length}`);

      // The steam room is handed its schedule before the saunas. Theirs goes out
      // over HTTP to four Shelly devices and any of them can hang or throw; the
      // TOLO schedule is a local assignment that cannot. Going first means an
      // unreachable sauna can't leave the steam room running yesterday's plan.
      const steam: SteamPeriod[] = steamPeriods.map(s => ({
        start: new Date(s.start),
        stop: new Date(s.stop),
        hotFrom: s.hotFrom ? new Date(s.hotFrom) : null,
      }));
      applySteamSchedule(steam, message.planDate);

      // Convert to OperationalPlan format
      const plan: OperationalPlan = {
        small: message.plan.small.map(s => ({
          start: new Date(s.start),
          stop: new Date(s.stop),
        })),
        big: message.plan.big.map(s => ({
          start: new Date(s.start),
          stop: new Date(s.stop),
        })),
      };

      // Convert bookings
      const bookings: Booking[] = message.bookings.map(b => ({
        bookingId: b.bookingId,
        unitId: b.unitId,
        start: new Date(b.start),
        stop: new Date(b.stop),
      }));

      await applyOperationalPlan(plan, bookings);

      console.log('Successfully applied Shelly schedules');
    } catch (error) {
      console.error('Failed to apply schedule update:', error);
    }
  }

  private async handleSaunaOverride(message: SaunaOverrideMessage): Promise<void> {
    try {
      console.log(`Setting ${message.sauna} override to ${message.override}`);
      if (message.sauna === 'steam') {
        setSteamOverride(message.override);
      } else {
        await setSaunaOverride(message.sauna, message.override);
      }
      console.log(`Successfully set ${message.sauna} override`);
    } catch (error) {
      console.error('Failed to set sauna override:', error);
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}
