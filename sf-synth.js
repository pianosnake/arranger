// SoundFontSynth: the built-in synth, an output the page can use in place of a MIDI port. It plays through a SoundFont
// (.sf2) with FluidSynth compiled to WebAssembly
// (js-synthesizer, in lib/). .sf3 isn't supported: the SF2-only FluidSynth build is
// about 4x smaller than the one with the Ogg / FLAC decoders SF3 needs.
// Two engines, chosen by the engine option ('auto' unless a test asks; the page has no setting for it since
// 2026-11-25): 'worklet' runs FluidSynth in an AudioWorklet (low latency: 128-frame blocks, ~3 ms);
// 'main' runs it on the page's own thread through a ScriptProcessorNode with a 2048-frame buffer (~43 ms). On the
// iPad the worklet sounded choppy (2026-11-25: it misses some of its 3 ms deadlines, and there's no buffer to cover
// them) while the big buffer was smooth, so 'auto' picks 'main' on iPad / iPhone and 'worklet' elsewhere. Without
// AudioWorklet (Safari and iOS web views only have it on https:// or localhost) it's always 'main'.
// Smaller 'main' buffers (1024, 512, 256) were tried on the iPad (2026-11-25): the right hand wasn't any sooner, so
// the buffer size isn't offered.
//   new SoundFontSynth({ base, clock, onChange })
//     base     where lib/ is ('lib/')
//     clock()  ms, the same clock as the timestamps passed to send (performance.now in the page)
//   send(bytes, time)       like MIDIOutput.send: channel messages, played at time (clock ms), or now without one.
//                           Timed messages go through FluidSynth's own sequencer, which runs on the audio clock; the
//                           page's clock is mapped onto it, measured again every second.
//   load(arrayBuffer, name) -> Promise<{ presets }>   replaces the bank. The buffer is handed over (transferred
//                           to the audio thread: don't use it afterwards). The old bank is unloaded first, so two
//                           banks are never in memory together; if the new one fails, there's no bank.
//                           Memory while loading: the file once plus what FluidSynth keeps (sf-load.js), not 4x.
//   resume()                starts the audio (browsers only allow it after a tap or key press)
//   setGain(0..1), gain
//   park() / unpark()       another output is in use: silence and suspend the audio / resume it
//   status: 'off' | 'starting' | 'ready' | 'stalled' (the audio stopped rendering: restart()) | 'error';  bankName;  error;  suspended()
//   toEvent(bytes)          (static) the js-synthesizer sequencer event for a channel message, or null
// The libraries are loaded the first time the synth is needed, so a page that only uses MIDI ports doesn't load them.
// Loaded as a classic script (window.Arranger.SoundFontSynth) or with require() in Node (tests: toEvent only).
(function () {
  'use strict';

  const LIB_FLUIDSYNTH = 'libfluidsynth-2.4.6.js';     // SF2 only: no libsndfile, so no SF3
  const LIB_MAIN = 'js-synthesizer.min.js', LIB_WORKLET = 'js-synthesizer.worklet.min.js';
  const RESYNC_MS = 250, SYNC_WINDOW = 8;       // tick readings: 4 a second, the last 2 s used
  const MAIN_FRAMES = 2048;                       // the 'main' engine's ScriptProcessor buffer (~43 ms)

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

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  class SoundFontSynth {
    constructor(o) {
      const opt = o || {};
      this.base = opt.base || 'lib/';
      this.loader = opt.loader || 'sf-load.js?v=2';     // arrangerLoadSFont, for the worklet and the page
      this.engine = opt.engine || 'auto';           // 'auto' | 'worklet' | 'main'
      this.clock = opt.clock || (() => performance.now());
      this.onChange = opt.onChange || (() => {});
      this.status = 'off'; this.error = ''; this.bankName = '';
      this.gain = opt.gain == null ? 0.5 : opt.gain;
      this.ctx = null; this.synth = null; this.seq = null; this.sfontId = null;
      this.offset = null;              // sequencer tick - clock(), in ms
      this.starting = null;
      this.syncTimer = null;
      this.lastOn = {};                // channel * 128 + key -> tick of the last timed note-on
      this.mode = '';                  // 'worklet' or 'main'
      this.readings = [];
      this.parked = false;             // audio suspended on purpose (another output is in use)
      this.lastTick = null; this.lastMove = 0;   // the watchdog: when the sequencer's tick last moved
    }

    // Another output took over: silence everything (and drop what's queued), let the buffers play out that silence,
    // then suspend the audio. It frees the CPU and the iPad's audio for the other synth, and nothing stale is left in
    // a buffer to come back as a click when the audio starts again.
    park() {
      this.parked = true;
      if (!this.synth) return;
      try { this.synth.midiAllSoundsOff(); } catch (e) { /* not ready */ }
      try { if (this.seq) this.seq.removeAllEvents(); } catch (e) { /* not ready */ }
      this.lastOn = {};
      setTimeout(() => { if (this.parked && this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }, 150);
    }
    unpark() { this.parked = false; this.resume(); }

    // Called from a tap or key press on the page (iOS only starts audio from one). A plain suspend is resumed. Audio
    // that iOS interrupted (the app went to the background, another audio app) or that stopped rendering is replaced:
    // a new AudioContext is made right here, inside the tap, so it may play; status 'stalled' makes the page build
    // the synth again on it (restart(), start(), load()).
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

    // Closes the audio and forgets the bank: used when the audio has stalled (see sync); start() and load() again.
    async restart() {
      if (this.starting) { try { await this.starting; } catch (e) { /* closed below anyway */ } }
      if (this.syncTimer != null) { clearInterval(this.syncTimer); this.syncTimer = null; }
      try { if (this.synth) this.synth.close(); } catch (e) { /* already gone */ }
      try { if (this.ctx) await this.ctx.close(); } catch (e) { /* already closed */ }
      this.ctx = null; this.synth = null; this.seq = null; this.sfontId = null; this.bankName = '';
      this.offset = null; this.readings = []; this.lastOn = {}; this.starting = null; this.mode = '';
      this.lastTick = null; this.status = 'off'; this.error = '';
      this.changed();
    }
    // Back from the background: give the audio a moment before the watchdog judges it, and try to resume it (iOS may
    // refuse without a tap; then the page asks for one).
    visible() { this.lastMove = this.clock(); this.resume(); }

    changed() { try { this.onChange(this); } catch (e) { /* the page's problem */ } }

    suspended() { return !!this.ctx && this.ctx.state !== 'running'; }

    start() {
      if (this.starting) return this.starting;
      this.status = 'starting'; this.changed();
      this.starting = (async () => {
        if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') throw new Error('No Web Audio here');
        if (!window.JSSynth) await loadScript(this.base + LIB_MAIN);
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = this.freshCtx || new Ctx({ latencyHint: 'interactive' });   // freshCtx: made in a tap (wake)
        this.freshCtx = null;
        const settings = { initialGain: this.gain, polyphony: 256 };
        let synth, seq;
        if (ctx.audioWorklet && this.engine !== 'main' && !(this.engine === 'auto' && SoundFontSynth.isIOS())) {
          await ctx.audioWorklet.addModule(this.base + LIB_FLUIDSYNTH);
          await ctx.audioWorklet.addModule(this.base + LIB_WORKLET);
          await ctx.audioWorklet.addModule(this.loader);
          synth = new window.JSSynth.AudioWorkletNodeSynthesizer();
          synth.init(ctx.sampleRate, settings);
          synth.createAudioNode(ctx).connect(ctx.destination);
          seq = await synth.createSequencer();
          this.mode = 'worklet';
        } else {
          if (!ctx.createScriptProcessor) throw new Error('No AudioWorklet or ScriptProcessor here');
          if (!window.Module || !window.Module._new_fluid_synth) await loadScript(this.base + LIB_FLUIDSYNTH);
          if (!window.arrangerLoadSFont) await loadScript(this.loader);
          window.JSSynth.Synthesizer.initializeWithFluidSynthModule(window.Module);
          await window.JSSynth.Synthesizer.waitForWasmInitialized();
          synth = new window.JSSynth.Synthesizer();
          synth.init(ctx.sampleRate, settings);
          synth.createAudioNode(ctx, MAIN_FRAMES).connect(ctx.destination);
          seq = await window.JSSynth.Synthesizer.createSequencer();
          this.mode = 'main';
        }
        await seq.registerSynthesizer(synth);
        this.ctx = ctx; this.synth = synth; this.seq = seq;
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

    // The sequencer's tick against the page's clock. The tick only moves when a block of audio is made (3 ms in the
    // worklet, 43 ms without it), so a reading lags by up to a block: the highest of the last few readings is the
    // true one. A small change is smoothed, a large one (the audio was suspended, the tab slept) taken as it is.
    async sync() {
      if (!this.seq) return;
      const t0 = this.clock();
      const tick = await this.seq.getTick();
      const t1 = this.clock();
      // The watchdog: with the audio running, the tick has to move. On the iPad the audio can stop rendering after
      // iOS interrupts it (another audio app), while the context still says 'running': the synth goes silent for
      // good. 1.5 s without a move: status 'stalled', and the page builds the synth again.
      if (this.parked || !this.ctx || this.ctx.state !== 'running' || this.lastTick !== tick) { this.lastTick = tick; this.lastMove = t1; }
      else if (t1 - this.lastMove > 1500 && this.status === 'ready') { this.status = 'stalled'; this.changed(); return; }
      if (t1 - t0 > 30) return;                 // a slow answer says little
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
      if (this.sfontId != null) {
        const old = this.sfontId;
        this.sfontId = null; this.bankName = '';
        await this.synth.unloadSFontAsync(old);
      }
      const id = await this.loadBytes(data);
      data = null;
      this.sfontId = id; this.bankName = name || '';
      this.synth.midiProgramReset();
      let presets = 0;
      try { presets = (await this.presets()).length; } catch (e) { /* only for the message */ }
      this.changed();
      return { presets };
    }

    // FluidSynth reads the bank through arrangerLoadSFont (sf-load.js): in the worklet the buffer is transferred, not
    // copied, and the answer comes back on a MessagePort.
    async loadBytes(data) {
      let r;
      if (this.mode === 'worklet') {
        const ch = new MessageChannel();
        const answer = new Promise((resolve) => { ch.port1.onmessage = (ev) => { ch.port1.close(); resolve(ev.data); }; });
        await this.synth.callFunction('arrangerLoadSFont', { buffer: data, port: ch.port2 }, [data, ch.port2]);
        r = await answer;
        // Let the audio thread's collector free the file's bytes now (see arrangerSweep in sf-load.js).
        const sweep = new MessageChannel();
        const swept = new Promise((resolve) => { sweep.port1.onmessage = () => { sweep.port1.close(); resolve(); }; });
        await this.synth.callFunction('arrangerSweep', { port: sweep.port2 }, [sweep.port2]);
        await swept;
      } else {
        const id = window.arrangerLoadSFont(this.synth, { buffer: data });
        r = { id, error: id < 0 ? 'Not a SoundFont FluidSynth can read' : '' };
        data = null;
        setTimeout(() => { if (window.arrangerSweep) window.arrangerSweep(); }, 0);   // free the file's bytes now
      }
      if (r.id < 0) throw new Error(r.error || 'Could not load the bank');
      return r.id;
    }

    async presets() {
      if (this.sfontId == null) return [];
      const sf = await this.synth.getSFontObject(this.sfontId);
      const out = [];
      const it = await sf.getPresetIterable();
      for (const p of it) out.push(p);
      return out;
    }

    setGain(g) { this.gain = g; if (this.synth) this.synth.setGain(g); }

    send(data, time) {
      if (!this.synth || this.sfontId == null) return;
      const ev = toEvent(data);
      if (!ev) return;
      if (time == null || this.offset == null) { this.now(ev); return; }
      let tick = Math.max(0, Math.round(time + this.offset));
      // FluidSynth's sequencer runs a note-off before a note-on of the same tick, whatever order they were sent in.
      // The player ends a note at its own start when the style stops or an ending cuts it, so that note-off is
      // moved just after its note-on, or the note hangs. A note-off sent before the next note-on (a re-struck key)
      // keeps its tick: there, off first is right.
      const k = ev.channel * 128 + ev.key;
      if (ev.type === 'noteon') this.lastOn[k] = tick;
      else if (ev.type === 'noteoff' && this.lastOn[k] != null && tick <= this.lastOn[k]) tick = this.lastOn[k] + 1;
      this.seq.sendEventAt(ev, tick, true);
    }
    now(ev) {
      const s = this.synth, c = ev.channel;
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
  }
  SoundFontSynth.toEvent = toEvent;
  // An iPad or iPhone (an iPad asking for the desktop site says MacIntel, but has a touch screen).
  SoundFontSynth.isIOS = () => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

  if (typeof module !== 'undefined' && module.exports) module.exports = SoundFontSynth;
  else (window.Arranger = window.Arranger || {}).SoundFontSynth = SoundFontSynth;
}());
