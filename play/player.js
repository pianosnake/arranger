// StylePlayer: plays a Style. It schedules MIDI a little ahead of time (send(bytes, timestamp)), asks SectionFlow
// what comes next at every bar line, and moves notes to the chord being held (Transposer). No DOM, no Web MIDI:
// the clock, the timer and the output are passed in, so tests drive it with fakes.
//   new StylePlayer({ clock, timer, send, lookahead, interval, onChange })
//     clock() -> ms (performance.now in the page: the same clock as Web MIDI timestamps)
//     timer: { every(fn, ms) -> handle, cancel(handle) }
//     send(bytes, time)    time in clock ms; the page passes it to MIDIOutput.send
//     lookahead (100 ms): how far ahead events are sent; interval (25 ms): how often it looks
//     onChange()           the section, pending section or playing state changed
//     sendClock(bytes, time)   optional, also settable later as player.sendClock (null: no clock): MIDI clock for
//                          loopers and DAWs. Start (FA) on the first beat, 24 clocks (F8) a quarter note, continuous
//                          through section changes, style changes and tempo changes, Stop (FC) when it stops.
//   load(style, channelMap, groups?)   stops, then uses this style (groups: beat grouping, see Meter)
//   changeStyle(style, channelMap, groups?, tempo?)   while playing: the new style takes over at the next bar line,
//                                      straight into its Main A (no intro), at its own tempo (or `tempo`). Stopped:
//                                      the same as load. nextStyle is set until then.
//   start() / stop()
//   press(kind, letter)                the section buttons (SectionFlow.press)
//   setChord(chord)                    the held chord; while playing, sounding notes follow it (each pattern's
//                                      retrigger rule) and patterns that start playing for it come in. A chord
//                                      pressed a little early (up to an 8th note before a beat, SNAP_TICKS) takes
//                                      effect on that beat; one pressed on or after a beat, at once. pendingChord
//                                      holds an early one until its beat.
//   setNoteFloors({ partId: note })    notes of that part below `note` (as written in the pattern) aren't played:
//                                      Roland guitar parts use keys far below a guitar's range for strum / fret
//                                      noises, which a GM guitar plays as very low notes
//   setSoloPercussion(on)              only the drum parts play (the others are silent until it's turned off); turning
//                                      it on ends the other parts' sounding notes at once
//   setTempo(bpm)                      quarter notes per minute
//   setVolume(factor)                  the style's overall volume, 0..1.5 (1 = as written): every part's volume
//                                      (CC 7: the style's own, at its start and in its patterns; 100 where it sets none)
//                                      is scaled by it. While playing, every channel of the style gets the new level.
//   position(now) -> { section, tick, bar, pulse, group, first } | null   what is sounding now, for the display
// Before the first chord only rhythm parts play (as on arranger keyboards).
// Every note-on it sends gets its note-off, also on stop, section changes and chord changes.
// Loaded as a classic script (window.Arranger.StylePlayer) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const T = isNode ? require('./transposer.js') : window.Arranger.Transposer;
  const Meter = isNode ? require('./meter.js') : window.Arranger.Meter;
  const SectionFlow = isNode ? require('./section-flow.js') : window.Arranger.SectionFlow;
  const N = isNode ? require('./chord-names.js') : window.Arranger.ChordNames;

  const START_DELAY = 30;            // ms between pressing START and the first beat (the voices go out first)
  const ORDER = { clock: -1, off: 0, ctl: 1, on: 2 };

  function eventBytes(ev, ch) {
    const c = ch - 1;
    if (ev.type === 'cc') return [0xB0 | c, ev.cc, ev.value];
    if (ev.type === 'program') return [0xC0 | c, ev.program];
    if (ev.type === 'pitchBend') return [0xE0 | c, ev.value & 0x7F, (ev.value >> 7) & 0x7F];
    return null;
  }

  class StylePlayer {
    constructor(o) {
      this.clock = o.clock; this.timer = o.timer; this.out = o.send;
      this.lookahead = o.lookahead || 100; this.interval = o.interval || 25;
      this.onChange = o.onChange || (() => {});
      this.sendClock = o.sendClock || null;
      this.style = null; this.flow = null; this.meter = null; this.map = null;
      this.tempo = 120; this.chord = null;
      this.pendingChord = null;      // { chord, time }: pressed early, takes effect on the beat at time
      this.volume = 1;
      this.floors = {};
      this.soloPercussion = false;
      this.baseVolume = {};          // channel -> the last CC 7 value the style asked for (before scaling)
      this.playing = false; this.handle = null;
      this.seg = null;               // { section, anchorTick, anchorTime, mspt, time }: the timeline being scheduled
      this.history = [];             // recent segs, for position(): what is sounding now, not what was scheduled
      this.done = 0;                 // ticks of seg.section already scheduled
      this.sounding = [];            // notes sent: { ch, note, src, on, off, pattern }
    }

    load(style, channelMap, groups) {
      this.stop();
      this.nextStyle = null;
      this.style = style; this.map = channelMap;
      this.parts = {};
      style.parts.forEach((p) => { this.parts[p.id] = p; });
      this.meter = new Meter(style.timeSig[0], style.timeSig[1], style.ppq, groups);
      this.baseVolume = {};
      const keep = this.flow;
      this.flow = new SectionFlow(style.order);
      if (keep) this.flow.autoFill = keep.autoFill;
      this.tempo = style.tempo;
      this.onChange();
    }

    get mspt() { return 60000 / (this.tempo * this.style.ppq); }
    tickToTime(tick) { return this.seg.anchorTime + (tick - this.seg.anchorTick) * this.seg.mspt; }
    timeToTick(time) { return this.seg.anchorTick + (time - this.seg.anchorTime) / this.seg.mspt; }
    newSeg(section, time) {
      this.seg = { section, anchorTick: 0, anchorTime: time, mspt: this.mspt, time };
      this.history.push(this.seg);
      if (this.history.length > 8) this.history.shift();
      this.done = 0;
    }

    start() {
      if (this.playing || !this.style) return false;
      const first = this.flow.start();
      if (!first) return false;
      const t0 = this.clock() + START_DELAY;
      const batch = [];
      this.style.parts.forEach((p) => this.map.voiceMessages(p).forEach((m) => batch.push({ time: t0 - START_DELAY, kind: 'ctl', data: m })));
      this.levels(t0 - START_DELAY, batch, true);
      this.neutral(t0 - START_DELAY, batch);
      this.history = [];
      this.newSeg(first, t0);
      this.playing = true;
      if (this.sendClock) batch.push({ time: t0, kind: 'clock', data: [0xFA] });
      this.flush(batch);
      this.handle = this.timer.every(() => this.pump(), this.interval);
      this.pump();
      this.onChange();
      return true;
    }

    changeStyle(style, channelMap, groups, tempo) {
      if (!this.playing) {
        this.load(style, channelMap, groups);
        if (tempo) this.setTempo(tempo);
        return;
      }
      this.nextStyle = { style, map: channelMap, groups, tempo };
      this.onChange();
    }
    // At a bar line: the next style replaces the current one, starting at its Main A.
    applyStyle(next, at, batch) {
      this.nextStyle = null;
      const autoFill = this.flow.autoFill;
      this.style = next.style; this.map = next.map;
      this.parts = {};
      next.style.parts.forEach((p) => { this.parts[p.id] = p; });
      this.meter = new Meter(next.style.timeSig[0], next.style.timeSig[1], next.style.ppq, next.groups);
      this.flow = new SectionFlow(next.style.order);
      this.flow.autoFill = autoFill;
      this.flow.press('main', 'A');
      const intro = this.flow.intro;                 // straight into Main A (no intro); the intro stays selected
      this.flow.intro = null;
      const first = this.flow.start();
      this.flow.intro = intro;
      this.tempo = Math.max(20, Math.min(400, next.tempo || next.style.tempo));
      next.style.parts.forEach((p) => this.map.voiceMessages(p).forEach((m) => batch.push({ time: at, kind: 'ctl', data: m })));
      this.levels(at, batch, true);
      this.neutral(at, batch);
      if (!first) { this.releaseAll(at, batch); this.playing = false; this.stopAt = at; return false; }
      this.newSeg(first, at);
      return true;
    }

    stop() {
      this.nextStyle = null;
      if (this.pendingChord) { this.chord = this.pendingChord.chord; this.pendingChord = null; }   // pressed: it's the chord now
      if (this.handle != null) { this.timer.cancel(this.handle); this.handle = null; }
      const was = this.playing;
      this.playing = false;
      if (this.flow) this.flow.stop();
      const batch = [];
      this.releaseAll(this.clock(), batch);
      if (was) this.neutral(this.clock(), batch);
      if (was && this.sendClock) batch.push({ time: this.clock(), kind: 'clock', data: [0xFC] });
      this.flush(batch);
      this.seg = null;
      if (was) this.onChange();
    }

    press(kind, letter) {
      if (!this.flow) return;
      this.flow.press(kind, letter);
      this.onChange();
    }

    setNoteFloors(map) { this.floors = Object.assign({}, map || {}); }
    setSoloPercussion(on) {
      this.soloPercussion = !!on;
      if (!this.soloPercussion || !this.playing) return;
      const batch = [], now = this.clock();
      this.sounding.slice().forEach((s) => { if (s.part && s.part.role !== 'drums') this.end(s, Math.max(now, s.on), batch); });
      this.flush(batch);
    }
    setVolume(factor) {
      const v = Math.max(0, Math.min(1.5, Number(factor)));
      if (!(v >= 0) || v === this.volume) return;
      this.volume = v;
      if (!this.playing) return;
      const batch = [];
      this.levels(this.clock(), batch, false);
      this.flush(batch);
    }
    // CC 7 on each of the style's channels at its base level scaled by the volume. onlyUnset: just the channels the
    // style's voices don't set (they get 100 scaled, so the volume reaches them too; nothing when the volume is 1).
    levels(time, batch, onlyUnset) {
      const done = {};
      this.style.parts.forEach((p) => {
        const ch = this.map.channel(p.id);
        if (!ch || done[ch]) return;
        done[ch] = true;
        const setByVoice = p.voice && p.voice.volume != null && this.map.get(p.id).program;
        if (onlyUnset && (setByVoice || this.volume === 1)) return;
        batch.push({ time, kind: 'ctl', data: [0xB0 | (ch - 1), 7, this.baseVolume[ch] != null ? this.baseVolume[ch] : 100] });
      });
    }

    setTempo(bpm) {
      const b = Math.max(20, Math.min(400, bpm));
      if (this.playing) {                       // the new tempo starts where scheduling has got to
        const at = this.tickToTime(this.done);
        this.tempo = b;
        this.seg = { section: this.seg.section, anchorTick: this.done, anchorTime: at, mspt: this.mspt, time: at };
        this.history.push(this.seg);
      } else this.tempo = b;
    }

    // Chords are usually played a little before the beat they belong to. Applied at once, the end of the old beat
    // played with the new chord, a change between beats (2026-11-26). So a chord pressed up to an 8th note before a
    // beat (a group start, as the beat counter shows: dotted quarters in 6/8) waits for that beat; one pressed on or
    // after a beat changes at once, so a late chord isn't delayed further.
    setChord(chord) {
      this.pendingChord = null;
      const old = this.chord;
      if (!this.playing || !chord || N.sameChord(old, chord)) { this.chord = chord; return; }
      const now = this.clock();
      const tick = Math.max(0, this.timeToTick(now));
      const beat = this.meter.nextBeat(tick);
      if (beat - tick <= this.style.ppq / 2) {
        const time = this.tickToTime(beat);
        if (time > this.tickToTime(this.done)) { this.pendingChord = { chord, time }; return; }   // pump() applies it
        const batch = [];                        // that beat is already scheduled: change from it now
        this.applyChord(chord, time, batch);
        this.flush(batch);
        return;
      }
      const batch = [];
      this.applyChord(chord, now, batch);
      this.flush(batch);
    }
    // The chord changes at time `at` (now, or a beat already scheduled): sounding and scheduled notes follow it,
    // and patterns that didn't play for the old chord come in: their notes already under way (a Roland style's major
    // strings when the chord goes from Dm to G), then the stretch already scheduled ahead.
    applyChord(chord, at, batch) {
      const old = this.chord;
      this.chord = chord;
      this.revoice(at, old, batch);
      const sec = this.style.sections[this.seg.section];
      const from = Math.max(0, this.timeToTick(at));
      const fresh = (pat) => !this.playedFor(pat, old);
      this.enterHeld(sec, from, at, batch, fresh);
      if (from < this.done) this.emit(sec, from, this.done, batch, fresh);
    }
    // The notes of patterns coming in (only(pat)) that started before tick from and are still going: played from now
    // for the time they have left, as re-pitched notes are (more than a 16th, and not for a 'stop' rule).
    enterHeld(sec, from, now, batch, only) {
      const minMs = this.style.ppq / 4 * this.seg.mspt;
      Object.keys(sec.tracks).forEach((pid) => {
        const part = this.parts[pid];
        const ch = part ? this.map.channel(pid) : 0;
        if (!ch || (this.soloPercussion && part.role !== 'drums')) return;
        const boost = this.map.get(pid).velocity, floor = this.floors[pid] || 0;
        sec.tracks[pid].patterns.forEach((pat) => {
          if (!this.playedFor(pat, this.chord) || !only(pat) || pat.rule.retrigger === 'stop') return;
          const loop = pat.loopTicks > 0 && pat.loopTicks < sec.lengthTicks ? pat.loopTicks : sec.lengthTicks;
          const base = Math.floor(from / loop) * loop;
          pat.events.forEach((e) => {
            if (e.type !== 'note' || e.note < floor || e.tick >= loop) return;
            const tick = base + e.tick, end = Math.min(tick + e.duration, base + loop, sec.lengthTicks);
            if (tick >= from || end <= from) return;
            const off = this.tickToTime(end);
            if (off - now < minMs) return;
            const n = T.note(e.note, pat.rule, this.chord);
            const prev = this.sounding.find((s) => s.ch === ch && s.note === n && s.off > now);
            if (prev) this.end(prev, Math.max(now, prev.on), batch);
            const vel = boost ? Math.max(1, Math.min(127, e.velocity + boost)) : e.velocity;
            batch.push({ time: now, kind: 'on', data: [0x90 | (ch - 1), n, vel] });
            this.sounding.push({ ch, note: n, src: e.note, vel, on: now, off, pattern: pat, part });
          });
        });
      });
    }
    playedFor(pat, chord) {
      if (!chord) return T.rhythmOnly(pat.rule);
      return T.plays(pat.when, chord);
    }

    // Notes already sent follow the new chord: a note that changes pitch is ended and, unless its rule says stop,
    // played again at the new pitch for the time it has left (only if that's more than a 16th: short tails just end).
    revoice(now, old, batch) {
      const minMs = this.style.ppq / 4 * this.seg.mspt;
      this.sounding.slice().forEach((s) => {
        if (s.off <= now || T.rhythmOnly(s.pattern.rule)) return;
        const plays = T.plays(s.pattern.when, this.chord);
        const n = T.note(s.src, s.pattern.rule, this.chord);
        if (plays && n === s.note) return;
        const at = Math.max(now, s.on);
        this.end(s, at, batch);
        if (!plays || s.pattern.rule.retrigger === 'stop') return;
        if (s.on <= now && s.off - at < minMs) return;
        batch.push({ time: at, kind: 'on', data: [0x90 | (s.ch - 1), n, s.vel] });
        this.sounding.push({ ch: s.ch, note: n, src: s.src, vel: s.vel, on: at, off: s.off, pattern: s.pattern });
      });
    }

    // Pitch bend back to the centre and the mod wheel to 0 on the style's channels. A pattern that bends or adds
    // vibrato (Survive Disco's Intro B guitar) sets them back at its end, but not when it's cut short by STOP, a style
    // change or the next section: the channel then stayed bent / wobbling ("a siren") until the page was reloaded.
    neutral(at, batch) {
      const done = {};
      this.style.parts.forEach((p) => {
        const ch = this.map.get(p.id).channel;
        if (!ch || done[ch]) return;
        done[ch] = true;
        batch.push({ time: at, kind: 'ctl', data: [0xE0 | (ch - 1), 0, 64] }, { time: at, kind: 'ctl', data: [0xB0 | (ch - 1), 1, 0] });
      });
    }

    end(s, at, batch) {
      const k = this.sounding.indexOf(s);
      if (k >= 0) this.sounding.splice(k, 1);
      batch.push({ time: at, kind: 'off', data: [0x80 | (s.ch - 1), s.note, 0] });
    }
    releaseAll(at, batch) {
      this.sounding.slice().forEach((s) => this.end(s, Math.max(at, s.on), batch));
    }
    // Notes still sounding past a section change end there.
    cut(at, batch) {
      this.sounding.slice().forEach((s) => { if (s.off > at) this.end(s, Math.max(at, s.on), batch); });
    }

    pump() {
      if (!this.playing) return;
      const horizon = this.clock() + this.lookahead;
      const batch = [];
      const bar = this.meter.barTicks;
      for (let guard = 0; this.playing && guard < 256; guard++) {
        const sec = this.style.sections[this.seg.section];
        const until = this.timeToTick(horizon);
        const boundary = Math.min((Math.floor(this.done / bar + 1e-9) + 1) * bar, sec.lengthTicks);
        // A chord waiting for its beat: schedule up to the beat with the old chord, change there, go on.
        const pc = this.pendingChord;
        if (pc) {
          const at = Math.max(this.done, Math.round(this.timeToTick(pc.time)));
          if (at < Math.min(until, boundary)) {
            this.emit(sec, this.done, at, batch); this.emitClock(this.done, at, batch); this.done = at;
            this.pendingChord = null;
            this.applyChord(pc.chord, this.tickToTime(at), batch);
            continue;
          }
        }
        if (until < boundary) { this.emit(sec, this.done, until, batch); this.emitClock(this.done, until, batch); this.done = until; break; }
        this.emit(sec, this.done, boundary, batch);
        this.emitClock(this.done, boundary, batch);
        this.done = boundary;
        if (this.nextStyle) {                   // a style change takes over at this bar line
          const t = this.tickToTime(boundary);
          this.flushOffs(t, batch);
          this.cut(t, batch);
          if (!this.applyStyle(this.nextStyle, t, batch) && this.handle != null) { this.timer.cancel(this.handle); this.handle = null; }
          continue;
        }
        const ended = boundary >= sec.lengthTicks;
        const next = this.flow.atBar(ended);
        const at = this.tickToTime(boundary);
        if (next === 'stop') {
          this.flushOffs(at, batch);
          this.releaseAll(at, batch);
          this.neutral(at, batch);
          if (this.sendClock) batch.push({ time: at, kind: 'clock', data: [0xFC] });
          this.playing = false;
          if (this.handle != null) { this.timer.cancel(this.handle); this.handle = null; }
          this.stopAt = at;
          break;
        }
        if (next === null && !ended) continue;
        this.flushOffs(at, batch);
        this.cut(at, batch);
        if (next && next !== this.seg.section) this.neutral(at, batch);
        this.newSeg(next || this.seg.section, at);
      }
      this.flushOffs(horizon, batch);
      this.flush(batch);
      if (!this.playing) this.onChange();
      else if (this.lastSection !== this.seg.section || this.lastPending !== this.flow.pending) this.onChange();
      this.lastSection = this.seg ? this.seg.section : null;
      this.lastPending = this.flow.pending;
    }

    // The events of a section between two ticks (from included), for the patterns that play for the chord.
    emit(sec, from, to, batch, only) {
      Object.keys(sec.tracks).forEach((pid) => {
        const part = this.parts[pid];
        const ch = part ? this.map.channel(pid) : 0;
        if (!ch) return;
        if (this.soloPercussion && part.role !== 'drums') return;
        const boost = this.map.get(pid).velocity;
        const floor = this.floors[pid] || 0;
        sec.tracks[pid].patterns.forEach((pat) => {
          if (!this.playedFor(pat, this.chord)) return;
          if (only && !only(pat)) return;
          // A pattern shorter than its section (loopTicks) repeats until the section ends; its notes are cut at
          // each repeat and at the section's end.
          const loop = pat.loopTicks > 0 && pat.loopTicks < sec.lengthTicks ? pat.loopTicks : sec.lengthTicks;
          for (let base = Math.floor(from / loop) * loop; base < to && base < sec.lengthTicks; base += loop) {
            pat.events.forEach((e) => {
              const tick = base + e.tick;
              if (e.tick >= loop || tick < from || tick >= to || tick >= sec.lengthTicks) return;
              const time = this.tickToTime(tick);
              if (e.type === 'note') {
                if (e.note < floor) return;
                const n = T.note(e.note, pat.rule, this.chord);
                const prev = this.sounding.find((s) => s.ch === ch && s.note === n && s.off > time);
                if (prev) this.end(prev, Math.max(time, prev.on), batch);
                const end = Math.min(tick + e.duration, base + loop, sec.lengthTicks);
                const vel = boost ? Math.max(1, Math.min(127, e.velocity + boost)) : e.velocity;
                batch.push({ time, kind: 'on', data: [0x90 | (ch - 1), n, vel] });
                this.sounding.push({ ch, note: n, src: e.note, vel, on: time, off: this.tickToTime(end), pattern: pat, part });
              } else {
                const f = this.map.filter(part, e);
                const bytes = f && eventBytes(f, ch);
                if (bytes) batch.push({ time, kind: 'ctl', data: bytes });
              }
            });
          }
        });
      });
    }

    // MIDI clock between two ticks of the section playing: one every ppq/24 ticks, counted from the section's start
    // (sections are whole bars, so the clocks run on evenly from one section to the next).
    emitClock(from, to, batch) {
      if (!this.sendClock) return;
      const step = this.style.ppq / 24;
      for (let k = Math.ceil(from / step - 1e-9); k * step < to - 1e-9; k++) batch.push({ time: this.tickToTime(k * step), kind: 'clock', data: [0xF8] });
    }

    flushOffs(until, batch) {
      this.sounding.slice().forEach((s) => { if (s.off < until) this.end(s, s.off, batch); });
    }

    flush(batch) {
      batch.forEach((m, k) => { m.k = k; });
      batch.sort((a, b) => a.time - b.time || ORDER[a.kind] - ORDER[b.kind] || a.k - b.k);
      batch.forEach((m) => {
        // Volume (CC 7): remember what the style asked for, send it scaled by the style volume.
        if (m.kind === 'ctl' && (m.data[0] & 0xF0) === 0xB0 && m.data[1] === 7) {
          const ch = (m.data[0] & 0x0F) + 1;
          this.baseVolume[ch] = m.data[2];
          if (this.volume !== 1) m.data = [m.data[0], 7, Math.max(0, Math.min(127, Math.round(m.data[2] * this.volume)))];
        }
        if (m.kind !== 'clock') this.out(m.data, m.time);
        else if (this.sendClock) this.sendClock(m.data, m.time);
      });
    }

    position(now) {
      if (!this.history.length || (!this.playing && !(this.stopAt > now))) return null;
      let seg = null;
      for (let k = this.history.length - 1; k >= 0; k--) if (this.history[k].time <= now) { seg = this.history[k]; break; }
      if (!seg) return null;
      const tick = seg.anchorTick + (now - seg.anchorTime) / seg.mspt;
      return Object.assign({ section: seg.section, tick }, this.meter.position(tick));
    }
  }
  StylePlayer.eventBytes = eventBytes;

  if (isNode) module.exports = StylePlayer;
  else (window.Arranger = window.Arranger || {}).StylePlayer = StylePlayer;
}());
