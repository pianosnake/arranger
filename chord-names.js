// ChordNames: the chord types the arranger knows, as interval sets, plus note spelling and chord names.
// Pure functions, no DOM, no MIDI. A chord is { root: 0-11, type: 'm7', bass: 0-11 or null } (pitch classes, C = 0);
// bass is only set when it differs from the root (a slash chord or an inversion).
// Loaded as a classic script (window.Arranger.ChordNames) or with require() in Node (tests).
(function () {
  'use strict';

  // Each type: id (also the name suffix), the intervals above the root, and which of them may be left out when
  // playing it (the 5th of a 7th chord, the 5th of a triad played as two notes).
  // The order is the preference when two names fit the same notes equally well (e.g. Am7/E before C6/E).
  const TYPES = [
    { id: '', iv: [0, 4, 7], opt: [7] },
    { id: 'm', iv: [0, 3, 7], opt: [7] },
    { id: '7', iv: [0, 4, 7, 10], opt: [7] },
    { id: 'm7', iv: [0, 3, 7, 10], opt: [7] },
    { id: 'M7', iv: [0, 4, 7, 11], opt: [7] },
    { id: '6', iv: [0, 4, 7, 9], opt: [7] },
    { id: 'm6', iv: [0, 3, 7, 9], opt: [7] },
    { id: 'sus4', iv: [0, 5, 7], opt: [] },
    { id: '7sus4', iv: [0, 5, 7, 10], opt: [7] },
    { id: 'sus2', iv: [0, 2, 7], opt: [] },
    { id: 'dim', iv: [0, 3, 6], opt: [] },
    { id: 'dim7', iv: [0, 3, 6, 9], opt: [] },
    { id: 'aug', iv: [0, 4, 8], opt: [] },
    { id: 'm7b5', iv: [0, 3, 6, 10], opt: [] },
    { id: 'mM7', iv: [0, 3, 7, 11], opt: [7] },
    { id: 'add9', iv: [0, 2, 4, 7], opt: [7] },
    { id: 'madd9', iv: [0, 2, 3, 7], opt: [7] },
    { id: '9', iv: [0, 2, 4, 7, 10], opt: [7] },
    { id: 'm9', iv: [0, 2, 3, 7, 10], opt: [7] },
    { id: 'M9', iv: [0, 2, 4, 7, 11], opt: [7] },
    { id: '69', iv: [0, 2, 4, 7, 9], opt: [7] },
    { id: 'm69', iv: [0, 2, 3, 7, 9], opt: [7] },
    { id: 'mM9', iv: [0, 2, 3, 7, 11], opt: [7] },
    { id: '7b9', iv: [0, 1, 4, 7, 10], opt: [7] },
    { id: '7#9', iv: [0, 3, 4, 7, 10], opt: [7] },
    { id: '7b5', iv: [0, 4, 6, 10], opt: [] },
    { id: 'aug7', iv: [0, 4, 8, 10], opt: [] },
    { id: 'M7#5', iv: [0, 4, 8, 11], opt: [] },
    { id: '7#11', iv: [0, 4, 6, 7, 10], opt: [7] },
    { id: 'M7#11', iv: [0, 4, 6, 7, 11], opt: [7] },
    { id: '13', iv: [0, 4, 7, 9, 10], opt: [7] },
    { id: '7b13', iv: [0, 4, 7, 8, 10], opt: [7] },
    { id: 'm11', iv: [0, 3, 5, 7, 10], opt: [7] },
    { id: '5', iv: [0, 7], opt: [] },
  ];
  const BY_ID = {};
  TYPES.forEach((t, rank) => { t.rank = rank; BY_ID[t.id] = t; });

  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  // How arranger keyboards usually show roots: sharps for C# and F#, flats for Eb, Ab and Bb.
  const MIXED = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  const pc = (n) => ((n % 12) + 12) % 12;
  // A pitch class as a name. spelling: 'mixed' (default), 'sharps' or 'flats'.
  function pcName(p, spelling) {
    return (spelling === 'sharps' ? SHARPS : spelling === 'flats' ? FLATS : MIXED)[pc(p)];
  }
  // A MIDI note as a name with octave, C4 = 60 (middle C).
  const noteName = (n, spelling) => pcName(n, spelling) + (Math.floor(n / 12) - 1);

  // The chord's name, e.g. 'Bbm7/F', or '' for none.
  function chordName(c, spelling) {
    if (!c) return '';
    return pcName(c.root, spelling) + c.type + (c.bass != null && c.bass !== c.root ? '/' + pcName(c.bass, spelling) : '');
  }

  // A chord name back to a chord, e.g. 'Bbm7/F' -> { root: 10, type: 'm7', bass: 5 }. Throws on anything else.
  function parseChord(text) {
    const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(String(text).trim());
    if (!m || !BY_ID[m[3]]) throw new Error('Unknown chord “' + text + '”.');
    const acc = (a) => (a === '#' ? 1 : a === 'b' ? -1 : 0);
    const root = pc(PC[m[1]] + acc(m[2]));
    const bass = m[4] ? pc(PC[m[4]] + acc(m[5])) : null;
    return { root, type: m[3], bass: bass === root ? null : bass };
  }

  // The pitch classes of a chord (root first), e.g. Am7 -> [9, 0, 4, 7].
  const chordPcs = (c) => BY_ID[c.type].iv.map((i) => pc(c.root + i));
  const sameChord = (a, b) => (!a && !b) || (!!a && !!b && a.root === b.root && a.type === b.type &&
    (a.bass == null ? null : a.bass) === (b.bass == null ? null : b.bass));

  const ChordNames = { TYPES, BY_ID, SHARPS, FLATS, MIXED, PC, pc, pcName, noteName, chordName, parseChord, chordPcs, sameChord };
  if (typeof module !== 'undefined' && module.exports) module.exports = ChordNames;
  else (window.Arranger = window.Arranger || {}).ChordNames = ChordNames;
}());
