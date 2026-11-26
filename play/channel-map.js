// ChannelMap: which output channel each style part plays on, and what is sent there. No DOM.
//   new ChannelMap(saved)          saved: what toJSON() gave (settings for some parts), or nothing for the defaults
//   get(partId) -> { channel (1-16, 0 = off), program (send bank/program changes), mute, velocity (added to every
//                    note's velocity, -80..+80; the result stays 1-127) }
//   velocityOf(partId, v)          a note's velocity with the part's boost
//   set(partId, changes)           channel(partId) -> 1-16 or 0 when off or muted
//   voiceMessages(part)            the messages that set a part's sound on its channel (bank, program, volume, pan,
//                                  reverb, chorus), for a GM synth. Non-drum parts get bank 0/0 and the program; drum
//                                  parts only get a program, a GM drum kit (Yamaha's bank 127 kits are often
//                                  placeholders a GM player doesn't have). Nothing when program changes are off.
//   filter(part, event) -> event | null   a pattern's own program / bank changes: kept for GM, dropped when program
//                                  changes are off.
// The defaults suit a GM SoundFont with channel 1 left for the right hand: drums 10, bass 2, chords 3-4, pad 5,
// phrases 6-8. The host routes the channels (e.g. 10 to a drum plugin, with program changes off for it).
// Loaded as a classic script (window.Arranger.ChannelMap) or with require() in Node (tests).
(function () {
  'use strict';

  const DEFAULTS = {
    rhythm1: 10, rhythm2: 10, drums: 10,
    bass: 2,
    chord1: 3, chord2: 4, acc1: 3, acc2: 4,
    pad: 5, acc3: 5,
    phrase1: 6, phrase2: 7, acc4: 6, acc5: 7, acc6: 8,
  };
  // GM2 / XG drum kits a GM player is likely to have; anything else plays the standard kit.
  const GM_KITS = [0, 8, 16, 24, 25, 32, 40, 48, 56];

  class ChannelMap {
    constructor(saved) {
      this.parts = {};
      const s = saved || {};
      Object.keys(s).forEach((id) => { this.parts[id] = Object.assign({}, s[id]); });
    }
    get(id) {
      const p = this.parts[id] || {};
      return {
        channel: p.channel != null ? p.channel : (DEFAULTS[id] || 0),
        program: p.program != null ? !!p.program : true,
        mute: !!p.mute,
        velocity: Math.max(-80, Math.min(80, Number(p.velocity) || 0)),
      };
    }
    velocityOf(id, v) { return Math.max(1, Math.min(127, Math.round(v + this.get(id).velocity))); }
    set(id, changes) {
      const cur = this.get(id);
      this.parts[id] = Object.assign(cur, changes);
      return this.parts[id];
    }
    channel(id) { const p = this.get(id); return p.mute ? 0 : p.channel; }
    toJSON() { return JSON.parse(JSON.stringify(this.parts)); }

    voiceMessages(part) {
      const ch = this.channel(part.id);
      if (!ch || !this.get(part.id).program) return [];
      const c = ch - 1, v = part.voice || {}, out = [];
      if (part.role === 'drums') {
        if (v.program != null) out.push([0xC0 | c, GM_KITS.indexOf(v.program) >= 0 ? v.program : 0]);
      } else if (v.program != null) {
        out.push([0xB0 | c, 0, 0], [0xB0 | c, 32, 0], [0xC0 | c, v.program]);
      }
      [[7, 'volume'], [10, 'pan'], [91, 'reverb'], [93, 'chorus']].forEach(([cc, key]) => {
        if (v[key] != null) out.push([0xB0 | c, cc, v[key]]);
      });
      return out;
    }

    filter(part, ev) {
      const sendProgram = this.get(part.id).program;
      const isBank = ev.type === 'cc' && (ev.cc === 0 || ev.cc === 32);
      if (ev.type === 'program') {
        if (!sendProgram) return null;
        if (part.role === 'drums' && GM_KITS.indexOf(ev.program) < 0) return Object.assign({}, ev, { program: 0 });
        return ev;
      }
      if (isBank) return null;                 // GM: bank 0 is sent with the voice; the style's banks are Yamaha's
      return ev;
    }
  }
  ChannelMap.DEFAULTS = DEFAULTS;
  ChannelMap.GM_KITS = GM_KITS;

  if (typeof module !== 'undefined' && module.exports) module.exports = ChannelMap;
  else (window.Arranger = window.Arranger || {}).ChannelMap = ChannelMap;
}());
