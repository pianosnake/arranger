// Transposer: a pattern note, written over the pattern's source chord, played over the chord being held. No DOM.
//   Transposer.note(n, rule, chord) -> MIDI note
//   Transposer.plays(when, chord)  whether a pattern plays for this chord (its root mask and chord types)
//   Transposer.rhythmOnly(rule)    true for rules that never transpose (drums): they play before the first chord too
// rule (style.js): { sourceRoot, sourceChord, ntr, ntt, highKey, lowLimit, highLimit }.
//   NTR rootTrans:  the pattern moves with the root. It goes up by the interval from the source root, and drops an
//                   octave for roots above highKey.
//   NTR rootFixed:  the notes stay where they are, each moved to the nearest note that fits the new chord.
//   NTT bypass:     the notes move with the root only (rootFixed + bypass = drums: nothing changes).
//   NTT chord:      each note keeps its role. Root, 3rd, 5th, 6th, 7th and tensions go to the new chord's
//                   equivalents; a 7th becomes the 6th or the root when the new chord has none.
//   NTT bass:       like chord, but the root becomes the bass note of a slash chord (C/E: the bass line plays E).
//   NTT melody:     each note keeps its scale degree, in a 7-note scale made from the new chord. melodicMinor and
//                   harmonicMinor are melody with those scales on minor chords.
//   The result is folded by octaves into lowLimit..highLimit.
// A Roland style has no rules beyond the root: its readers give rootTrans + bypass with the right source chord.
// Loaded as a classic script (window.Arranger.Transposer) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const N = isNode ? require('./chord-names.js') : window.Arranger.ChordNames;
  const pc = N.pc;

  const has = (iv, x) => iv.indexOf(x) >= 0;
  const ivOf = (type) => (N.BY_ID[type] || N.BY_ID['']).iv;

  // A note's role in a chord, from its interval above the root.
  function roleOf(rel, iv) {
    if (rel === 0) return 'root';
    if (rel === 3 || rel === 4) return has(iv, 3) && has(iv, 4) && rel === 3 ? 'ninth' : 'third';   // 7#9: 3 is the #9
    if (rel === 6 || rel === 7 || rel === 8) {
      if (rel === 6 && has(iv, 7)) return 'eleventh';                     // #11 next to a perfect 5th
      if (rel === 8 && has(iv, 7)) return 'sixth';                        // b13
      return 'fifth';
    }
    if (rel === 9) return has(iv, 9) && has(iv, 3) && has(iv, 6) && !has(iv, 10) ? 'seventh' : 'sixth';   // dim7's 7th
    if (rel === 10 || rel === 11) return 'seventh';
    if (rel === 1 || rel === 2) return 'ninth';
    return 'eleventh';                                                    // 5
  }

  // The interval in the target chord that plays a role.
  function intervalFor(role, iv) {
    const pick = (list) => list.find((x) => has(iv, x));
    switch (role) {
      case 'root': return 0;
      case 'third': { const t = pick([4, 3]); return t != null ? t : pick([5, 2]) != null ? pick([5, 2]) : 0; }
      case 'fifth': { const f = pick([7, 6, 8]); return f != null ? f : 7; }
      case 'sixth': { const s = pick([9, 8, 10, 11]); return s != null ? s : 7; }   // else the 7th, else the 5th
      case 'seventh': {
        const s = pick([10, 11]);
        if (s != null) return s;
        if (has(iv, 9)) return 9;                                         // dim7, 6: the nearest thing to a 7th
        return 0;
      }
      case 'ninth': { const n = pick([2, 1]); return n != null ? n : (has(iv, 3) && has(iv, 4) ? 3 : 0); }
      case 'eleventh': { const e = pick([5, 6]); return e != null ? e : intervalFor('third', iv); }
      default: return 0;
    }
  }

  // A 7-note scale for a chord: major, with the chord's own notes put in their slots.
  // ntt melodicMinor / harmonicMinor change the 6th and 7th of minor chords.
  function scaleFor(type, ntt) {
    const iv = ivOf(type);
    const s = [0, 2, 4, 5, 7, 9, 11];
    const minor = has(iv, 3) && !has(iv, 4);
    if (has(iv, 1)) s[1] = 1;
    if (minor) s[2] = 3;
    if (has(iv, 3) && has(iv, 4)) s[1] = 3;                               // 7#9
    if (has(iv, 6) && !has(iv, 7)) s[4] = 6;                              // b5
    if (has(iv, 6) && has(iv, 7)) s[3] = 6;                               // #11
    if (has(iv, 8) && !has(iv, 7)) s[4] = 8;                              // #5
    if (has(iv, 8) && has(iv, 7)) s[5] = 8;                               // b13
    if (has(iv, 10)) s[6] = 10;
    if (minor && !has(iv, 11) && !has(iv, 9)) s[6] = 10;                  // minor triads: dorian
    if (type === 'dim7') { s[5] = 8; s[6] = 9; }
    if (minor && ntt === 'harmonicMinor') { s[5] = 8; s[6] = 11; }
    if (minor && ntt === 'melodicMinor') { s[5] = 9; s[6] = 11; }
    return s;
  }

  // The scale degree of rel in a scale, with a chromatic offset for notes between degrees.
  function degreeOf(rel, scale) {
    for (let d = 6; d >= 0; d--) if (scale[d] <= rel) return { d, off: rel - scale[d] };
    return { d: 0, off: rel };
  }

  // How far the root moves: up from the source root, down an octave past highKey.
  function rootDelta(rule, chord) {
    let up = pc(chord.root - rule.sourceRoot);
    const highKey = rule.highKey == null ? 11 : rule.highKey;
    if (up > 0 && chord.root > highKey) up -= 12;
    return up;
  }
  // The note nearest to `near` with pitch class p (ties go down).
  const nearest = (near, p) => { const d = pc(p - near); return d >= 6 ? near + d - 12 : near + d; };

  function note(n, rule, chord) {
    if (!chord || rhythmOnly(rule)) return n;
    const srcIv = ivOf(rule.sourceChord);
    const tgtIv = ivOf(chord.type);
    const rel = pc(n - rule.sourceRoot);
    let targetPc;
    if (rule.ntt === 'bypass') targetPc = pc(n + chord.root - rule.sourceRoot);
    else if (rule.ntt === 'melody' || rule.ntt === 'melodicMinor' || rule.ntt === 'harmonicMinor') {
      const { d, off } = degreeOf(rel, scaleFor(rule.sourceChord, 'melody'));
      targetPc = pc(chord.root + scaleFor(chord.type, rule.ntt)[d] + off);
    } else {
      const role = roleOf(rel, srcIv);
      if (rule.ntt === 'bass' && role === 'root' && chord.bass != null) targetPc = chord.bass;
      else targetPc = pc(chord.root + intervalFor(role, tgtIv));
    }
    let out;
    if (rule.ntr === 'rootFixed') out = nearest(n, targetPc);
    else out = nearest(n + rootDelta(rule, chord), targetPc);
    return fold(out, rule.lowLimit, rule.highLimit);
  }

  function fold(n, low, high) {
    const lo = low == null ? 0 : low, hi = high == null ? 127 : high;
    if (hi - lo >= 11) {
      while (n < lo) n += 12;
      while (n > hi) n -= 12;
    }
    return Math.max(0, Math.min(127, n));
  }

  function rhythmOnly(rule) { return !rule || (rule.ntr === 'rootFixed' && rule.ntt === 'bypass'); }

  function plays(when, chord) {
    if (!when) return true;
    if (!chord) return true;
    if (when.roots != null && !(when.roots & (1 << chord.root))) return false;
    return when.chordTypes === 'all' || when.chordTypes.indexOf(chord.type) >= 0;
  }

  const Transposer = { note, plays, rhythmOnly, roleOf, intervalFor, scaleFor, rootDelta, fold };
  if (isNode) module.exports = Transposer;
  else (window.Arranger = window.Arranger || {}).Transposer = Transposer;
}());
