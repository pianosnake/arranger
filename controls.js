// Controls: the arranger's buttons played from other MIDI devices (a foot switch, pads, a controller). No DOM.
//   new Controls(saved, { onAction(action), onLearn(action, assignment) })
//   ACTIONS                 [{ id, name }]: intros, mains, fill, break, endings, start/stop, start/ending (the space
//                           bar's), sync start, auto fill, tap tempo, tempo − / +
//   get(id) / assign(id, a) / clear(id) / toJSON()
//     assignment { port: { id, name } | null (any port), channel: 1-16 | 0 (any), type: 'cc' | 'note' | 'pc',
//                  number, latch }
//   handle(data, port) -> true when the message belongs to an assignment (it is used up: the keyboard and the
//                         chord detector never see it)
//     cc:   fires when the value goes up past 64 (a momentary switch's press; its release is ignored). With latch
//           (a latching pedal: one press 127, the next 0), every change across 64 fires.
//     note: fires on note-on; its note-off is used up too.
//     pc:   fires on that program change.
//   learn(id)               the next CC (value above 0), note-on or program change on any port becomes the
//                           assignment, with that port and channel. cancelLearn(); learning = the id or null.
//   describe(a)             'CC 64 · ch 1' for the settings
// Loaded as a classic script (window.Arranger.Controls) or with require() in Node (tests).
(function () {
  'use strict';

  const ACTIONS = [
    { id: 'introA', name: 'Intro A' }, { id: 'introB', name: 'Intro B' }, { id: 'introC', name: 'Intro C' },
    { id: 'mainA', name: 'Main A' }, { id: 'mainB', name: 'Main B' }, { id: 'mainC', name: 'Main C' }, { id: 'mainD', name: 'Main D' },
    { id: 'fill', name: 'Fill' }, { id: 'break', name: 'Break' },
    { id: 'endingA', name: 'Ending A' }, { id: 'endingB', name: 'Ending B' }, { id: 'endingC', name: 'Ending C' },
    { id: 'startStop', name: 'Start / Stop' }, { id: 'startEnding', name: 'Start / Ending' },
    { id: 'syncStart', name: 'Sync Start' }, { id: 'autoFill', name: 'Auto Fill' },
    { id: 'tapTempo', name: 'Tap Tempo' }, { id: 'tempoDown', name: 'Tempo −' }, { id: 'tempoUp', name: 'Tempo +' },
  ];
  const BY_ID = {};
  ACTIONS.forEach((a) => { BY_ID[a.id] = a; });

  const samePort = (want, port) => !want || (port && (want.id === port.id || (!want.id && want.name === port.name)));
  const copy = (a) => JSON.parse(JSON.stringify(a));

  class Controls {
    constructor(saved, on) {
      this.on = on || {};
      this.map = {};
      const s = saved || {};
      Object.keys(s).forEach((id) => { if (BY_ID[id] && s[id]) this.map[id] = copy(s[id]); });
      this.learning = null;
      this.high = {};               // 'port:cc:channel:number' -> its last value was >= 64
    }
    get(id) { return this.map[id] || null; }
    assign(id, a) { if (BY_ID[id]) this.map[id] = copy(a); }
    clear(id) { delete this.map[id]; }
    toJSON() { return copy(this.map); }
    learn(id) { this.learning = BY_ID[id] ? id : null; }
    cancelLearn() { this.learning = null; }

    handle(data, port) {
      if (!data || data.length < 2) return false;
      const status = data[0];
      if (status < 0x80 || status >= 0xF0) return false;
      const type = status & 0xF0, ch = (status & 0x0F) + 1;
      const kind = type === 0xB0 ? 'cc' : (type === 0x90 || type === 0x80) ? 'note' : type === 0xC0 ? 'pc' : null;
      if (!kind) return false;
      const number = data[1], value = data.length > 2 ? data[2] : 0;
      const isOn = kind === 'pc' || (kind === 'note' && type === 0x90 && value > 0) || (kind === 'cc' && value > 0);

      if (this.learning && isOn) {
        const id = this.learning;
        const a = { port: port ? { id: port.id, name: port.name } : null, channel: ch, type: kind, number, latch: false };
        this.map[id] = a;
        this.learning = null;
        if (kind === 'cc') this.high[[port ? port.id : '', kind, ch, number].join(':')] = value >= 64;
        if (this.on.onLearn) this.on.onLearn(id, copy(a));
        return true;
      }

      // A switch's state is read once per message, so several actions on one control all see the press.
      const swKey = [port ? port.id : '', kind, ch, number].join(':');
      const wasHigh = !!this.high[swKey], nowHigh = value >= 64;
      let used = false;
      ACTIONS.forEach((act) => {
        const a = this.map[act.id];
        if (!a || a.type !== kind || a.number !== number) return;
        if (a.channel && a.channel !== ch) return;
        if (!samePort(a.port, port)) return;
        used = true;
        if (kind === 'cc') { if (nowHigh !== wasHigh && (nowHigh || a.latch)) this.fire(act.id); }
        else if (kind === 'note') { if (isOn) this.fire(act.id); }
        else this.fire(act.id);
      });
      if (kind === 'cc' && used) this.high[swKey] = nowHigh;
      return used;
    }
    fire(id) { if (this.on.onAction) this.on.onAction(id); }

    static describe(a) {
      if (!a) return '—';
      const what = a.type === 'cc' ? `CC ${a.number}` : a.type === 'pc' ? `PC ${a.number + 1}` : `Note ${a.number}`;
      return `${what} · ${a.channel ? 'ch ' + a.channel : 'any ch'}${a.type === 'cc' && a.latch ? ' · latch' : ''}`;
    }
  }
  Controls.ACTIONS = ACTIONS;

  // TapTempo: tap(time ms) -> quarter notes per minute from the last taps (up to 4 intervals), or null for the
  // first tap. A gap of more than 2 s starts over.
  class TapTempo {
    constructor() { this.times = []; }
    tap(t) {
      const last = this.times[this.times.length - 1];
      if (last != null && t - last > 2000) this.times = [];
      this.times.push(t);
      if (this.times.length > 5) this.times.shift();
      if (this.times.length < 2) return null;
      const span = this.times[this.times.length - 1] - this.times[0];
      return Math.round(60000 / (span / (this.times.length - 1)));
    }
  }
  Controls.TapTempo = TapTempo;

  if (typeof module !== 'undefined' && module.exports) module.exports = Controls;
  else (window.Arranger = window.Arranger || {}).Controls = Controls;
}());
