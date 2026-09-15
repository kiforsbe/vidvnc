// Browser counters are cumulative. Never mistake the first sample or a reset
// for a new request; bound recovery to avoid an IDR storm under sustained loss.
export class Recovery {
  constructor() {
    this.previous = null;
    this.last = -Infinity;
  }
  observe(sample, now) {
    const current = {};
    for (const name of ['pliCount', 'firCount']) {
      current[name] = Number.isSafeInteger(sample[name]) && sample[name] >= 0 ? sample[name] : null;
    }
    const increased =
      this.previous &&
      Object.keys(current).some(
        (name) =>
          current[name] !== null &&
          this.previous[name] !== null &&
          current[name] > this.previous[name],
      );
    this.previous = current;
    if (!increased || now - this.last < 3000) return false;
    this.last = now;
    return true;
  }
}
