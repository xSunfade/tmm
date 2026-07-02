export class TimeController {
  private nowMs: number;

  constructor(initialIso = '2026-01-01T00:00:00.000Z') {
    this.nowMs = new Date(initialIso).getTime();
  }

  freeze(iso: string) {
    this.nowMs = new Date(iso).getTime();
  }

  jumpDays(days: number) {
    const d = new Date(this.nowMs);
    d.setUTCDate(d.getUTCDate() + days);
    this.nowMs = d.getTime();
  }

  jumpBackDays(days: number) {
    this.jumpDays(-days);
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  isoDate(): string {
    return this.now().toISOString().slice(0, 10);
  }
}
