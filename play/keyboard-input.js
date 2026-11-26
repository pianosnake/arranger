// KeyboardInput: the keyboard's MIDI messages, split into the left hand (chords) and the right hand.
//   handle(data)   one MIDI message (array of bytes). Returns true if it was the keyboard's (right channel).
//                  Notes below `split` go to lower.noteOn / noteOff; the rest, and every other channel message
//                  (sustain, bend, ...), go to upper(data), for the right-hand pass-through. A note-off goes where
//                  its note-on went, even if the split moved in between, so nothing hangs. CC 123 / 120 (all notes
//                  off / all sound off) also release the left hand.
//   channel        1-16, or 0 = any (omni)
//   split          the lowest right-hand note (MIDI number); default 55 (G3, C4 = 60)
//   learn()        the next key pressed becomes the split (and isn't played); onSplit(note) is called
// Loaded as a classic script (window.Arranger.KeyboardInput) or with require() in Node (tests).
(function () {
  'use strict';

  class KeyboardInput {
    constructor(opts) {
      const o = opts || {};
      this.channel = o.channel || 0;
      this.split = o.split == null ? 55 : o.split;
      this.lower = o.lower || { noteOn() {}, noteOff() {}, allOff() {} };
      this.upper = o.upper || (() => {});
      this.onSplit = o.onSplit || (() => {});
      this.learning = false;
      this.down = {};        // note -> 'lower' | 'upper' | 'learn', for the notes held now
    }
    learn() { this.learning = true; }
    cancelLearn() { this.learning = false; }

    handle(data) {
      if (!data || !data.length) return false;
      const status = data[0];
      if (status < 0x80 || status >= 0xF0) return false;
      if (this.channel && (status & 0x0F) + 1 !== this.channel) return false;
      const type = status & 0xF0, note = data[1];
      if (type === 0x90 && data[2] > 0) {
        if (this.learning) {
          this.learning = false; this.split = note; this.down[note] = 'learn';
          this.onSplit(note);
        } else if (note < this.split) { this.down[note] = 'lower'; this.lower.noteOn(note); }
        else { this.down[note] = 'upper'; this.upper(data); }
        return true;
      }
      if (type === 0x80 || type === 0x90) {
        const went = this.down[note] || (note < this.split ? 'lower' : 'upper');
        delete this.down[note];
        if (went === 'lower') this.lower.noteOff(note);
        else if (went === 'upper') this.upper(data);
        return true;
      }
      if (type === 0xB0 && (data[1] === 123 || data[1] === 120)) {
        Object.keys(this.down).forEach((n) => { if (this.down[n] === 'lower') delete this.down[n]; });
        if (this.lower.allOff) this.lower.allOff();
      }
      this.upper(data);
      return true;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = KeyboardInput;
  else (window.Arranger = window.Arranger || {}).KeyboardInput = KeyboardInput;
}());
