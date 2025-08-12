import WebSocket from 'ws';

// Type definitions for booking messages (copied from scheduler)
type BookingMessage =
  | { kind: 'addAccess', code: string, start: number, stop: number }
  | { kind: 'removeAccess', code: string, start: number, stop: number };

interface WebSocketConfig {
  serverUrl: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export class BookingWebSocketClient {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  private messageHandlers: ((message: BookingMessage) => void)[] = [];

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnectInterval: 5000,
      maxReconnectAttempts: -1, // Infinite reconnects
      ...config
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.config.serverUrl.replace('http://', 'ws://').replace('https://', 'wss://');
        const fullUrl = `${wsUrl}/ws/bookings`;

        console.log(`Connecting to WebSocket: ${fullUrl}`);
        this.ws = new WebSocket(fullUrl);

        this.ws.on('open', () => {
          console.log('WebSocket connected to booking server');
          this.isConnected = true;
          this.reconnectAttempts = 0;

          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }

          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const message: BookingMessage = JSON.parse(data.toString());
            console.log('Received booking message:', message);

            // Call all registered message handlers
            this.messageHandlers.forEach(handler => {
              try {
                handler(message);
              } catch (error) {
                console.error('Error in message handler:', error);
              }
            });
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
          }
        });

        this.ws.on('close', (code, reason) => {
          console.log(`WebSocket connection closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.ws = null;

          if (this.config.maxReconnectAttempts === -1 ||
            this.reconnectAttempts < this.config.maxReconnectAttempts!) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          if (!this.isConnected) {
            reject(error);
          }
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    this.reconnectAttempts++;
    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${this.config.reconnectInterval}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => {
        console.error('Reconnect failed:', error);
      });
    }, this.config.reconnectInterval);
  }

  onMessage(handler: (message: BookingMessage) => void): void {
    this.messageHandlers.push(handler);
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
