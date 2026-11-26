// SectionFlow: what the section buttons do, as a state machine with no timing. The player asks it what comes
// next at each bar line (atBar), so every change lands on a bar line of the section playing.
//   new SectionFlow(sectionIds)           the ids the style has ('introA', 'mainB', 'fillAB', 'breakAA', 'endingC')
//   press(kind, letter)                   kind: 'intro' | 'main' | 'fill' | 'break' | 'ending'; letter 'A'-'D'
//   start() -> first section id           stop()
//   atBar(ended) -> id | 'stop' | null    at a bar line; ended = the section reached its end. null: keep playing
//                                         (a main that ended loops)
//   State for the page: playing, current, pending (switches at the next bar line), after (where a one-shot
//   goes next), main (the selected main letter), intro (the selected intro: START plays it; null = none),
//   ending (the selected ending: STOP plays it; null = stop at once), autoFill.
//   intro and ending start as the style's first ones and stay selected from one start to the next.
// While stopped:
//   - INTRO selects the intro START plays, then the main (the selected one again: no intro).
//   - ENDING selects the ending STOP plays (the selected one again: STOP stops at once).
//   - MAIN selects which main START (or the intro) leads to.
// While playing:
//   - MAIN X goes to main X at the next bar line. With auto-fill, a fill comes first (see fillFor).
//   - FILL / BREAK play a fill / break of the current main, then go back to it.
//   - ENDING plays that ending, then stops.
//   - INTRO plays that intro, then the main.
//   - During an intro, fill or break, MAIN only changes where it goes next.
//   The last press before a bar line wins. A section the style doesn't have falls back to the nearest one it has.
// Newer four-main Yamaha styles name their fills AA, BB, CC, DD (the fill into that main) and their break "Fill In
// BA". So a style with Fill In BA, no Fill In AB and no break section plays Fill In BA as its BREAK, not as a fill
// (breakAlias). The reader keeps the section as fillBA, so the style's music hash and saved settings stay the same.
// Loaded as a classic script (window.Arranger.SectionFlow) or with require() in Node (tests).
(function () {
  'use strict';
  const LETTERS = ['A', 'B', 'C', 'D'];
  const kindOf = (id) => (id ? /^[a-z]+/.exec(id)[0] : null);
  const letterOf = (id) => (id ? id.replace(/^[a-z]+/, '').charAt(0) : null);
  // The section a style's BREAK plays when it has no break section: Fill In BA in a style without Fill In AB.
  function breakAlias(ids) {
    const has = (id) => ids.indexOf(id) >= 0;
    if (ids.some((id) => kindOf(id) === 'break') || !has('fillBA') || has('fillAB')) return null;
    return 'fillBA';
  }

  class SectionFlow {
    constructor(ids) {
      this.ids = ids.slice();
      this.has = {};
      ids.forEach((id) => { this.has[id] = true; });
      this.breakId = breakAlias(ids);
      if (this.breakId) delete this.has[this.breakId];    // not a fill in this style
      this.playing = false;
      this.current = null; this.pending = null; this.after = null;
      this.main = this.mains()[0] || 'A';
      this.intro = this.oneOf('intro', 'A');
      this.ending = this.oneOf('ending', 'A');
      this.autoFill = true;
    }
    mains() { return LETTERS.filter((l) => this.has['main' + l]); }
    // The main to play for a letter: that one, else the nearest letter the style has.
    mainId(letter) {
      const ms = this.mains();
      if (!ms.length) return null;
      if (ms.indexOf(letter) >= 0) return 'main' + letter;
      const k = LETTERS.indexOf(letter);
      const best = ms.slice().sort((a, b) => Math.abs(LETTERS.indexOf(a) - k) - Math.abs(LETTERS.indexOf(b) - k))[0];
      return 'main' + best;
    }
    // A section of a kind for a letter: kind+letter, else the nearest letter of that kind.
    oneOf(kind, letter) {
      if (this.has[kind + letter]) return kind + letter;
      const k = LETTERS.indexOf(letter);
      const all = this.ids.filter((id) => kindOf(id) === kind);
      all.sort((a, b) => Math.abs(LETTERS.indexOf(letterOf(a)) - k) - Math.abs(LETTERS.indexOf(letterOf(b)) - k));
      return all[0] || null;
    }
    // The fill from main X to main Y:
    //   - Fill In XY (older two-main styles have AB and BA),
    //   - else Fill In YY (newer styles: the fill into Y),
    //   - else Fill In XX,
    //   - else none.
    fillFor(from, to) {
      const tries = from !== to ? ['fill' + from + to, 'fill' + to + to, 'fill' + from + from] : ['fill' + to + to];
      return tries.find((id) => this.has[id]) || null;
    }
    breakFor(letter) {
      return ['break' + letter + letter, 'break' + letter].find((id) => this.has[id]) || this.ids.find((id) => kindOf(id) === 'break') || this.breakId;
    }
    // What a section is in this style: its kind, except the break alias, which is a 'break'.
    roleOf(id) { return id && id === this.breakId ? 'break' : kindOf(id); }
    get currentKind() { return this.roleOf(this.current); }

    press(kind, letter) {
      if (!this.playing) {
        if (kind === 'intro') { const id = this.oneOf('intro', letter); if (id) this.intro = this.intro === id ? null : id; }
        else if (kind === 'ending') { const id = this.oneOf('ending', letter); if (id) this.ending = this.ending === id ? null : id; }
        else if (kind === 'main') { const id = this.mainId(letter); if (id) this.main = letterOf(id); }
        return;
      }
      const cur = this.currentKind;
      if (kind === 'main') {
        const id = this.mainId(letter);
        if (!id) return;
        const to = letterOf(id);
        this.main = to;
        if (cur === 'intro' || cur === 'fill' || cur === 'break') {      // finish it, then go to the new main
          if (this.pending && this.roleOf(this.pending) !== 'main') this.after = id;
          else { this.pending = null; this.after = id; }
          return;
        }
        const from = cur === 'main' ? letterOf(this.current) : to;
        const fill = this.autoFill ? this.fillFor(from, to) : null;
        if (fill) { this.pending = fill; this.after = id; } else { this.pending = id === this.current ? null : id; this.after = null; }
      } else if (kind === 'fill') {
        const fill = this.fillFor(this.main, this.main);
        if (fill) { this.pending = fill; this.after = this.mainId(this.main); }
      } else if (kind === 'break') {
        const br = this.breakFor(this.main);
        if (br) { this.pending = br; this.after = this.mainId(this.main); }
      } else if (kind === 'ending') {
        const end = this.oneOf('ending', letter);
        if (end) { this.pending = end; this.after = 'stop'; this.ending = end; }
      } else if (kind === 'intro') {
        const intro = this.oneOf('intro', letter);
        if (intro) { this.pending = intro; this.after = this.mainId(this.main); }
      }
    }

    start() {
      const first = this.intro || this.mainId(this.main);
      if (!first) return null;
      this.playing = true;
      this.current = first; this.pending = null;
      this.after = kindOf(first) === 'intro' ? this.mainId(this.main) : null;
      return first;
    }
    // STOP while playing: true = stop now (no ending selected, or the ending already playing / queued); else the
    // selected ending is queued and the style stops after it.
    requestStop() {
      if (!this.playing) return true;
      if (!this.ending || this.roleOf(this.current) === 'ending' || this.roleOf(this.pending) === 'ending') return true;
      this.pending = this.ending; this.after = 'stop';
      return false;
    }
    stop() { this.playing = false; this.current = null; this.pending = null; this.after = null; }

    atBar(ended) {
      if (!this.playing) return 'stop';
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.current = next;
        if (kindOf(next) === 'main') this.after = null;
        return next;
      }
      if (!ended) return null;
      const cur = this.currentKind;
      if (cur === 'main') return null;                          // a main loops
      const next = this.after || (cur === 'ending' ? 'stop' : this.mainId(this.main));
      this.after = null;
      if (next === 'stop' || !next) { this.stop(); return 'stop'; }
      this.current = next;
      return next;
    }
  }
  SectionFlow.kindOf = kindOf;
  SectionFlow.letterOf = letterOf;
  SectionFlow.breakAlias = breakAlias;

  if (typeof module !== 'undefined' && module.exports) module.exports = SectionFlow;
  else (window.Arranger = window.Arranger || {}).SectionFlow = SectionFlow;
}());
