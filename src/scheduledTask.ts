export class ScheduledTask {
  id: NodeJS.Timeout;
  finalState: 'finishedEarly' | 'cancelled' | 'occurred' | undefined;
  f: () => void;

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
    const now = new Date();
    this.f = f;
    const delay = Math.max(0, t.getTime() - now.getTime());

    if (delay == 0) {
      this.finalState = 'occurred';
      f();
      // To please the type-checker
      this.id = global.setTimeout(() => { }, 0);
    } else {
      this.id = global.setTimeout(() => {
        if (this.finalState == undefined) {
          this.finalState = 'occurred';
          f();
        }
      }, delay);
    }

  }
}


