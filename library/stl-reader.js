// StlReader: Roland .stl styles (EM-2000 / EM-50 / G-800 era, signatures 'G8' and 'EV') and .sth styles (see STH
// below) -> Style (style.js). No DOM.
//   StlReader.parse(bytes, fileName) -> Style; throws Error with a readable message for files it can't read.
// Layout, checked against 167 files (github.com/rumenvasilev/roland-em-styles); reference: RolandStyleReader (GPL,
// not copied). See PLAN.md §2c.
//   0x00 'G8' / 'EV'   0x02-0x11 name   0x14 u16 BE: tempo = 500000 / value   0x16 u16 BE: ticks per quarter (120)
//   0x18 beats per bar, 0x19 denominator as a power of 2 (the per-slot table at 0x1A has 4/4 placeholders: unused)
//   0x3A address table: 8 instruments (192 bytes each: Basic arrangement at +0, Advanced at +96), each with 8 slots
//     (12 bytes) of Major / Minor / Seventh entries: u32 LE file offsets of event lists. Past the end of the file =
//     none (the files use CE 66 C1 D9). Entries often share one list.
//   Instruments: 0 drums, 1 bass, 2-7 accompaniment 1-6.
//   Slots: 0 intro, 1 original, 2 variation, 4 fill to original, 5 fill to variation, 7 ending. 3 and 6 are mostly
//     empty or copies of 2 and 5, so they're unused. The slot meanings are inferred from their lengths (intros and
//     mains 2-4 bars, fills always 1 bar, endings longest) and still to be confirmed by ear.
//   Sections: Basic original / variation = Main A / B, Advanced = Main C / D (when they differ from Basic), with their
//     fills (fill to original -> Fill In AA / CC, to variation -> BB / DD), intros and endings A (Basic) and B
//     (Advanced, when different).
//   Events, 6 bytes: [delta, type, part, d1, d2, d3]; type 0x8F ends the list. delta is the wait after the event
//     (read the other way, 5.3% of notes would overlap their own next strike instead of 0.4%).
//     type < 0x80: note, d1 velocity, d2-d3 duration: (d2 & 0x3F) << 8 | d3. Long notes come in pieces of up to 255
//       ticks: the first has bit 0x80 of d2 set ("continued"), the next ones a velocity byte with its top bit set
//       (mostly 0xC0): they extend the note instead of striking it again. Bit 0x40 of d2: meaning unknown (ignored).
//     0xE5 program change (d2 = program)   0xE6 control change (d2 = controller, d3 = value)
//     0xEB pitch bend (d2 = LSB, d3 = MSB)   0x80 a step with no event (long gaps)   0xEA and 0x8A unknown (skipped)
//     Anything else means the list has run into other data: it ends there (a warning says so).
//   Each chord family's list becomes a pattern for the chord types of that family; the notes are written over C
//   major / minor / seventh and move with the root (rootTrans + bypass; drums rootFixed).
// Loaded as a classic script (window.Arranger.StlReader) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const Smf = isNode ? require('./smf.js') : window.Arranger.Smf;
  const Style = isNode ? require('./style.js') : window.Arranger.Style;

  const TABLE = 0x3A, TABLE_END = 0x3A + 8 * 192;
  const INSTRUMENTS = [
    { id: 'drums', name: 'Drums', role: 'drums', channel: 10 },
    { id: 'bass', name: 'Bass', role: 'bass', channel: 2 },
    { id: 'acc1', name: 'Acc 1', role: 'chord', channel: 3 },
    { id: 'acc2', name: 'Acc 2', role: 'chord', channel: 4 },
    { id: 'acc3', name: 'Acc 3', role: 'pad', channel: 5 },
    { id: 'acc4', name: 'Acc 4', role: 'phrase', channel: 6 },
    { id: 'acc5', name: 'Acc 5', role: 'phrase', channel: 7 },
    { id: 'acc6', name: 'Acc 6', role: 'phrase', channel: 8 },
  ];
  // The chord types each family's pattern plays for.
  const FAMILIES = [
    { source: '', types: ['', '6', 'M7', 'M7#11', 'add9', 'M9', '69', 'sus2', 'sus4', '5'] },
    { source: 'm', types: ['m', 'm6', 'm7', 'm7b5', 'madd9', 'm9', 'm11', 'mM7', 'mM9', 'm69', 'dim', 'dim7'] },
    { source: '7', types: ['7', '7sus4', '7b5', '9', '7#11', '13', '7b9', '7b13', '7#9', 'aug', 'aug7', 'M7#5'] },
  ];
  // [slot, Basic section id, Advanced section id]
  const SLOTS = [[0, 'introA', 'introB'], [1, 'mainA', 'mainC'], [2, 'mainB', 'mainD'], [4, 'fillAA', 'fillCC'],
    [5, 'fillBB', 'fillDD'], [7, 'endingA', 'endingB']];
  // 0x8A: [delta, 8A, 0, 0 or 1, 80, 80], an on/off setting the E-80 styles have at the start of most lists
  // (24,000 of them in 357 files); not needed to play, skipped like 0xEA.
  const EVENT_TYPES = { 0x80: 'step', 0x8A: 'skip', 0xE5: 'program', 0xE6: 'cc', 0xEB: 'pitchBend', 0xEA: 'skip' };

  // The events of one list, with its length in ticks. Stops at 0x8F, at the end of the file, or at an event that
  // makes no sense (the list has run into other data).
  function readList(b, at, warn) {
    const events = [];
    let t = 0, j = at, broken = false;
    while (j + 6 <= b.length && b[j + 1] !== 0x8F) {
      const delta = b[j], type = b[j + 1], part = b[j + 2], d1 = b[j + 3], d2 = b[j + 4], d3 = b[j + 5];
      const partOk = part === 0 || (part >= 0x10 && part <= 0x20);
      if (!partOk || (type >= 0x80 && !EVENT_TYPES[type])) { broken = true; break; }
      if (type < 0x80) {
        const duration = Math.max(1, ((d2 & 0x3F) << 8) | d3);
        // A velocity byte with its top bit set (mostly 0xC0) continues the same note, still sounding: it gets longer
        // instead of struck again (271,000 of them in the Roland files, 98% right after a held note of that pitch).
        // Without a held note (a list's start), it plays at the velocity in its low bits.
        const held = d1 & 0x80 ? findHeld(events, type, t) : null;
        if (held) held.duration = Math.max(held.duration, t + duration - held.tick);
        else if (d1 & 0x7F) events.push({ tick: t, type: 'note', note: type, velocity: d1 & 0x7F, duration });
      } else if (type === 0xE5) events.push({ tick: t, type: 'program', program: d2 & 0x7F });
      else if (type === 0xE6) events.push({ tick: t, type: 'cc', cc: d2 & 0x7F, value: d3 & 0x7F });
      else if (type === 0xEB) events.push({ tick: t, type: 'pitchBend', value: (d2 & 0x7F) | ((d3 & 0x7F) << 7) });
      t += delta;
      j += 6;
    }
    if (broken) warn('Some event lists run into other data; they were cut there.');
    return { events, length: t, broken };
  }

  // The latest note of this pitch that sounds up to tick t (a tie's note).
  function findHeld(events, note, t) {
    for (let k = events.length - 1; k >= 0; k--) {
      const e = events[k];
      if (e.type === 'note' && e.note === note) return e.tick + e.duration >= t - 1 ? e : null;
    }
    return null;
  }

  // STH files (13 files checked): the same header block, table and events, 0x670 bytes further in (header at 0x682,
  // table at 0x6AA). Bytes 0-1 are 00 01. Table entries are u32 BE, FFFFFFFF = none, and count from the table's end
  // to just past a list's 0x8F record. Between lists there is other data of varying length, so a list is found by
  // stepping back from its 0x8F, 6 bytes at a time, while the records are events.
  const STH_SHIFT = 0x670;
  function isSth(b) { return b.length > 0xCAA && b[0] === 0 && b[1] === 1 && b[0x682] === 0x78 && ((b[0x686] << 8) | b[0x687]) === 120; }
  function layoutOf(b) {
    const sig = Smf.ascii(b, 0, 2);
    if (sig === 'G8' || sig === 'EV') {
      return { format: sig, head: 0, table: TABLE, tableEnd: TABLE_END,
        entry: (at) => { const v = (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; return v >= TABLE_END && v < b.length ? v : null; } };
    }
    if (isSth(b)) {
      const tableEnd = TABLE_END + STH_SHIFT;
      const isEvent = (j) => {
        if (j < tableEnd) return false;
        const type = b[j + 1], part = b[j + 2];
        if (!(part === 0 || (part >= 0x10 && part <= 0x20)) || type === 0x8F) return false;
        return type < 0x80 ? b[j + 3] > 0 : !!EVENT_TYPES[type];
      };
      return { format: 'STH', head: STH_SHIFT, table: TABLE + STH_SHIFT, tableEnd,
        entry: (at) => {
          const v = ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
          if (v === 0xFFFFFFFF) return null;
          const term = tableEnd + v - 6;
          if (term < tableEnd || term + 6 > b.length || b[term + 1] !== 0x8F) return null;
          let j = term - 6;
          while (isEvent(j)) j -= 6;
          return j + 6;
        } };
    }
    return null;
  }

  function parse(input, fileName) {
    const b = Smf.toBytes(input);
    const lay = layoutOf(b);
    if (!lay) throw new Error(`Not a Roland EM / G style: the file starts with “${Smf.ascii(b, 0, 2).replace(/[^\x20-\x7E]/g, '?')}”.`);
    if (b.length < lay.tableEnd) throw new Error('The Roland style file is cut short.');
    const sig = lay.format, H = lay.head;
    const warnings = [];
    const warned = {};
    const warn = (s) => { if (!warned[s]) { warned[s] = true; warnings.push(s); } };
    const u16 = (at) => (b[at] << 8) | b[at + 1];

    // The name field is 16 bytes; some (E-80) end it with a zero byte and leave other bytes after it.
    const name = Smf.ascii(b, 2, 16).split('\0')[0].replace(/[^\x20-\x7E]/g, ' ').trim();
    const tempoField = u16(H + 0x14);
    let tempo = tempoField ? 500000 / tempoField : 0;
    if (!(tempo >= 20 && tempo <= 400)) { warn('No usable tempo; using 120.'); tempo = 120; }
    let ppq = u16(H + 0x16);
    if (!(ppq > 0 && ppq <= 1920)) { warn(`Ticks per quarter ${ppq} isn't usable; using 120.`); ppq = 120; }
    const num = b[H + 0x18], denExp = b[H + 0x19];
    let timeSig = [num, Math.pow(2, denExp)];
    if (!(num > 0 && num <= 32 && denExp >= 1 && denExp <= 5)) { warn('No usable time signature; using 4/4.'); timeSig = [4, 4]; }
    const bar = Style.barTicks(timeSig, ppq);

    // One section (an arrangement's slot): every instrument's patterns, one per distinct list.
    const lists = {};                                // file offset -> parsed list (lists are shared)
    const list = (at) => lists[at] || (lists[at] = readList(b, at, warn));
    // A list's content, to tell an Advanced section that copies Basic from one that differs (copies don't always
    // share one list).
    const keys = {};
    const listKey = (at) => keys[at] || (keys[at] = JSON.stringify(list(at).events) + '|' + list(at).length);
    function section(arr, slot, id) {
      const tracks = {};
      let length = 0, majorLength = 0, notes = 0, key = [];
      INSTRUMENTS.forEach((inst, ins) => {
        const base = lay.table + ins * 192 + arr * 96 + slot * 12;
        const valid = [0, 1, 2].map((k) => lay.entry(base + k * 4));
        if (valid[0] == null && valid[1] == null && valid[2] == null) return;
        // A family without a list plays the major one (or the first that exists).
        const fallback = valid[0] != null ? valid[0] : valid.find((a) => a != null);
        const byAddr = {};
        FAMILIES.forEach((fam, k) => {
          const a = valid[k] != null ? valid[k] : fallback;
          (byAddr[a] = byAddr[a] || { a, fams: [] }).fams.push(k);
        });
        const patterns = [];
        Object.keys(byAddr).forEach((a) => {
          const entry = byAddr[a], l = list(entry.a);
          key.push(ins + ':' + entry.fams.join('') + ':' + listKey(entry.a));
          // A list with no notes (only steps or controllers) is silent: it doesn't play, and its length doesn't
          // count (ASCULTAR's Main B has 8-bar empty lists next to 7-bar ones, which then wrapped around early).
          if (!l.events.some((e) => e.type === 'note')) return;
          length = Math.max(length, l.length);
          if (entry.fams.indexOf(0) >= 0) majorLength = Math.max(majorLength, l.length);
          l.events.forEach((e) => { if (e.type === 'note') notes++; });
          const fam = FAMILIES[entry.fams[0]];
          const types = [].concat.apply([], entry.fams.map((k) => FAMILIES[k].types));
          patterns.push({
            source: `${inst.name} ${entry.fams.map((k) => ['maj', 'min', '7th'][k]).join('/')}`,
            when: { roots: 0xFFF, chordTypes: entry.fams.length === 3 ? 'all' : types },
            rule: { sourceRoot: 0, sourceChord: fam.source, ntr: inst.role === 'drums' ? 'rootFixed' : 'rootTrans', ntt: 'bypass',
              highKey: 6, lowLimit: 0, highLimit: 127, retrigger: 'pitchShift' },
            events: l.events,
            listLength: l.broken ? 0 : l.length,          // a list cut short doesn't loop (its length means nothing)
          });
        });
        if (patterns.length) tracks[inst.id] = { patterns };
      });
      if (!Object.keys(tracks).length || !length || !notes) return null;     // a section with no notes isn't one
      // The section is as long as its longest major-chord list (tracks can differ in length, and a minor or seventh
      // variant can be longer). Shorter lists loop within it (loopTicks); longer ones are cut at its end.
      // An ending stops after its last note: it runs to the bar line after that note ends (up to 2 bars past its
      // last event), with no warning. Intros, mains and fills lead on to the next section at a bar line: the
      // nearest one. Only mains loop their shorter lists; the others play them once.
      const kind = Style.kindOf(id);
      let span = majorLength || length, bars;
      if (kind === 'ending') {
        let lastEnd = 0;
        Object.keys(tracks).forEach((pid) => tracks[pid].patterns.forEach((p) => p.events.forEach((e) => {
          if (e.type === 'note') lastEnd = Math.max(lastEnd, e.tick + e.duration);
        })));
        span = Math.max(span, Math.min(lastEnd, span + 2 * bar));
        bars = Math.max(1, Math.ceil(span / bar - 0.02));
      } else {
        bars = Math.max(1, Math.round(span / bar));
        if (Math.abs(span / bar - bars) > 0.05) warn(`${label(id)} is ${(span / bar).toFixed(2)} bars long; played as ${bars}.`);
      }
      const lengthTicks = bars * bar;
      Object.keys(tracks).forEach((pid) => tracks[pid].patterns.forEach((p) => {
        const own = kind === 'main' && p.listLength > 0 && p.listLength < lengthTicks - 1 ? p.listLength : 0;
        const limit = own || lengthTicks;
        if (own) p.loopTicks = own;
        delete p.listLength;
        p.events = p.events.filter((e) => e.tick < limit)
          .map((e) => (e.type === 'note' && e.tick + e.duration > limit ? Object.assign({}, e, { duration: limit - e.tick }) : e));
      }));
      return { tracks, lengthTicks, bars, key: key.join(',') };
    }

    const sections = {}, order = [];
    SLOTS.forEach(([slot, basicId, advId]) => {
      let basic = section(0, slot, basicId), adv = section(1, slot, advId);
      // A "fill" longer than 2 bars isn't one (some STH styles have whole patterns there): not used as a fill.
      if (Style.kindOf(basicId) === 'fill') {
        if (basic && basic.bars > 2) { warn(`${label(basicId)} is ${basic.bars} bars long: not used as a fill.`); basic = null; }
        if (adv && adv.bars > 2) { warn(`${label(advId)} is ${adv.bars} bars long: not used as a fill.`); adv = null; }
      }
      if (!basic && adv) { basic = adv; adv = null; }   // only an Advanced one: it plays as A
      if (basic) {
        sections[basicId] = { id: basicId, kind: Style.kindOf(basicId), name: label(basicId), lengthTicks: basic.lengthTicks, bars: basic.bars, tracks: basic.tracks };
        order.push(basicId);
      }
      // Advanced: intros, mains and endings only when they differ from Basic (most styles share them); its fills
      // whenever its main is there (Fill In CC goes with Main C).
      const kind = Style.kindOf(advId);
      const keep = adv && (kind === 'fill' ? !!sections[advId === 'fillCC' ? 'mainC' : 'mainD'] : (!basic || adv.key !== basic.key));
      if (keep) {
        sections[advId] = { id: advId, kind, name: label(advId), lengthTicks: adv.lengthTicks, bars: adv.bars, tracks: adv.tracks };
        order.push(advId);
      }
    });
    if (!order.some((id) => sections[id].kind === 'main')) throw new Error('No playable sections in this Roland style.');

    // Parts: the instruments that play somewhere, with the first program and mix controllers of Main A as voice.
    const used = {};
    order.forEach((id) => Object.keys(sections[id].tracks).forEach((pid) => { used[pid] = true; }));
    const VOICE_CC = { 7: 'volume', 10: 'pan', 91: 'reverb', 93: 'chorus' };
    const firstMain = sections[order.find((id) => sections[id].kind === 'main')];
    const parts = INSTRUMENTS.filter((inst) => used[inst.id]).map((inst) => {
      const voice = {};
      const tr = firstMain.tracks[inst.id];
      if (tr) tr.patterns[0].events.forEach((e) => {
        if (e.tick > 0) return;
        if (e.type === 'program' && voice.program == null) voice.program = e.program;
        if (e.type === 'cc' && VOICE_CC[e.cc] && voice[VOICE_CC[e.cc]] == null) voice[VOICE_CC[e.cc]] = e.value;
      });
      return { id: inst.id, name: inst.name, role: inst.role, channel: inst.channel, voice };
    });
    const base = String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
    return { name: name || base || 'Roland style', source: 'stl', format: sig, ppq, tempo, timeSig, parts, sections, order, warnings };
  }

  function label(id) {
    const m = /^([a-z]+)([A-D]+)$/.exec(id);
    const words = { intro: 'Intro', main: 'Main', fill: 'Fill In', ending: 'Ending' };
    return `${words[m[1]]} ${m[2]}`;
  }

  const StlReader = { parse, isSth, INSTRUMENTS, FAMILIES };
  if (isNode) module.exports = StlReader;
  else (window.Arranger = window.Arranger || {}).StlReader = StlReader;
}());
