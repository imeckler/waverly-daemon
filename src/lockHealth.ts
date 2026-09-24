import { ZWaveNode } from 'zwave-js';
import { triggerIncident, resolveIncident } from './pagerduty';

// ---------------------------------------------------------------------------
// Lock liveness.
//
// A "successful" write to a lock only means the lock's radio acknowledged the
// frame. Over S0 (the Kwikset) there is no supervision, and zwave-js then
// optimistically writes the value we *sent* into its cache — so neither the
// setValue result nor the cache says whether the lock stored the code. The
// only proof is the lock answering a query.
//
// Every LockManager owns a LockHealth. It records when the lock last answered
// at the application level (a User Code report, a notification it pushed), how
// many commands have gone out since, and turns silence or an unconfirmed
// write into a PagerDuty incident that resolves itself once the lock answers
// again.
// ---------------------------------------------------------------------------

export interface Notifier {
  trigger(summary: string, dedupKey: string, details: Record<string, unknown>): Promise<void>;
  resolve(dedupKey: string): Promise<void>;
}

export const pagerDutyNotifier: Notifier = {
  async trigger(summary, dedupKey, details) {
    await triggerIncident(summary, 'critical', dedupKey, details);
  },
  async resolve(dedupKey) {
    await resolveIncident(dedupKey);
  },
};

/** A lock that has not answered for this long gets probed by the watchdog. */
export const SILENCE_LIMIT_MS = 2 * 60 * 60 * 1000;
/** How often the watchdog looks at every lock. */
export const WATCHDOG_INTERVAL_MS = 30 * 60 * 1000;
/** How soon after start every lock is probed once, whether or not it is silent. */
export const STARTUP_PROBE_DELAY_MS = 2 * 60 * 1000;
/** A lock is re-interviewed at most this often. */
export const HEAL_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Hide a door code in anything that leaves the daemon. */
export function maskCode(code: string): string {
  return code.length <= 2 ? '**' : code.slice(0, 2) + '*'.repeat(code.length - 2);
}

export class LockHealth {
  /** Last time the lock answered a query or pushed a report; null since start. */
  lastHeardAt: number | null = null;
  lastCommandAt: number | null = null;
  commandsSinceHeard = 0;

  /** Last time a re-interview was attempted; null if never. */
  lastHealAt: number | null = null;

  private unresponsiveOpen = false;
  private unconfirmedOpen = false;
  private readonly startedAt: number;

  constructor(
    private readonly lock: ZWaveNode,
    private readonly notifier: Notifier = pagerDutyNotifier,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.startedAt = clock();
    // Reports the lock pushes on its own (keypad events, low battery, ...) are
    // proof of life too. 'value updated' is deliberately not used: the driver
    // fires it for its own optimistic updates after our writes.
    const heard = () => this.recordHeard();
    const on = (lock as unknown as { on?: (ev: string, fn: () => void) => void }).on;
    if (typeof on === 'function') {
      on.call(lock, 'notification', heard);
      on.call(lock, 'value notification', heard);
    }
  }

  now(): number { return this.clock(); }

  /** Whether enough time has passed since the last re-interview to try another. */
  canHeal(now: number = this.clock()): boolean {
    return this.lastHealAt === null || now - this.lastHealAt >= HEAL_MIN_INTERVAL_MS;
  }

  describe(): string {
    const label = (this.lock as unknown as { label?: unknown }).label;
    return typeof label === 'string' && label !== '' ? `Lock ${this.lock.id} (${label})` : `Lock ${this.lock.id}`;
  }

  get dedupUnresponsive(): string { return `lock-${this.lock.id}-unresponsive`; }
  get dedupUnconfirmed(): string { return `lock-${this.lock.id}-write-unconfirmed`; }

  /** A command (write, clear, or probe) is about to go out. */
  recordCommand(): void {
    this.lastCommandAt = this.clock();
    this.commandsSinceHeard += 1;
  }

  /** The lock answered at the application level. Closes any silence incident. */
  recordHeard(): void {
    this.lastHeardAt = this.clock();
    this.commandsSinceHeard = 0;
    if (this.unresponsiveOpen) {
      this.unresponsiveOpen = false;
      console.log(`${this.describe()}: answering again`);
      this.notifier.resolve(this.dedupUnresponsive)
        .catch(e => console.error(`${this.describe()}: failed to resolve unresponsive incident:`, e));
    }
  }

