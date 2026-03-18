import WebSocket from 'ws';
import { applyOperationalPlan, Booking, OperationalPlan } from './shellyController.js';

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

export class SaunaScheduleClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private reconnectInterval = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
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

        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      });

      this.ws.on('message', (data) => {
        try {
          const message: ScheduleUpdateMessage = JSON.parse(data.toString());
          console.log('Received schedule update:', message.kind);

          if (message.kind === 'scheduleUpdate') {
            this.handleScheduleUpdate(message);
          }
        } catch (error) {
          console.error('Failed to parse schedule message:', error);
        }
      });

      this.ws.on('close', () => {
        console.log('Sauna schedule WebSocket connection closed');
        this.isConnected = false;
        this.ws = null;
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('Sauna schedule WebSocket error:', error);
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
