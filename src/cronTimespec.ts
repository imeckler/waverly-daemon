// Shelly schedules fire on the device's local wall clock. The timespec is built
// from the device's IANA zone at the target instant, so it stays right across
// DST changes, including a slot that falls on the other side of one.
export function cronTimespec(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(date).map(p => [p.type, Number(p.value)])
  );
  return `0 ${parts.minute} ${parts.hour} ${parts.day} ${parts.month} *`;
}