  /** A write or clear went out but the lock's answer does not show it. */
  recordUnconfirmed(what: string, details: Record<string, unknown>): void {
    this.unconfirmedOpen = true;
    const summary = `${this.describe()}: ${what} was not confirmed by the lock`;
    console.error(summary, details);
    this.notifier.trigger(summary, this.dedupUnconfirmed, { lock: this.lock.id, ...details })
      .catch(e => console.error(`${this.describe()}: failed to report unconfirmed write:`, e));
  }

  /** A write or clear was confirmed by the lock's own answer. */
  recordConfirmed(): void {
    this.recordHeard();
    if (this.unconfirmedOpen) {
      this.unconfirmedOpen = false;
      this.notifier.resolve(this.dedupUnconfirmed)
        .catch(e => console.error(`${this.describe()}: failed to resolve unconfirmed-write incident:`, e));
    }
  }

  /** Whether the lock has been quiet long enough that the watchdog should probe it. */
  isSilent(now: number = this.clock()): boolean {
    const since = this.lastHeardAt ?? this.startedAt;
    return now - since >= SILENCE_LIMIT_MS;
  }

  /** The watchdog probed the lock and got nothing back. */
  recordUnresponsive(healAttempted: boolean): void {
    const now = this.clock();
    const since = this.lastHeardAt;
    const sinceText = since === null
      ? `since the daemon started ${describeAge(now - this.startedAt)} ago`
      : `for ${describeAge(now - since)} (last answer ${new Date(since).toISOString()})`;
    const healText = healAttempted
      ? '; a re-interview did not help — it needs hands on: pull its batteries, and if it stays silent exclude and re-include it'
      : '';
    const summary = `${this.describe()} is not answering the controller ${sinceText}; ${this.commandsSinceHeard} command(s) sent meanwhile${healText}`;
    console.error(summary);
    this.unresponsiveOpen = true;
    this.notifier.trigger(summary, this.dedupUnresponsive, {
      lock: this.lock.id,
      lastHeardAt: since === null ? null : new Date(since).toISOString(),
      commandsSinceHeard: this.commandsSinceHeard,
      reinterviewAttempted: healAttempted,
    }).catch(e => console.error(`${this.describe()}: failed to report unresponsive lock:`, e));
  }
}

function describeAge(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface Probeable {
  health: LockHealth;
  /** Ask the lock something and report whether it answered. */
  probe(): Promise<boolean>;
  /**
   * Try to bring a silent lock back without hands on it (a re-interview), and
   * report whether it answers afterwards.
   */
  heal(): Promise<boolean>;
}

export interface WatchdogOptions {
  intervalMs?: number;
  initialDelayMs?: number;
}

/**
 * Probe every lock once shortly after start, then periodically probe any lock
 * that has been silent. Returns a function that stops the watchdog.
 */
export function startLockWatchdog(locks: Probeable[] | (() => Probeable[]), options: WatchdogOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? WATCHDOG_INTERVAL_MS;
  const initialDelayMs = options.initialDelayMs ?? STARTUP_PROBE_DELAY_MS;
  const current = typeof locks === 'function' ? locks : () => locks;
  const tick = (force: boolean) => {
    for (const lock of current()) {
      checkLiveness(lock, force).catch(e => console.error(`${lock.health.describe()}: liveness check failed:`, e));
    }
  };
  const first = setTimeout(() => tick(true), initialDelayMs);
  const timer = setInterval(() => tick(false), intervalMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}

/**
 * Probe a silent lock (or any lock, when forced). A lock that does not answer
 * is re-interviewed once per HEAL_MIN_INTERVAL_MS; if it still does not answer
 * it is paged.
 */
export async function checkLiveness(lock: Probeable, force = false): Promise<void> {
  const health = lock.health;
  if (!force && !health.isSilent()) return;
  console.log(`${health.describe()}: ${force ? 'probing' : 'quiet for a while; probing'}`);
  if (await lock.probe()) {
    health.recordHeard();
    return;
  }
  let healAttempted = false;
  if (health.canHeal()) {
    healAttempted = true;
    if (await lock.heal()) {
      health.recordHeard();
      return;
    }
  } else {
    console.log(`${health.describe()}: re-interviewed recently; not trying again yet`);
  }
  health.recordUnresponsive(healAttempted);
}
