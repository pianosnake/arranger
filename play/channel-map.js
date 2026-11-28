// ChannelMap: which output channel each style part plays on, and what is sent there. No DOM.
//   new ChannelMap(saved, sounds)  saved: what toJSON() gave (settings for some parts), or nothing for the defaults;
//                                  sounds: what soundsJSON() gave
//   get(partId) -> { channel (1-16, 0 = off), program (send bank/program changes), mute, velocity (added to every
//                    note's velocity, -80..+80; the result stays 1-127) }
//   velocityOf(partId, v)          a note's velocity with the part's boost
//   set(partId, changes)           channel(partId) -> 1-16 or 0 when off or muted
//   voiceMessages(part)            the messages that set a part's sound on its channel (bank, program, volume, pan,
//                                  reverb, chorus), for a GM synth. Non-drum parts get bank 0/0 and the program; drum
//                                  parts only get a program, a GM drum kit (Yamaha's bank 127 kits are often
//                                  placeholders a GM player doesn't have). Nothing when program changes are off.
//   filter(part, event) -> event | null   a pattern's own program / bank changes: kept for GM, dropped when program
//                                  changes are off or the channel's sound is overridden.
//   sound(ch) -> program | null    a channel's sound override: every part on channel ch plays GM program `program`
//                                  (on channel 10: that GM drum kit) instead of the style's, whatever the style sends
//   setSound(ch, program | null)   sets or clears it; soundsJSON() -> { ch: program } to save
//   isDrumChannel(ch)              channel 10: overrides there are drum kits
//   ChannelMap.gmProgram(msb, program, role)   the GM program for a Yamaha voice (see MEGA below)
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
  // Yamaha's Mega Voices (Tyros, PSR-S: bank MSB 8) number their own guitars and basses: sent to a GM synth with bank 0
  // and the same program, a Mega guitar on program 0-7 played as a piano and a Mega bass on 16-19 as an organ
  // (2026-11-27: 897 of 2,697 Yamaha styles here use MSB 8). Mapped by family, as Yamaha's exact list isn't at hand:
  // programs 0-15 are guitars (0-7 in GM's guitar order: nylon, steel, jazz, clean, muted, overdriven, distortion,
  // harmonics; past that a clean guitar), 16-31 basses (finger, finger, pick, fretless; past that finger). From 32 up
  // MSB 8 programs follow GM's families (strings on 48, trumpet on 56) and are kept. Other Yamaha banks (XG variations,
  // 104 Live / Cool, 63) follow GM's families too. A bass part on a Mega guitar number still gets a bass.
  const MEGA_BASS = { 16: 33, 17: 33, 18: 34, 19: 35 };
  function gmProgram(msb, program, role) {
    if (program == null || msb !== 8 || program >= 32) return program;
    if (program >= 16 || role === 'bass') return MEGA_BASS[program] != null ? MEGA_BASS[program] : 33;
    return program < 8 ? 24 + program : 27;
  }

  class ChannelMap {
    constructor(saved, sounds) {
      this.parts = {};
      const s = saved || {};
      Object.keys(s).forEach((id) => { this.parts[id] = Object.assign({}, s[id]); });
      this.sounds = {};
      Object.keys(sounds || {}).forEach((ch) => this.setSound(Number(ch), sounds[ch]));
    }
    sound(ch) { return this.sounds[ch] != null ? this.sounds[ch] : null; }
    setSound(ch, program) {
      ch = Number(ch);
      if (!(ch >= 1 && ch <= 16)) return;
      const p = program == null || program === '' ? NaN : Number(program);
      if (p >= 0 && p <= 127 && Math.floor(p) === p) this.sounds[ch] = p; else delete this.sounds[ch];
    }
    soundsJSON() { return Object.assign({}, this.sounds); }
    isDrumChannel(ch) { return Number(ch) === 10; }
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
      if (!ch) return [];
      const c = ch - 1, v = part.voice || {}, out = [];
      const over = this.sound(ch);
      if (over != null) {
        // The channel's override, sent even when the part's program changes are off (the user picked it).
        if (part.role === 'drums' || this.isDrumChannel(ch)) out.push([0xC0 | c, over]);
        else out.push([0xB0 | c, 0, 0], [0xB0 | c, 32, 0], [0xC0 | c, over]);
        if (!this.get(part.id).program) return out;
      } else if (!this.get(part.id).program) {
        return [];
      } else if (part.role === 'drums') {
        if (v.program != null) out.push([0xC0 | c, GM_KITS.indexOf(v.program) >= 0 ? v.program : 0]);
      } else if (v.program != null) {
        out.push([0xB0 | c, 0, 0], [0xB0 | c, 32, 0], [0xC0 | c, gmProgram(v.msb, v.program, part.role)]);
      }
      [[7, 'volume'], [10, 'pan'], [91, 'reverb'], [93, 'chorus']].forEach(([cc, key]) => {
        if (v[key] != null) out.push([0xB0 | c, cc, v[key]]);
      });
      return out;
    }

    filter(part, ev) {
      const sendProgram = this.get(part.id).program;
      const isBank = ev.type === 'cc' && (ev.cc === 0 || ev.cc === 32);
      // A pattern's own bank select isn't sent (GM: bank 0 goes with the voice), but its MSB is remembered for the part,
      // so a program change after it is mapped as the voice's is (a Mega guitar in a fill).
      if (isBank && ev.cc === 0) { this.bankMsb = this.bankMsb || {}; this.bankMsb[part.id] = ev.value; }
      if (ev.type === 'program') {
        if (!sendProgram || this.sound(this.channel(part.id)) != null) return null;
        if (part.role === 'drums') return GM_KITS.indexOf(ev.program) < 0 ? Object.assign({}, ev, { program: 0 }) : ev;
        const msb = this.bankMsb && this.bankMsb[part.id] != null ? this.bankMsb[part.id] : (part.voice || {}).msb;
        const gm = gmProgram(msb, ev.program, part.role);
        return gm === ev.program ? ev : Object.assign({}, ev, { program: gm });
      }
      if (isBank) return null;
      return ev;
    }
  }
  ChannelMap.DEFAULTS = DEFAULTS;
  ChannelMap.GM_KITS = GM_KITS;
  ChannelMap.gmProgram = gmProgram;

  if (typeof module !== 'undefined' && module.exports) module.exports = ChannelMap;
  else (window.Arranger = window.Arranger || {}).ChannelMap = ChannelMap;
}());
