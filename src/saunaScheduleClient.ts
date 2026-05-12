import WebSocket from 'ws';
import { applyOperationalPlan, Booking, OperationalPlan, setSaunaOverride } from './shellyController.js';

interface ScheduleUpdateMessage {
  kind: 'scheduleUpdate';
  planDate: string;
  plan: {
    small: Array<{ start: string; stop: string }>;
    big: Array<{ start: string; stop: string }>;
  };
  bookings: Array<{
    bookingId: number;
    unitId: number;
    start: string;
    stop: string;
  }>;
}

interface SaunaOverrideMessage {
  kind: 'saunaOverride';
  sauna: 'small' | 'big';
  override: 'on' | 'off' | 'none';
}

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
        try {
          const message = JSON.parse(data.toString());
          console.log('Received WebSocket message:', message.kind);

          if (message.kind === 'scheduleUpdate') {
            this.handleScheduleUpdate(message as ScheduleUpdateMessage);
          } else if (message.kind === 'saunaOverride') {
            this.handleSaunaOverride(message as SaunaOverrideMessage);
          }
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
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

  private async handleScheduleUpdate(message: ScheduleUpdateMessage): Promise<void> {
    try {
      console.log(`Applying schedule for ${message.planDate}...`);
      console.log(`  Small sauna: ${message.plan.small.length} slots`);
      console.log(`  Big sauna: ${message.plan.big.length} slots`);
      console.log(`  Bookings: ${message.bookings.length}`);

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
      console.log(`Setting ${message.sauna} sauna override to ${message.override}`);
      await setSaunaOverride(message.sauna, message.override);
      console.log(`Successfully set ${message.sauna} sauna override`);
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
