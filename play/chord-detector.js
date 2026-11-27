// ChordDetector: the chord played with the left hand. Feed it the notes below the split (KeyboardInput does the
// split and the channel); it calls back when the chord changes.
//   recognise(notes)   static, pure: MIDI note numbers -> { root, type, bass } or null when no chord fits.
//                      Lowest note = bass. Root position wins over an inversion, a full chord over one with the 5th
//                      left out, then the order of ChordNames.TYPES (Am7/E over C6/E). But a complete major or minor
//                      triad in inversion wins over a chord with a note left out (F A D = Dm/F, not F6 without C). One note (or its octaves)
//                      is no chord. Two notes: a major third above the lowest = major, a minor third = minor,
//                      anything else no chord. Notes that only fit with the
//                      bass left out make a slash chord (D + C E G = Cadd9/D).
//   noteOn(n) / noteOff(n) / allOff()
//   chord              the current chord (null until the first one)
//   held()             the held notes, sorted
// Options: settleMs (10): a chord is only read once no new key came for this long, so a rolled chord gives one
// change, not three. memory (true): the chord stays when all keys are released, as on arranger keyboards; off: it
// goes to null. Only a key press reads the chord again; lifting one key of a chord changes nothing.
// timer: { set(fn, ms) -> handle, clear(handle) }, setTimeout by default (tests pass a fake one).
// Callbacks: onChord(chord) when it changes (null: released with memory off), onPress(chord) after every key press
// that gave a chord, even the same one (Sync Start), onKeys(held) on every key change.
// Loaded as a classic script (window.Arranger.ChordDetector) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const N = isNode ? require('./chord-names.js') : window.Arranger.ChordNames;
  const REAL_TIMER = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };

  function recognise(notes) {
    if (!notes || !notes.length) return null;
    const lowest = Math.min.apply(null, notes);
    const bass = N.pc(lowest);
    const pcs = [];
    notes.forEach((n) => { if (pcs.indexOf(N.pc(n)) < 0) pcs.push(N.pc(n)); });
    // Two different notes: a major third above the lowest is that major chord, a minor third its minor chord
    // (C + E = C, A + C = Am). Anything else with fewer than 3 different notes is no chord (octaves don't count).
    if (pcs.length === 2) {
      const up = N.pc(pcs.find((p) => p !== bass) - bass);
      if (up === 4) return { root: bass, type: '', bass: null };
      if (up === 3) return { root: bass, type: 'm', bass: null };
      return null;
    }
    if (pcs.length < 3) return null;
    const best = bestMatch(pcs, bass);
    if (best) return best;
    // The bass may be a note outside the chord (C/D): read the chord without it, keep it as the bass.
    if (pcs.length >= 4) {
      const upper = bestMatch(pcs.filter((p) => p !== bass), null);
      if (upper) return { root: upper.root, type: upper.type, bass };
    }
    return null;
  }

  // The best chord for a set of pitch classes; bass null = no bass preference (and no slash in the result).
  function bestMatch(pcs, bass) {
    let best = null, bestScore = Infinity;
    pcs.forEach((root) => {
      const rel = pcs.map((p) => N.pc(p - root));
      N.TYPES.forEach((t) => {
        if (!rel.every((i) => t.iv.indexOf(i) >= 0)) return;            // a note the chord doesn't have
        const missing = t.iv.filter((i) => rel.indexOf(i) < 0);
        if (!missing.every((i) => t.opt.indexOf(i) >= 0)) return;       // a note the chord can't do without
        // An inversion costs more than a note left out, except for a complete major or minor triad: F A D is Dm/F,
        // not F6 without its 5th (but C Eb A stays Cm6, D G C D7sus4).
        const triad = (t.id === '' || t.id === 'm') && !missing.length;
        const score = (bass != null && root !== bass ? (triad ? 30 : 100) : 0) + missing.length * 40 + t.rank;
        if (score < bestScore) { bestScore = score; best = { root, type: t.id, bass: bass != null && bass !== root ? bass : null }; }
      });
    });
    return best;
  }

  class ChordDetector {
    constructor(opts) {
      const o = opts || {};
      // 10 ms (was 30): every ms here is heard as the chord change coming late (2026-11-26, JazzSamba's strums).
      this.settleMs = o.settleMs == null ? 10 : o.settleMs;
      this.memory = o.memory == null ? true : !!o.memory;
      this.timer = o.timer || REAL_TIMER;
      this.onChord = o.onChord || (() => {});
      this.onPress = o.onPress || (() => {});
      this.onKeys = o.onKeys || (() => {});
      this.chord = null;
      this.notes = {};          // note -> true while held
      this.recent = {};         // notes pressed since the chord was last read (a stab released before it settled)
      this.pending = null;
    }
    held() { return Object.keys(this.notes).map(Number).sort((a, b) => a - b); }

    noteOn(n) {
      this.notes[n] = true; this.recent[n] = true;
      this.onKeys(this.held());
      if (this.pending != null) this.timer.clear(this.pending);
      this.pending = null;
      if (this.settleMs > 0) this.pending = this.timer.set(() => { this.pending = null; this.read(); }, this.settleMs);
      else this.read();
    }
    noteOff(n) {
      if (!this.notes[n]) return;
      delete this.notes[n];
      this.onKeys(this.held());
      if (this.held().length) return;
      // All released. A chord still settling is read now: a quick stab still counts.
      if (this.pending != null) { this.timer.clear(this.pending); this.pending = null; this.read(Object.keys(this.recent).map(Number)); }
      if (!this.memory && this.chord) { this.chord = null; this.onChord(null); }
    }
    allOff() {
      if (this.pending != null) this.timer.clear(this.pending);
      this.pending = null; this.notes = {}; this.recent = {};
      this.onKeys([]);
      if (!this.memory && this.chord) { this.chord = null; this.onChord(null); }
    }
    setMemory(on) {
      this.memory = !!on;
      if (!this.memory && !this.held().length && this.chord) { this.chord = null; this.onChord(null); }
    }

    read(notes) {
      const list = notes || this.held();
      this.recent = {};
      const c = recognise(list);
      if (!c) return;
      if (!N.sameChord(c, this.chord)) { this.chord = c; this.onChord(c); }
      this.onPress(c);
    }
  }
  ChordDetector.recognise = recognise;

  if (isNode) module.exports = ChordDetector;
  else (window.Arranger = window.Arranger || {}).ChordDetector = ChordDetector;
}());
