// StyReader: Yamaha .sty (SFF1) style files -> Style (style.js). No DOM, no MIDI.
//   StyReader.parse(bytes, fileName) -> Style; throws Error with a readable message for files it can't read.
// A .sty file is a format-0 MIDI file followed by a CASM chunk (PLAN.md §2b):
//   - Markers (meta 0x06) split the track into sections: SInt (setup), Intro A-C, Main A-D, Fill In AA..DD / AB / BA,
//     Break AA / BB, Ending A-C. A section runs to the next section marker. Names are compared ignoring case
//     ('Sint' occurs). Other markers ('Triplet') aren't sections; they are reported in warnings.
//   - CASM holds CSEG blocks: an Sdec (the section names it covers) and one Ctab per source channel. A Ctab maps a
//     source channel onto a part (channel 9-16) and gives the chord rules: which roots and chord types it plays for
//     (note mute / chord mute) and how its notes follow the chord (NTR / NTT, limits, retrigger).
//   - Ctab layout, checked against 26,000 entries in 873 files: 0 source ch, 1-8 name, 9 destination ch, 10 editable,
//     11-12 note mute (bit 0 = C), 13-17 chord mute (34 bits; bit 0 = byte 17 bit 0 = the first YAMAHA_TYPES entry),
//     18 source root, 19 source chord, 20 NTR, 21 NTT, 22 high key, 23 low limit, 24 high limit, 25 RTR,
//     26 special-feature flag (when 1-3 more bytes follow; they are skipped).
//   - The chord type order fits the files: Bebop's "Maj Bass" / "min Bass" Ctabs have exactly complementary chord
//     mutes, the minor one being types 8-18 (min .. dim7).
//   - Without CASM (128 of the 832 1manband files), channels 9-16 play as their own parts with default rules.
// Loaded as a classic script (window.Arranger.StyReader) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const Smf = isNode ? require('./smf.js') : window.Arranger.Smf;
  const Style = isNode ? require('./style.js') : window.Arranger.Style;

  // Yamaha's chord types in Ctab order, as ChordNames type ids (null: no equivalent; 1+8 is a single key, which the
  // detector reads as a major chord).
  const YAMAHA_TYPES = ['', '6', 'M7', 'M7#11', 'add9', 'M9', '69', 'aug', 'm', 'm6', 'm7', 'm7b5', 'madd9', 'm9', 'm11',
    'mM7', 'mM9', 'dim', 'dim7', '7', '7sus4', '7b5', '9', '7#11', '13', '7b9', '7b13', '7#9', 'M7#5', 'aug7', null, '5',
    'sus4', 'sus2'];
  // Detector types Yamaha doesn't have, played as the closest one it has.
  const AS_YAMAHA = { m69: 'm6' };

  // Parts by channel 9-16.
  const PARTS = {
    9: { id: 'rhythm1', name: 'Rhythm 1', role: 'drums' },
    10: { id: 'rhythm2', name: 'Rhythm 2', role: 'drums' },
    11: { id: 'bass', name: 'Bass', role: 'bass' },
    12: { id: 'chord1', name: 'Chord 1', role: 'chord' },
    13: { id: 'chord2', name: 'Chord 2', role: 'chord' },
    14: { id: 'pad', name: 'Pad', role: 'pad' },
    15: { id: 'phrase1', name: 'Phrase 1', role: 'phrase' },
    16: { id: 'phrase2', name: 'Phrase 2', role: 'phrase' },
  };
  const DEFAULT_NTT = { drums: 'bypass', bass: 'bass', chord: 'chord', pad: 'chord', phrase: 'melody' };

  // A marker's section: { id, kind } or 'init' (SInt), or null (not a section marker).
  function sectionOf(text) {
    const t = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
    let m;
    if (t === 'sint') return 'init';
    if ((m = /^intro ([a-d])$/.exec(t))) return { id: 'intro' + m[1].toUpperCase(), kind: 'intro' };
    if ((m = /^main ([a-d])$/.exec(t))) return { id: 'main' + m[1].toUpperCase(), kind: 'main' };
    if ((m = /^fill in ([a-d])([a-d])$/.exec(t))) return { id: 'fill' + (m[1] + m[2]).toUpperCase(), kind: 'fill' };
    if ((m = /^break ([a-d])([a-d]?)$/.exec(t))) return { id: 'break' + (m[1] + m[2]).toUpperCase(), kind: 'break' };
    if ((m = /^ending ([a-d])$/.exec(t))) return { id: 'ending' + m[1].toUpperCase(), kind: 'ending' };
    return null;
  }

  // The chunks in b[start, end): [{ tag, at, data }]. Stops at anything that doesn't frame as a chunk.
  function chunks(b, start, end) {
    const out = [];
    let at = start;
    while (at + 8 <= end) {
      const tag = Smf.ascii(b, at, 4), len = Smf.u32(b, at + 4);
      if (!/^[\x20-\x7E]{4}$/.test(tag) || at + 8 + len > end) break;
      out.push({ tag, at, data: b.subarray(at + 8, at + 8 + len) });
      at += 8 + len;
    }
    return { list: out, stoppedAt: at };
  }

  // The chord types whose bit is set in a 34-bit chord mute (bytes 13-17 of a Ctab).
  function chordTypesOf(c) {
    const set = [];
    for (let i = 0; i < YAMAHA_TYPES.length; i++) {
      const byte = c[17 - (i >> 3)];
      if (byte & (1 << (i & 7)) && YAMAHA_TYPES[i] != null && set.indexOf(YAMAHA_TYPES[i]) < 0) set.push(YAMAHA_TYPES[i]);
    }
    Object.keys(AS_YAMAHA).forEach((t) => { if (set.indexOf(AS_YAMAHA[t]) >= 0) set.push(t); });
    return set.length === YAMAHA_TYPES.length - 1 + Object.keys(AS_YAMAHA).length ? 'all' : set;
  }

  function decodeCtab(c, warn) {
    if (c.length < 26) { warn(`A Ctab of ${c.length} bytes was skipped.`); return null; }
    const ntt = Style.NTT[c[21]];
    if (!ntt) warn(`NTT ${c[21]} isn't known; played as bypass.`);
    const ntr = Style.NTR[c[20]];
    if (!ntr) warn(`NTR ${c[20]} isn't known; played as root transposition.`);
    return {
      source: c[0] + 1,
      name: Smf.ascii(c, 1, 8).replace(/[^\x20-\x7E]/g, ' ').trim(),
      dest: c[9] + 1,
      when: { roots: ((c[11] << 8) | c[12]) & 0xFFF, chordTypes: chordTypesOf(c) },
      rule: {
        sourceRoot: c[18] % 12,
        sourceChord: YAMAHA_TYPES[c[19]] != null ? YAMAHA_TYPES[c[19]] : (c[19] === 30 ? '' : 'M7'),
        ntr: ntr || 'rootTrans',
        ntt: ntt || 'bypass',
        highKey: c[22] % 12,
        lowLimit: Math.min(c[23], 127),
        highLimit: Math.min(c[24], 127),
        retrigger: Style.RETRIGGER[c[25]] || 'pitchShift',
      },
    };
  }

  // SFF2 (Tyros-era) Ctb2, 47 bytes (54 entries in 2 files checked): bytes 0-19 as in Ctab; 20-21 the middle note
  // range (low, high), then rules for notes below it (22-27), in it (28-33) and above it (34-39), each
  // [NTR, NTT, high key, low limit, high limit, RTR]; 40-46 unused (zero). NTR 2 is Guitar; NTT bit 0x80 is
  // "bass on" and its low bits: 0 bypass, 1 melody, 2 chord, 3 melody, 4-5 melodic minor, 6-7 harmonic minor,
  // 8-9 natural minor, 10-11 dorian. The middle range's rule is used; the files checked use the full range.
  const NTT2 = ['bypass', 'melody', 'chord', 'melody', 'melodicMinor', 'melodicMinor', 'harmonicMinor', 'harmonicMinor',
    'melody', 'melody', 'melody', 'melody'];
  function decodeCtb2(c, warn) {
    if (c.length < 34) { warn(`A Ctb2 of ${c.length} bytes was skipped.`); return null; }
    if (c[20] !== 0 || c[21] !== 127) warn('Some parts split notes into ranges with their own rules; only the middle range\'s rule is used.');
    const nttByte = c[29], bassOn = !!(nttByte & 0x80);
    let ntt = NTT2[nttByte & 0x7F];
    if (!ntt) { warn(`NTT ${nttByte & 0x7F} isn't known; played as bypass.`); ntt = 'bypass'; }
    if (bassOn && ntt !== 'bypass') ntt = 'bass';
    if (c[28] === 2) warn('Guitar note transposition isn\'t supported; played as root transposition.');
    else if (c[28] > 2) warn(`NTR ${c[28]} isn't known; played as root transposition.`);
    return {
      source: c[0] + 1,
      name: Smf.ascii(c, 1, 8).replace(/[^\x20-\x7E]/g, ' ').trim(),
      dest: c[9] + 1,
      when: { roots: ((c[11] << 8) | c[12]) & 0xFFF, chordTypes: chordTypesOf(c) },
      rule: {
        sourceRoot: c[18] % 12,
        sourceChord: YAMAHA_TYPES[c[19]] != null ? YAMAHA_TYPES[c[19]] : (c[19] === 30 ? '' : 'M7'),
        ntr: c[28] === 1 ? 'rootFixed' : 'rootTrans',
        ntt,
        highKey: c[30] % 12,
        lowLimit: Math.min(c[31], 127),
        highLimit: Math.min(c[32], 127),
        retrigger: Style.RETRIGGER[c[33]] || 'pitchShift',
      },
    };
  }

  function defaultRule(role) {
    return { sourceRoot: 0, sourceChord: 'M7', ntr: role === 'drums' ? 'rootFixed' : 'rootTrans', ntt: DEFAULT_NTT[role],
      highKey: 5, lowLimit: 0, highLimit: 127, retrigger: 'pitchShift' };
  }

  function parse(input, fileName) {
    const b = Smf.toBytes(input);
    if (b.length >= 2 && (Smf.ascii(b, 0, 2) === 'G8' || Smf.ascii(b, 0, 2) === 'EV')) throw new Error('This is a Roland style, not a Yamaha one.');
    if (Smf.ascii(b, 0, 4) !== 'MThd') {
      const head = Smf.ascii(b, 0, 4).replace(/[^\x20-\x7E]/g, '?');
      throw new Error(`Not a Yamaha style: the file starts with “${head}”, not a MIDI header.`);
    }
    const smf = Smf.parse(b);
    const warnings = smf.warnings.slice();
    const warned = {};
    const warn = (s) => { if (!warned[s]) { warned[s] = true; warnings.push(s); } };

    // One track of events with their absolute ticks (format 1 files are merged).
    const events = [].concat.apply([], smf.tracks).sort((x, y) => x.tick - y.tick);
    let format = null, tempo = null, timeSig = null, name = null, lastTick = 0;
    const markers = [];
    events.forEach((e) => {
      lastTick = Math.max(lastTick, e.tick);
      if (e.meta === 0x06) {
        const text = String.fromCharCode.apply(null, e.data).trim();
        if (/^SFF\d$/i.test(text)) { format = text.toUpperCase(); return; }
        const s = sectionOf(text);
        if (s) markers.push({ tick: e.tick, text, s });
        else if (!/^triplet$/i.test(text)) warn(`Marker “${text}” isn't a section; ignored.`);
      } else if (e.meta === 0x51 && e.data.length === 3 && tempo == null) {
        tempo = 60000000 / ((e.data[0] << 16) | (e.data[1] << 8) | e.data[2]);
      } else if (e.meta === 0x58 && e.data.length >= 2) {
        const ts = [e.data[0], Math.pow(2, e.data[1])];
        if (!timeSig) timeSig = ts;
        else if (ts[0] !== timeSig[0] || ts[1] !== timeSig[1]) warn(`The time signature changes to ${ts[0]}/${ts[1]}; the style plays in ${timeSig[0]}/${timeSig[1]}.`);
      } else if (e.meta === 0x03 && e.tick === 0 && name == null) {
        name = String.fromCharCode.apply(null, e.data).replace(/[^\x20-\x7E]/g, '').trim() || null;
      }
    });
    if (!format) warn('No SFF1 marker; read as SFF1.');
    if (!markers.some((m) => m.s !== 'init')) throw new Error('No style sections (Main A, Intro A, ...) in this file.');
    if (tempo == null) { tempo = 120; warn('No tempo; using 120.'); }
    if (!timeSig) timeSig = [4, 4];
    const ppq = smf.ppq;

    // Section spans: from each marker to the next one (or the end of the track).
    const spans = [];
    markers.forEach((m, k) => {
      const end = k + 1 < markers.length ? markers[k + 1].tick : lastTick;
      spans.push({ start: m.tick, end, s: m.s, text: m.text });
    });

    // Notes paired per channel (first on, first off), and the other channel events, with their channel.
    const notes = [], others = [];
    const open = {};
    events.forEach((e) => {
      if (e.status == null) return;
      const ch = (e.status & 0x0F) + 1, type = e.status & 0xF0;
      if (type === 0x90 && e.data[1] > 0) {
        const n = { tick: e.tick, ch, note: e.data[0], velocity: e.data[1], off: null };
        notes.push(n);
        const key = ch * 128 + e.data[0];
        (open[key] = open[key] || []).push(n);
      } else if (type === 0x80 || type === 0x90) {
        const q = open[ch * 128 + e.data[0]];
        if (q && q.length) q.shift().off = e.tick;
      } else if (type === 0xB0) others.push({ tick: e.tick, ch, ev: { type: 'cc', cc: e.data[0], value: e.data[1] } });
      else if (type === 0xC0) others.push({ tick: e.tick, ch, ev: { type: 'program', program: e.data[0] } });
      else if (type === 0xE0) others.push({ tick: e.tick, ch, ev: { type: 'pitchBend', value: e.data[0] | (e.data[1] << 7) } });
    });

    // The setup (SInt) values per channel: bank, program, volume, pan, reverb, chorus.
    const init = spans.find((sp) => sp.s === 'init');
    const voices = {};
    const VOICE_CC = { 0: 'msb', 32: 'lsb', 7: 'volume', 10: 'pan', 91: 'reverb', 93: 'chorus' };
    others.forEach((o) => {
      if (!init || o.tick < init.start || o.tick >= init.end) return;
      const v = voices[o.ch] = voices[o.ch] || {};
      if (o.ev.type === 'program') v.program = o.ev.program;
      else if (o.ev.type === 'cc' && VOICE_CC[o.ev.cc]) v[VOICE_CC[o.ev.cc]] = o.ev.value;
    });

    // CASM: the Ctabs that apply to each section name.
    const casmAt = findCasm(b, smf.end);
    const ctabsFor = {};       // lower-case section name -> [ctab]
    let hasCasm = false;
    if (casmAt >= 0) {
      hasCasm = true;
      const casmLen = Smf.u32(b, casmAt + 4);
      const casmEnd = Math.min(b.length, casmAt + 8 + casmLen);
      if (casmAt + 8 + casmLen > b.length) warn('The CASM chunk is cut short.');
      const segs = chunks(b, casmAt + 8, casmEnd);
      segs.list.forEach((seg) => {
        if (seg.tag !== 'CSEG') { warn(`CASM block ${seg.tag} skipped.`); return; }
        let names = [];
        const tabs = [];
        chunks(seg.data, 0, seg.data.length).list.forEach((ch) => {
          if (ch.tag === 'Sdec') names = String.fromCharCode.apply(null, ch.data).split(',').map((s) => s.trim().toLowerCase().replace(/\s+/g, ' '));
          else if (ch.tag === 'Ctab') { const t = decodeCtab(ch.data, warn); if (t) tabs.push(t); }
          else if (ch.tag === 'Ctb2') { const t = decodeCtb2(ch.data, warn); if (t) tabs.push(t); }
          else warn(`CSEG block ${ch.tag} skipped.`);
        });
        names.forEach((n) => { ctabsFor[n] = (ctabsFor[n] || []).concat(tabs); });
      });
    } else warn('No CASM chunk: channels 9-16 play with default chord rules.');

    // The sections.
    const sections = {}, order = [], used = {};
    const bar = Style.barTicks(timeSig, ppq);
    spans.forEach((sp, k) => {
      if (sp.s === 'init') return;
      // The last section runs to the file's last event, not to a bar line: round it up to whole bars.
      if (k === spans.length - 1) sp.end = sp.start + Math.max(1, Math.ceil((sp.end - sp.start) / bar - 0.01)) * bar;
      const id = sp.s.id;
      if (sections[id]) { warn(`Section ${sp.text} appears twice; the first one is used.`); return; }
      const lengthTicks = sp.end - sp.start;
      if (lengthTicks <= 0) { warn(`Section ${sp.text} is empty.`); return; }
      const key = sp.text.trim().toLowerCase().replace(/\s+/g, ' ');
      // Which part each source channel plays, with its rules.
      let tabs = ctabsFor[key];
      if (!tabs) {
        if (hasCasm) warn(`No chord rules for ${sp.text}: channels 9-16 play with default rules.`);
        tabs = [];
        for (let ch = 9; ch <= 16; ch++) tabs.push({ source: ch, name: PARTS[ch].name, dest: ch, when: { roots: 0xFFF, chordTypes: 'all' }, rule: defaultRule(PARTS[ch].role) });
      }
      const tracks = {};
      tabs.forEach((t) => {
        const part = PARTS[t.dest];
        if (!part) return;                  // channels 1-8 as a destination: a source track that isn't used
        const evs = [];
        notes.forEach((n) => {
          if (n.ch !== t.source || n.tick < sp.start || n.tick >= sp.end) return;
          const off = n.off == null ? sp.end : Math.min(n.off, sp.end);
          evs.push({ tick: n.tick - sp.start, type: 'note', note: n.note, velocity: n.velocity, duration: Math.max(1, off - n.tick) });
        });
        others.forEach((o) => {
          if (o.ch === t.source && o.tick >= sp.start && o.tick < sp.end) evs.push(Object.assign({ tick: o.tick - sp.start }, o.ev));
        });
        if (!evs.length) return;
        evs.sort((x, y) => x.tick - y.tick);
        used[t.dest] = used[t.dest] || t.source;
        const pattern = { source: `ch ${t.source}${t.name ? ' ' + t.name : ''}`, when: t.when, rule: t.rule, events: evs };
        if (voices[t.source]) pattern.voice = voices[t.source];
        (tracks[part.id] = tracks[part.id] || { patterns: [] }).patterns.push(pattern);
      });
      const bars = lengthTicks / bar;
      if (Math.abs(bars - Math.round(bars)) > 0.01) warn(`${sp.text} is ${bars.toFixed(2)} bars long.`);
      sections[id] = { id, kind: sp.s.kind, name: sp.text, lengthTicks, bars: Math.max(1, Math.round(bars)), tracks };
      order.push(id);
    });

    // A part's voice is its first source track's (the part's own channel often only has a placeholder: Bebop's bass
    // channel 11 gets bank 127 program 124, its sources on channels 1-2 Acoustic Bass).
    const parts = Object.keys(used).map(Number).sort((x, y) => x - y).map((ch) => {
      const p = PARTS[ch];
      return { id: p.id, name: p.name, role: p.role, channel: ch, voice: Object.assign({}, voices[used[ch]] || voices[ch] || {}) };
    });
    const base = String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
    return { name: name || base || 'Style', source: 'sty', format: format || 'SFF1', ppq, tempo, timeSig, parts, sections, order, warnings };
  }

  // Where the CASM chunk starts: right after the MIDI data, or a few bytes later (some files have a byte between).
  function findCasm(b, from) {
    for (let at = from; at + 8 <= b.length; at++) {
      if (b[at] === 0x43 && b[at + 1] === 0x41 && b[at + 2] === 0x53 && b[at + 3] === 0x4D) return at;
      if (at - from > 4096) break;
    }
    return -1;
  }

  const StyReader = { parse, sectionOf, YAMAHA_TYPES, PARTS };
  if (isNode) module.exports = StyReader;
  else (window.Arranger = window.Arranger || {}).StyReader = StyReader;
}());
