import WebSocket from 'ws';

// Type definitions for booking messages (copied from scheduler)
type BookingMessage =
  | { kind: 'addAccess', code: string, start: number, stop: number }
  | { kind: 'removeAccess', code: string, start: number, stop: number };

interface WebSocketConfig {
  serverUrl: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
  pongTimeout?: number;
}

export class BookingWebSocketClient {
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  private messageHandlers: ((message: BookingMessage) => void)[] = [];

  constructor(config: WebSocketConfig) {
    this.config = {
      reconnectInterval: 5000,
      maxReconnectAttempts: -1, // Infinite reconnects
      // The booking connection is idle for long stretches (no traffic between
      // bookings) and the server sends no keepalives, so a silently-dropped
      // TCP connection would otherwise never fire 'close' and never reconnect.
      // Ping the server periodically and treat a missing pong as a dead socket.
      heartbeatInterval: 30000,
      pongTimeout: 10000,
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

          this.startHeartbeat();
          resolve();
        });

        // The server (per RFC 6455) answers our ping with a pong; receiving it
        // clears the outstanding pong-timeout so the connection is kept alive.
        this.ws.on('pong', () => {
          if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
          }
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
          this.stopHeartbeat();

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

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      // If a pong from the previous ping is still outstanding, the connection
      // is already being torn down; don't stack another timeout.
      if (this.pongTimer) {
        return;
      }

      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        console.warn('No pong from booking server; terminating stale connection to force reconnect');
        // terminate() (not close()) drops a half-open socket immediately and
        // fires 'close', which schedules a reconnect that re-pulls the snapshot.
        this.ws?.terminate();
      }, this.config.pongTimeout);
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
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

    this.stopHeartbeat();

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
