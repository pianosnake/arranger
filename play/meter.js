// Meter: bars, pulses and beat groups for any time signature (3/4, 6/8, 7/8, 10/8, 11/8, 7/16, ...). No DOM.
//   new Meter(num, den, ppq, groups?)
//   barTicks           ticks in a bar: num × ppq × 4 / den (11/8 at ppq 96 = 528)
//   pulseTicks         ticks in one 1/den note
//   groups             pulses per group, e.g. 11/8 = [3,3,3,2]; default from Meter.defaultGroups
//   position(tick)     { bar, pulse, group, first } for a tick counted from a bar line: bar number (0-based),
//                      pulse in the bar, the group it's in, and whether it starts its group
//   nextBeat(tick)     the first beat (group start) after tick, counted from a bar line
// Loaded as a classic script (window.Arranger.Meter) or with require() in Node (tests).
(function () {
  'use strict';

  // Default beat groups:
  //   - 2/4, 3/4, 4/4, ... (den <= 4): each pulse is its own beat.
  //   - Compound meters (6/8, 9/8, 12/8, and the same over 16): groups of 3.
  //   - Other eighth and sixteenth meters: threes first, then twos (5/8 = 3+2, 7/8 = 3+2+2, 10/8 = 3+3+2+2,
  //     11/8 = 3+3+3+2).
  //   - A style can set its own grouping (Balkan 7/8 is often 2+2+3, 9/8 often 2+2+2+3).
  function defaultGroups(num, den) {
    if (den <= 4 || num <= 3) return Array.from({ length: den <= 4 ? num : 1 }, () => (den <= 4 ? 1 : num));
    if (num % 3 === 0) return Array.from({ length: num / 3 }, () => 3);
    const out = [];
    let left = num;
    while (left > 4 && (left - 3) !== 1) { out.push(3); left -= 3; }
    while (left >= 3 && left % 2 === 1) { out.push(3); left -= 3; }
    while (left > 0) { out.push(2); left -= 2; }
    return out;
  }

  class Meter {
    constructor(num, den, ppq, groups) {
      this.num = num; this.den = den; this.ppq = ppq;
      this.pulseTicks = ppq * 4 / den;
      this.barTicks = Math.round(num * this.pulseTicks);
      const g = groups && groups.length && groups.reduce((a, b) => a + b, 0) === num ? groups.slice() : defaultGroups(num, den);
      this.groups = g;
      this.groupOf = [];                 // pulse -> group index
      this.starts = [];                  // pulse -> starts its group
      g.forEach((size, k) => { for (let p = 0; p < size; p++) { this.groupOf.push(k); this.starts.push(p === 0); } });
      this.beatTicks = [];               // ticks of the group starts within a bar
      let at = 0;
      g.forEach((size) => { this.beatTicks.push(Math.round(at * this.pulseTicks)); at += size; });
    }
    position(tick) {
      const t = Math.max(0, tick);
      const bar = Math.floor(t / this.barTicks);
      const pulse = Math.min(this.num - 1, Math.floor((t - bar * this.barTicks) / this.pulseTicks));
      return { bar, pulse, group: this.groupOf[pulse], first: this.starts[pulse] };
    }
    // 'ms per quarter note' helpers: tempo is always in quarter notes per minute (what both formats store).
    nextBeat(tick) {
      const bar = Math.floor(tick / this.barTicks + 1e-9), inBar = tick - bar * this.barTicks;
      const b = this.beatTicks.find((t) => t > inBar + 1e-6);
      return bar * this.barTicks + (b == null ? this.barTicks : b);
    }
    msPerTick(bpm) { return 60000 / (bpm * this.ppq); }
    toString() { return this.num + '/' + this.den; }
  }
  Meter.defaultGroups = defaultGroups;

  if (typeof module !== 'undefined' && module.exports) module.exports = Meter;
  else (window.Arranger = window.Arranger || {}).Meter = Meter;
}());
