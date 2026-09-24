// setTimeout takes a 32-bit signed delay; anything longer fires immediately
// (with a TimeoutOverflowWarning). Bookings are routinely made further out
// than that, so long waits are chained.
const MAX_DELAY_MS = 2 ** 31 - 1;

export class ScheduledTask {
  id: NodeJS.Timeout;
  finalState: 'finishedEarly' | 'cancelled' | 'occurred' | undefined;
  f: () => void;
  private t: number;

  cancel() {
    if (this.finalState == undefined) {
      this.finalState = 'cancelled';
      clearTimeout(this.id);
    }
  }

  finishEarly() {
    if (this.finalState == undefined) {
      this.finalState = 'finishedEarly';
      clearTimeout(this.id);
      this.f();
    }
  }

  constructor(t: Date, f: () => void) {
    this.finalState = undefined;
    this.f = f;
    this.t = t.getTime();
    // To please the type-checker; replaced by arm() unless firing now.
    this.id = global.setTimeout(() => { }, 0);
    this.arm();
  }

  private arm() {
    const delay = this.t - Date.now();
    if (delay <= 0) {
      if (this.finalState == undefined) {
        this.finalState = 'occurred';
        this.f();
      }
      return;
    }
    this.id = global.setTimeout(() => this.arm(), Math.min(delay, MAX_DELAY_MS));
  }
}
