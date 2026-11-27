// SoundFontSynth: the built-in synth, an output the page can use in place of a MIDI port. It plays through a SoundFont
// (.sf2) with FluidSynth compiled to WebAssembly (js-synthesizer, in lib/). .sf3 isn't supported: the SF2-only
// FluidSynth build is about 4x smaller than the one with the Ogg / FLAC decoders SF3 needs.
//
// One engine, on every device: FluidSynth renders on the page's own thread through a ScriptProcessorNode with a
// 2048-frame buffer (~43 ms). That's what sounded smooth on the iPad (2026-11-25), where the alternatives didn't:
//   - FluidSynth in an AudioWorklet (128-frame blocks, ~3 ms; only on https / localhost there): "horrible, very choppy".
//   - FluidSynth in a Web Worker feeding a copy-only output: "more choppy … not as smooth as before".
//   - Smaller ScriptProcessor buffers: 1024 clean, 512 / 256 "robotic", and the right hand no sooner.
// FluidSynth and the bank live in a hidden same-origin frame (sf-frame.html). It runs on the page's thread like the
// page itself, but it can be thrown away: WebAssembly memory never shrinks, so a new bank gets a new frame, and the
// old bank's memory really goes back. The AudioContext and the ScriptProcessor stay on the page (a tap on the page
// is what lets the audio start), and the processor calls the frame's synth to render.
//
//   new SoundFontSynth({ base, clock, onChange })
//     base     put before the frame's address, synth/sf-frame.html ('': the page is index.html)
//     clock()  ms, the same clock as the timestamps passed to send (performance.now in the page)
//   send(bytes, time)       like MIDIOutput.send: channel messages, played at time (clock ms), or now without one.
//                           Timed messages go through FluidSynth's own sequencer, which runs on the samples rendered;
//                           the page's clock is mapped onto it, measured again 4 times a second.
//   load(arrayBuffer, name) -> Promise<{ presets }>   replaces the bank. The buffer is handed over (don't use it
//                           afterwards). The old bank goes first, with its whole frame, so two banks are never in
//                           memory together; if the new one fails, there's no bank.
//                           Memory while loading: the file once plus what FluidSynth keeps (sf-load.js), not 4x.
//   resume()                starts the audio (browsers only allow it after a tap or key press)
//   setGain(0..1), gain
//   park() / unpark()       another output is in use: silence and suspend the audio / resume it
//   status: 'off' | 'starting' | 'ready' | 'stalled' (the audio stopped rendering: restart()) | 'error';  bankName;  error;  suspended()
//   onRender                called at the start of each audio block (~43 ms; it keeps running in the background)
//   timed()                 the audio is running and its clock has been measured since it (re)started: timed sends land on time
//   toEvent(bytes)          (static) the js-synthesizer sequencer event for a channel message, or null
// The frame (and so the libraries) is made the first time the synth is needed, so a page that only uses MIDI ports
// doesn't load them.
// Loaded as a classic script (window.Arranger.SoundFontSynth) or with require() in Node (tests: toEvent, send).
(function () {
  'use strict';

  const RESYNC_MS = 250, SYNC_WINDOW = 8;       // tick readings: 4 a second, the last 2 s used
  const FRAMES = 2048;                            // the ScriptProcessor's buffer (~43 ms)

  function toEvent(d) {
    const st = d[0] & 0xF0, channel = d[0] & 0x0F;
    switch (st) {
      case 0x80: return { type: 'noteoff', channel, key: d[1] };
      case 0x90: return d[2] ? { type: 'noteon', channel, key: d[1], vel: d[2] } : { type: 'noteoff', channel, key: d[1] };
      case 0xA0: return { type: 'keypressure', channel, key: d[1], value: d[2] };
      case 0xB0: return { type: 'controlchange', channel, control: d[1], value: d[2] };
      case 0xC0: return { type: 'programchange', channel, preset: d[1] };
      case 0xD0: return { type: 'channelpressure', channel, value: d[1] };
      case 0xE0: return { type: 'pitchbend', channel, value: (d[2] << 7) | d[1] };
      default: return null;
    }
  }

  // FluidSynth's sequencer runs a note-off before a note-on of the same tick, whatever order they were sent in. The
  // player ends a note at its own start when the style stops or an ending cuts it, so that note-off is moved just
  // after its note-on, or the note hangs. A note-off sent before the next note-on (a re-struck key) keeps its tick:
  // there, off first is right. lastOn: channel * 128 + key -> the ticks of its last timed note-ons (several: with
  // PLAY IN BACKGROUND the player sends 1.5 s ahead, and a key can be struck twice in that time). An off moves
  // after a note-on on its own tick, or after the last note-on when it's just before it (a clock resync moved it a
  // little early). Moving any off before the last note-on past it (as it was) held an early note over the next
  // one: after a chord change the old chord's notes rang into the new one (2026-11-26).
  const RESYNC_SLACK = 30;
  function noteTick(lastOn, ev, tick) {
    const k = ev.channel * 128 + ev.key;
    if (ev.type === 'noteon') { const l = lastOn[k] || (lastOn[k] = []); l.push(tick); if (l.length > 16) l.shift(); return tick; }
    const l = ev.type === 'noteoff' && lastOn[k];
    if (!l || !l.length) return tick;
    const last = Math.max.apply(null, l);
    if (tick <= last && last - tick < RESYNC_SLACK) return last + 1;
    return l.indexOf(tick) >= 0 ? tick + 1 : tick;
  }

  // An event played at once on a js-synthesizer synth.
  function play(s, ev) {
    const c = ev.channel;
    switch (ev.type) {
      case 'noteon': s.midiNoteOn(c, ev.key, ev.vel); break;
      case 'noteoff': s.midiNoteOff(c, ev.key); break;
      case 'keypressure': s.midiKeyPressure(c, ev.key, ev.value); break;
      case 'controlchange': s.midiControl(c, ev.control, ev.value); break;
      case 'programchange': s.midiProgramChange(c, ev.preset); break;
      case 'channelpressure': s.midiChannelPressure(c, ev.value); break;
      case 'pitchbend': s.midiPitchBend(c, ev.value); break;
      default: break;
    }
  }

  class SoundFontSynth {
    constructor(o) {
      const opt = o || {};
      this.base = opt.base || '';
      this.frameUrl = opt.frame || 'synth/sf-frame.html?v=2';
      this.clock = opt.clock || (() => performance.now());
      this.onChange = opt.onChange || (() => {});
      this.status = 'off'; this.error = ''; this.bankName = '';
      this.gain = opt.gain == null ? 0.5 : opt.gain;
      this.ctx = null; this.node = null; this.freshCtx = null;
      this.frame = null; this.frameRate = 0;     // the hidden frame with FluidSynth, and its sample rate
      this.synth = null; this.seq = null; this.sfontId = null;
      this.offset = null;              // sequencer tick - clock(), in ms
      this.starting = null;
      this.syncTimer = null;
      this.lastOn = {};                // channel * 128 + key -> ticks of its last timed note-ons (noteTick)
      this.onRender = null;            // called by each audio block before it renders (the page's background pacing)
      this.readings = [];
      this.parked = false;             // audio suspended on purpose (another output is in use)
      this.loading = false;
      this.lastTick = null; this.lastMove = 0;   // the watchdog: when the sequencer's tick last moved
      this.fresh = true;               // the next clock reading replaces the offset (see sync)
    }

    // Silence everything and drop what's queued.
    quiet() {
      try { if (this.synth) this.synth.midiAllSoundsOff(); } catch (e) { /* not ready */ }
      try { if (this.seq) this.seq.removeAllEvents(); } catch (e) { /* not ready */ }
      this.lastOn = {};
    }

    // Another output took over: silence, let the buffers play out that silence, then suspend the audio. It frees the
    // CPU and the iPad's audio for the other synth, and nothing stale is left in a buffer to come back as a click
    // when the audio starts again.
    park() {
      this.parked = true;
      if (!this.synth) return;
      this.quiet();
      setTimeout(() => { if (this.parked && this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }, 150);
    }
    unpark() { this.parked = false; this.resume(); }

    // Called from a tap or key press on the page (iOS only starts audio from one). A plain suspend is resumed. Audio
    // that iOS interrupted (the app went to the background, another audio app) or that stopped rendering is replaced:
    // a new AudioContext is made right here, inside the tap, so it may play; status 'stalled' makes the page build
    // the audio again on it (restart(), start()).
    wake() {
      if (this.parked || !this.ctx || this.freshCtx) return;   // one tap fires several events: one new context
      const st = this.ctx.state;
      if (st === 'running' && this.status !== 'stalled') return;
      if (st === 'suspended' && this.status !== 'stalled') {
        const ctx = this.ctx;
        ctx.resume().then(() => { this.lastMove = this.clock(); this.sync(); this.changed(); }, () => {});
        // Still not running a moment later: replace it on the next tap.
        setTimeout(() => { if (ctx === this.ctx && ctx.state !== 'running' && !this.parked) { this.status = 'stalled'; this.changed(); } }, 600);
        return;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      try { this.freshCtx = new Ctx({ latencyHint: 'interactive' }); this.freshCtx.resume(); } catch (e) { this.freshCtx = null; }
      if (this.status !== 'stalled') { this.status = 'stalled'; this.changed(); }
    }

    // Closes the audio: used when it has stalled (see sync); start() again. The frame and its bank stay (the same
    // sample rate on the new audio is all they need), so nothing is loaded again.
    async restart() {
      if (this.starting) { try { await this.starting; } catch (e) { /* closed below anyway */ } }
      if (this.syncTimer != null) { clearInterval(this.syncTimer); this.syncTimer = null; }
      this.quiet();                              // nothing stale when the audio comes back
      if (this.node) { this.node.onaudioprocess = null; try { this.node.disconnect(); } catch (e) { /* gone */ } }
      try { if (this.ctx) await this.ctx.close(); } catch (e) { /* already closed */ }
      this.ctx = null; this.node = null;
      this.offset = null; this.readings = []; this.starting = null;
      this.lastTick = null; this.status = 'off'; this.error = '';
      this.changed();
    }
    // Back from the background: give the audio a moment before the watchdog judges it, and try to resume it (iOS may
    // refuse without a tap; then the page asks for one).
    visible() { this.lastMove = this.clock(); this.resume(); }

    changed() { try { this.onChange(this); } catch (e) { /* the page's problem */ } }

    suspended() { return !!this.ctx && this.ctx.state !== 'running'; }
    timed() { return !!this.ctx && this.ctx.state === 'running' && this.status === 'ready' && this.offset != null && !this.fresh; }

    start() {
      if (this.starting) return this.starting;
      this.status = 'starting'; this.changed();
      this.starting = (async () => {
        if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') throw new Error('No Web Audio here');
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = this.freshCtx || new Ctx({ latencyHint: 'interactive' });   // freshCtx: made in a tap (wake)
        this.freshCtx = null;
        if (!ctx.createScriptProcessor) throw new Error('No ScriptProcessor here');
        await this.openFrame(ctx.sampleRate);
        // The page's processor renders whatever synth the frame has now (none while a new frame starts: silence).
        const node = ctx.createScriptProcessor(FRAMES, 0, 2);
        node.onaudioprocess = (e) => {
          if (this.onRender) this.onRender();
          const s = this.synth, b = e.outputBuffer;
          if (s) s.render(b);
          else { b.getChannelData(0).fill(0); b.getChannelData(1).fill(0); }
        };
        node.connect(ctx.destination);
        this.ctx = ctx; this.node = node;
        ctx.onstatechange = () => this.changed();
        await this.sync();
        this.syncTimer = setInterval(() => { this.sync(); }, RESYNC_MS);
        if (this.parked) ctx.suspend().catch(() => {});
        this.status = 'ready'; this.changed();
      })().catch((e) => {
        this.status = 'error'; this.error = e && e.message ? e.message : String(e);
        this.starting = null; this.changed();
        throw e;
      });
      return this.starting;
    }

    // A frame with FluidSynth at this sample rate: the one there is, or a new one (then without a bank).
    async openFrame(rate) {
      if (this.frame && this.frameRate === rate) return;
      this.closeFrame();
      const f = document.createElement('iframe');
      f.hidden = true; f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
      f.style.display = 'none';
      const loaded = new Promise((resolve, reject) => {
        f.onload = resolve;
        f.onerror = () => reject(new Error('Could not load the synth'));
      });
      f.src = this.base + this.frameUrl;
      document.body.appendChild(f);
      this.frame = f; this.frameRate = rate;
      await loaded;
      const w = f.contentWindow;
      if (!w || !w.arrangerBoot) { this.closeFrame(); throw new Error('Could not load the synth'); }
      const r = await w.arrangerBoot(rate, { initialGain: this.gain, polyphony: 256 });
      if (f !== this.frame) return;              // closed meanwhile
      this.synth = r.synth; this.seq = r.seq;
      this.offset = null; this.readings = []; this.lastOn = {};
    }
    // Throws the frame away, and FluidSynth's memory with it (once nothing here points into it any more).
    closeFrame() {
      this.synth = null; this.seq = null; this.sfontId = null; this.bankName = '';
      this.offset = null; this.readings = []; this.lastOn = {};
      if (this.frame) { this.frame.remove(); this.frame = null; this.frameRate = 0; }
    }

    // The sequencer's tick against the page's clock. The tick only moves when a block of audio is made (every 43 ms),
    // so a reading lags by up to a block: the highest of the last few readings is the true one. A small change is
    // smoothed, a large one (the audio was suspended, the tab slept) taken as it is.
    async sync() {
      if (!this.seq) return;
      const t0 = this.clock();
      const tick = await this.seq.getTick();
      const t1 = this.clock();
      // The watchdog: with the audio running, the tick has to move. On the iPad the audio can stop rendering after
      // iOS interrupts it (another audio app), while the context still says 'running': the synth goes silent for
      // good. 1.5 s without a move: status 'stalled', and the page builds the audio again.
      const moved = this.lastTick !== tick;
      if (this.parked || this.loading || !this.ctx || this.ctx.state !== 'running' || moved) { this.lastTick = tick; this.lastMove = t1; }
      else if (t1 - this.lastMove > 1500 && this.status === 'ready') { this.status = 'stalled'; this.changed(); return; }
      // A tick that stands still (the audio is suspended, e.g. until the first tap) says nothing about the clock.
      // Taken as readings, they were the highest of the window once the audio started, and notes came up to 1.5 s
      // late (desktop Chrome, 2026-11-25). The first reading after the audio starts again is taken as it is.
      if (!moved || this.ctx.state !== 'running') { this.fresh = true; return; }
      if (t1 - t0 > 30) return;                 // a slow answer says little
      if (this.fresh) { this.fresh = false; this.offset = tick - (t0 + t1) / 2; this.readings = [this.offset]; return; }
      this.readings.push(tick - (t0 + t1) / 2);
      if (this.readings.length > SYNC_WINDOW) this.readings.shift();
      const est = Math.max.apply(null, this.readings);
      if (this.offset == null || Math.abs(est - this.offset) > 15) { this.offset = est; this.readings = [est]; }
      else this.offset += (est - this.offset) * 0.3;
    }

    resume() {
      if (this.parked) return;                  // another output is in use: stay quiet
      if (this.ctx && this.ctx.state !== 'running') {
        const p = this.ctx.resume();
        if (p && p.then) p.then(() => { this.sync(); this.changed(); }, () => {});
      }
    }

    async load(buf, name) {
      await this.start();
      let data = buf;
      buf = null;
      this.loading = true;
      try {
        // A bank already there: a new frame, so the old bank's memory really goes (WebAssembly memory only grows).
        if (this.sfontId != null) {
          const rate = this.frameRate;
          this.closeFrame(); this.changed();
          await this.openFrame(rate);
        }
        const w = this.frame.contentWindow;
        const id = w.arrangerLoadSFont(this.synth, { buffer: data });
        data = null;
        setTimeout(() => { if (w.arrangerSweep) w.arrangerSweep(); }, 0);   // free the file's bytes now (sf-load.js)
        if (id < 0) throw new Error('Not a SoundFont FluidSynth can read');
        this.sfontId = id; this.bankName = name || '';
        this.synth.midiProgramReset();
        let presets = 0;
        try { const sf = await this.synth.getSFontObject(id); for (const p of await sf.getPresetIterable()) presets++; } catch (e) { /* only for the message */ }
        this.changed();
        return { presets };
      } finally { this.loading = false; this.lastMove = this.clock(); }
    }

    setGain(g) { this.gain = g; if (this.synth) this.synth.setGain(g); }

    send(data, time) {
      if (!this.synth || this.sfontId == null) return;
      const ev = toEvent(data);
      if (!ev) return;
      // No new notes while the audio is off (iOS keeps it off after the background until a tap): they'd wait in the
      // synth and all sound at once when the audio came back, a burst on the next tap (2026-11-26). Note-offs,
      // controllers and program changes still go in, so nothing hangs and the sounds stay right.
      if (ev.type === 'noteon' && this.suspended()) return;
      if (time == null || this.offset == null) { play(this.synth, ev); return; }
      this.seq.sendEventAt(ev, noteTick(this.lastOn, ev, Math.max(0, Math.round(time + this.offset))), true);
    }
  }
  SoundFontSynth.toEvent = toEvent;
  SoundFontSynth.noteTick = noteTick;

  if (typeof module !== 'undefined' && module.exports) module.exports = SoundFontSynth;
  else (window.Arranger = window.Arranger || {}).SoundFontSynth = SoundFontSynth;
}());
