// Outbox: MIDI messages for a port, kept in the page until their time and then sent on.
// For PLAY IN BACKGROUND, where the player sends 1.5 s ahead (its timer runs about once a second there):
//   - a MIDI port: MIDIWeb (TestFlight, iPhone 14) played timestamps that far ahead unevenly ("a drunken drummer", 2026-11-26),
//     while the page's audio keeps running on time. So the page keeps the messages and a silent audio callback
//     (every ~12 ms) sends the ones that are due, without timestamps.
//   - the built-in synth keeps time by itself, but what it was sent it plays: after a chord change, the old chord's
//     notes it already had rang into the new one, late. Its own audio blocks pass them on 120 ms ahead, timed.
//   push(port, data, time)  keep one (time in clock ms; none or past: sent at the next flush)
//                           A note-off pushed for a note-on still waiting at the same time (a note the player
//                           ends before it starts: a chord change, STOP) takes it back: neither is sent.
//   flush(now, timed)       send everything due by now, in time order; timed: with their timestamps
//   all(late)               send everything now, with timestamps (back in front); late: note-ons due before this
//                           time are dropped instead (the audio stopped: they'd all sound at once)
//   dropNotes()             STOP: forget the note-ons still waiting (their note-offs, controllers, clock stay)
//   size
// Loaded as a classic script (window.Arranger.Outbox) or with require() in Node (tests).
(function () {
  'use strict';

  class Outbox {
    constructor() { this.q = []; }
    get size() { return this.q.length; }
    push(port, data, time) {
      const m = { port, data: Array.from(data), time: time == null ? -Infinity : time };
      const d = m.data, t = d[0] & 0xF0;
      if (t === 0x80 || (t === 0x90 && d[2] === 0)) {
        const on = this.q.findIndex((x) => x.port === port && x.time === m.time && x.data[0] === (0x90 | (d[0] & 0x0F)) &&
          x.data[1] === d[1] && x.data[2] > 0);
        if (on >= 0) { this.q.splice(on, 1); return; }
      }
      // Mostly in order already (the player sends in time order): insert from the end.
      let i = this.q.length;
      while (i > 0 && this.q[i - 1].time > m.time) i--;
      this.q.splice(i, 0, m);
    }
    flush(now, timed) {
      let n = 0;
      while (n < this.q.length && this.q[n].time <= now) n++;
      if (!n) return 0;
      const due = this.q.splice(0, n);
      due.forEach((m) => {
        try { if (timed && m.time !== -Infinity) m.port.send(m.data, m.time); else m.port.send(m.data); } catch (e) { /* port gone */ }
      });
      return n;
    }
    all(late) {
      const rest = late == null ? this.q : this.q.filter((m) => !(m.time < late && (m.data[0] & 0xF0) === 0x90 && m.data[2] > 0));
      this.q = [];
      rest.forEach((m) => { try { if (m.time === -Infinity) m.port.send(m.data); else m.port.send(m.data, m.time); } catch (e) { /* port gone */ } });
    }
    dropNotes() {
      this.q = this.q.filter((m) => !((m.data[0] & 0xF0) === 0x90 && m.data[2] > 0));
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Outbox;
  else (window.Arranger = window.Arranger || {}).Outbox = Outbox;
}());
