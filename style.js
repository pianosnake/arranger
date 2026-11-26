// Style: the common structure both readers (sty-reader.js, stl-reader.js) produce, and the player uses.
// The player never sees the file format. See PLAN.md §1.
//   Style {
//     name, source: 'sty' | 'stl', format ('SFF1', 'G8', ...), ppq, tempo (quarter notes per minute),
//     timeSig: [num, den], parts: [Part], sections: { id: Section }, order: [section ids, file order], warnings }
//   Part     { id, name, role: 'drums'|'bass'|'chord'|'pad'|'phrase', channel (the part's own channel, 1-16),
//              voice: { msb, lsb, program, volume, pan, reverb, chorus } (fields only when the file sets them) }
//   Section  { id ('mainA', 'introB', 'fillAB', 'breakAA', 'endingA', ...), kind, name (as in the file),
//              lengthTicks, bars, tracks: { partId: Track } }
//   Track    { patterns: [Pattern] }
//   Pattern  { source (file channel / name, for display), loopTicks (optional: shorter than the section, it repeats
//              until the section ends; Roland tracks can differ in length), when: { roots: 12-bit mask (bit 0 = C), chordTypes: [type
//              ids] or 'all' }, rule, events: [Event] }
//   Event    { tick, type: 'note', note, velocity, duration } | { tick, type: 'cc', cc, value }
//            | { tick, type: 'program', program } | { tick, type: 'pitchBend', value (0-16383) }
//   rule     { sourceRoot, sourceChord (type id), ntr: 'rootTrans'|'rootFixed', ntt: 'bypass'|'melody'|'chord'|'bass'|
//              'melodicMinor'|'harmonicMinor', highKey (0-11), lowLimit, highLimit, retrigger }
// Loaded as a classic script (window.Arranger.Style) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const N = isNode ? require('./chord-names.js') : window.Arranger.ChordNames;

  const KINDS = ['intro', 'main', 'fill', 'break', 'ending'];
  const ROLES = ['drums', 'bass', 'chord', 'pad', 'phrase'];
  const NTR = ['rootTrans', 'rootFixed'];
  const NTT = ['bypass', 'melody', 'chord', 'bass', 'melodicMinor', 'harmonicMinor'];
  const RETRIGGER = ['stop', 'pitchShift', 'pitchShiftToRoot', 'retrigger', 'retriggerToRoot', 'noteGenerator'];

  // Ticks in one bar: num notes of 1/den each, a quarter note being ppq ticks.
  const barTicks = (timeSig, ppq) => Math.round(timeSig[0] * ppq * 4 / timeSig[1]);
  const kindOf = (id) => KINDS.find((k) => id.indexOf(k) === 0) || null;
  // Section ids in the order the buttons show them.
  const BUTTON_ORDER = ['introA', 'introB', 'introC', 'mainA', 'mainB', 'mainC', 'mainD', 'endingA', 'endingB', 'endingC'];

  // Problems with a Style, as readable strings; [] when it's fine. Both readers' tests check their output with it.
  function validate(style) {
    const out = [];
    const bad = (s) => { if (out.length < 50) out.push(s); };
    if (!style || typeof style !== 'object') return ['not a style'];
    if (!(style.ppq > 0)) bad('ppq must be > 0');
    if (!(style.tempo > 0)) bad('tempo must be > 0');
    if (!Array.isArray(style.timeSig) || !(style.timeSig[0] > 0) || [1, 2, 4, 8, 16, 32].indexOf(style.timeSig[1]) < 0) bad('bad time signature');
    const parts = {};
    (style.parts || []).forEach((p) => {
      if (parts[p.id]) bad(`part ${p.id} twice`);
      parts[p.id] = p;
      if (ROLES.indexOf(p.role) < 0) bad(`part ${p.id}: bad role ${p.role}`);
      if (!(p.channel >= 1 && p.channel <= 16)) bad(`part ${p.id}: bad channel ${p.channel}`);
    });
    const ids = Object.keys(style.sections || {});
    if (!ids.length) bad('no sections');
    ids.forEach((id) => {
      const s = style.sections[id];
      const where = `section ${id}`;
      if (s.id !== id) bad(`${where}: id is ${s.id}`);
      if (KINDS.indexOf(s.kind) < 0) bad(`${where}: bad kind ${s.kind}`);
      if (!(s.lengthTicks > 0)) bad(`${where}: length must be > 0`);
      Object.keys(s.tracks || {}).forEach((pid) => {
        if (!parts[pid]) bad(`${where}: unknown part ${pid}`);
        (s.tracks[pid].patterns || []).forEach((pat, k) => {
          const w = `${where} ${pid} pattern ${k + 1}`;
          if (!pat.when || !(pat.when.chordTypes === 'all' || Array.isArray(pat.when.chordTypes))) bad(`${w}: bad when`);
          else if (Array.isArray(pat.when.chordTypes)) pat.when.chordTypes.forEach((t) => { if (!N.BY_ID[t]) bad(`${w}: unknown chord type ${t}`); });
          const r = pat.rule || {};
          if (NTR.indexOf(r.ntr) < 0) bad(`${w}: bad ntr ${r.ntr}`);
          if (NTT.indexOf(r.ntt) < 0) bad(`${w}: bad ntt ${r.ntt}`);
          if (!N.BY_ID[r.sourceChord]) bad(`${w}: bad source chord ${r.sourceChord}`);
          let last = 0;
          const limit = pat.loopTicks > 0 ? Math.min(pat.loopTicks, s.lengthTicks) : s.lengthTicks;
          if (pat.loopTicks != null && !(pat.loopTicks > 0)) bad(`${w}: bad loopTicks ${pat.loopTicks}`);
          (pat.events || []).forEach((e) => {
            if (!(e.tick >= 0 && e.tick < limit)) bad(`${w}: event at ${e.tick} outside 0..${limit}`);
            if (e.tick < last) bad(`${w}: events not sorted at ${e.tick}`);
            last = e.tick;
            if (e.type === 'note') {
              if (!(e.note >= 0 && e.note <= 127)) bad(`${w}: note ${e.note}`);
              if (!(e.velocity >= 1 && e.velocity <= 127)) bad(`${w}: velocity ${e.velocity}`);
              if (!(e.duration > 0)) bad(`${w}: duration ${e.duration}`);
            } else if (['cc', 'program', 'pitchBend'].indexOf(e.type) < 0) bad(`${w}: unknown event ${e.type}`);
          });
        });
      });
    });
    return out;
  }

  // A one-line summary: '4/4 · 120 bpm' (the section buttons show which sections there are).
  function summary(style) {
    return `${style.timeSig[0]}/${style.timeSig[1]} · ${Math.round(style.tempo)} bpm`;
  }

  // A hash of the style's music: everything the reader made of the file (format family, timing, tempo, meter, parts
  // and their voices, every section with its patterns, rules and events), without names or warnings. Two files with
  // the same music get the same hash even when their bytes differ (another name, another editor). 64 bits, as
  // 16 hex digits: two FNV-1a hashes with different seeds over the same text.
  function musicHash(style) {
    const skip = { name: true, warnings: true };
    const text = JSON.stringify({
      source: style.source, ppq: style.ppq, tempo: Math.round(style.tempo * 100) / 100, timeSig: style.timeSig,
      parts: style.parts, order: style.order, sections: style.order.map((id) => style.sections[id]),
    }, (k, v) => (skip[k] ? undefined : v));
    let a = 0x811C9DC5, b = 0x01000193 ^ 0x5BD1E995;
    for (let k = 0; k < text.length; k++) {
      const c = text.charCodeAt(k);
      a ^= c; a = Math.imul(a, 0x01000193) >>> 0;
      b ^= c; b = Math.imul(b, 0x01000193 ^ 0x2C1B3C6D) >>> 0; b = (b ^ (b >>> 15)) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  }

  const Style = { KINDS, ROLES, NTR, NTT, RETRIGGER, BUTTON_ORDER, barTicks, kindOf, validate, summary, musicHash };
  if (isNode) module.exports = Style;
  else (window.Arranger = window.Arranger || {}).Style = Style;
}());
