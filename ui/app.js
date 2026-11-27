// Arranger page: the DOM and Web MIDI wiring. The logic lives in the classes it loads (chord-detector.js,
// keyboard-input.js, midi-ports.js, ...), which have no DOM and are tested in Node.
// Plain JS, no libraries or network (only the page's own files, e.g. defaults/): it must run unmodified in desktop Chrome and inside the MIDI Charmer AUv3
// (iPad, iOS 15 WebKit: no class fields, no .at(), no container queries).
(function () {
  'use strict';
  const A = window.Arranger;
  const N = A.ChordNames;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STORE = 'arranger-settings';

  // ---------- settings ----------
  function load() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } }
  const saved = load();
  const state = {
    kbPort: saved.kbPort || {},                  // { id, name } of the keyboard input, or { none: true }
    channel: saved.channel == null ? 0 : saved.channel,
    split: saved.split == null ? 55 : saved.split,
    memory: saved.memory == null ? true : !!saved.memory,
    styleId: saved.styleId || null,              // the style last loaded from the library
    outPort: saved.outPort || {},                // { id, name } of the output, or { none: true }
    outMode: saved.outMode === 'midi' ? 'midi' : 'synth', // OUTPUT › SOUND: the built-in SoundFont synth (default: it has a bank, FreeFont) or a MIDI port
    clockPort: saved.clockPort || { none: true }, // where MIDI clock goes; none by default
    rhChannel: saved.rhChannel || 0,             // right hand (keys from the split up) to this channel; 0 = off
    // The default PARTS setup is the built-in one (ChannelMap defaults). Older versions saved PARTS changes here for
    // every style (a part muted once stayed muted everywhere); that saved setup is dropped. A style's own changes are
    // in its settings (parts), kept by its music hash.
    channelMap: {},
    autoFill: saved.autoFill == null ? true : !!saved.autoFill,
    chordStart: !!saved.chordStart,              // a chord played while stopped starts the style
    controls: saved.controls || {},              // Controls.toJSON(): action -> { port, channel, type, number }
    collapsed: saved.collapsed || {},            // style list: folder name -> collapsed
    partsOpen: !!saved.partsOpen,                // the PARTS table shown (the bar opens / closes it)
    showFolders: saved.showFolders == null ? true : !!saved.showFolders,   // LAYOUT › SHOW FOLDERS: the list grouped by folder
    defaultsAdded: !!saved.defaultsAdded,        // the built-in styles (defaults/) were offered once; never again
  };
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* private mode, full storage */ }
  }

  // ---------- chords and keyboard ----------
  const detector = new A.ChordDetector({
    memory: state.memory,
    onChord: (c) => { renderChord(c); player.setChord(c); },     // null (memory off, keys up): rhythm only
    // SYNC START (once) or CHORD STARTS STYLE (always): a chord while stopped starts the style.
    onPress: () => {
      if (!current || player.playing || !(sync.armed || state.chordStart)) return;
      sync.armed = false;
      startStop();
    },
  });
  const sync = { armed: false };
  const keyboard = new A.KeyboardInput({
    channel: state.channel, split: state.split,
    lower: detector,
    upper: (d) => {
      const t = d[0] & 0xF0;
      // The right hand plays through on its own channel, straight away: nothing is drawn for it. Not while the page is
      // in the background (see 'background' below).
      if (state.rhChannel && midi.output && !hidden()) {
        try { midi.output.send([t | (state.rhChannel - 1)].concat(Array.from(d).slice(1))); } catch (e) { /* port gone */ }
      }
    },
    onSplit: (note) => {
      state.split = note; save();
      $('kb-split').value = String(note);
      $('kb-learn').setAttribute('aria-pressed', 'false');
    },
  });

  // The chord name, shrunk to fit its box when it's long (Bbm7b5/Ab): from the full size down in 4 px steps, 28 px at
  // the least.
  function renderChord(c) {
    const el = $('chord');
    el.textContent = c ? N.chordName(c) : '–';
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize) || 92;
    while (el.scrollWidth > el.clientWidth + 1 && size > 28) { size -= 4; el.style.fontSize = size + 'px'; }
  }

  // ---------- MIDI ----------
  const midi = { access: null, input: null, output: null, clock: null };
  const hub = new A.MidiPorts.InputHub();
  function setConn(text, cls) { const el = $('conn-status'); el.textContent = text; el.className = 'status ' + cls; }
  function setStatus(text) { $('status-text').textContent = text || ''; }

  // A port menu: (none) plus each port, kept apart by id; ports sharing a name are numbered ("Bluetooth 1", "Bluetooth 2").
  // Port menus give each port its place in the list as the value (not its id: some browsers have no usable ids).
  function fillPortMenu(sel, ports, current) {
    sel.innerHTML = '<option value="">(none)</option>' + ports.map((p, k) => `<option value="${k}">${esc(A.MidiPorts.label(ports, p))}</option>`).join('');
    sel.value = current && ports.indexOf(current) >= 0 ? String(ports.indexOf(current)) : '';
  }
  const chosen = (ports, value) => (value === '' ? null : ports[Number(value)] || null);

  function connect() {
    if (!midi.access) return;
    const ins = A.MidiPorts.list(midi.access.inputs);
    hub.setPorts(ins);
    const input = A.MidiPorts.pick(ins, state.kbPort);
    midi.input = input;
    hub.route('keyboard', input, (data) => keyboard.handle(data), 0);
    // Controls listen on every input and come first: a foot switch's messages never reach the keyboard.
    hub.routeAll('controls', (data, port) => controls.handle(data, port), 10);
    renderControls();
    fillPortMenu($('kb-port'), ins, input);
    pickOutput();
    const outs = A.MidiPorts.list(midi.access.outputs);
    const clockOut = A.MidiPorts.pick(outs, state.clockPort);
    if (clockOut !== midi.clock && midi.clock && player.playing) { try { midi.clock.send([0xFC]); } catch (e) { /* port gone */ } }
    midi.clock = clockOut;
    player.sendClock = clockOut ? (data, time) => { try { clockOut.send(data, time); } catch (e) { /* port gone */ } } : null;
    fillPortMenu($('clock-port'), outs, clockOut);
    if (input) setConn('Connected', 'on');
    else setConn(ins.length ? 'No keyboard' : 'No MIDI inputs', 'off');
    setStatus(input ? input.name : '');
  }

  // The output the player sends to: the built-in synth (OUTPUT › SOUND: SOUNDFONT) or the chosen MIDI port.
  function pickOutput() {
    const outs = midi.access ? A.MidiPorts.list(midi.access.outputs) : [];
    const port = A.MidiPorts.pick(outs, state.outPort);
    const output = state.outMode === 'synth' ? synth : port;
    if (output !== midi.output) {
      if (player.playing) player.stop();           // changing the output stops the song
      if (midi.output) panic(midi.output);         // leave nothing sounding on the old output
      if (output) panic(output);                   // nor anything a previous page left on the new one
      if (midi.output === synth) synth.park();     // the built-in synth goes quiet and stops using CPU
      if (output === synth) synth.unpark();
    }
    midi.output = output;
    fillPortMenu($('out-port'), outs, port);
    renderSynth();
  }

  async function start() {
    pickOutput();                                  // the built-in synth works without Web MIDI
    if (!navigator.requestMIDIAccess) {
      setConn('No Web MIDI', 'off');
      setStatus('Use Chrome, or the MIDI Charmer plugin on iPad.');
      return;
    }
    try {
      midi.access = await navigator.requestMIDIAccess();
    } catch (e) {
      setConn('MIDI blocked', 'off'); setStatus(e && e.message ? e.message : String(e));
      return;
    }
    midi.access.onstatechange = connect;
    connect();
  }
  // The refresh button in the settings: asks the browser for MIDI access again (some, like the iOS Web MIDI Browser
  // app, only list devices connected since then that way) and rebuilds every port menu. The choices stay.
  async function refreshMidi() {
    const b = $('midi-refresh');
    b.classList.add('spin');
    if (navigator.requestMIDIAccess) {
      try {
        const fresh = await navigator.requestMIDIAccess();
        if (midi.access && midi.access !== fresh) midi.access.onstatechange = null;
        midi.access = fresh;
        midi.access.onstatechange = connect;
      } catch (e) { /* keep the access we had */ }
    }
    if (midi.access) connect();
    renderControls();
    const n = (m) => (midi.access ? A.MidiPorts.list(m).length : 0);
    setStatus(midi.access ? `MIDI ports: ${n(midi.access.inputs)} in, ${n(midi.access.outputs)} out.` : 'No Web MIDI here.');
    setTimeout(() => b.classList.remove('spin'), 400);
  }
  $('midi-refresh').addEventListener('click', refreshMidi);

  // ---------- built-in synth ----------
  // OUTPUT › SOUND: SOUNDFONT plays the style here, through FluidSynth (WebAssembly) and a .sf2 bank. The bank
  // file is kept in IndexedDB (as the File itself, so a big bank isn't copied into memory to store it) and loads
  // again with the page. The synth has send(data, time) like a MIDI output, so the player, the right hand and PANIC
  // use it as one.
  const synth = new A.SoundFontSynth({ clock: () => performance.now(), onChange: () => { renderSynth(); if (synth.status === 'stalled') rebuildSynth(); } });
  window.arrangerSynth = synth;                  // for checking from the browser's console
  const bankStore = (() => {
    const open = () => new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('No IndexedDB')); return; }
      const r = indexedDB.open('arranger-soundfont', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('bank');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction('bank', mode), req = fn(t.objectStore('bank'));
      t.oncomplete = () => { db.close(); resolve(req.result); };
      t.onerror = t.onabort = () => { db.close(); reject(t.error); };
    }));
    return {
      get: () => run('readonly', (st) => st.get('current')).catch(() => null),
      put: (name, file) => run('readwrite', (st) => st.put({ name, file }, 'current')),
    };
  })();
  const sfView = { msg: '', warn: false, loading: false, tapShown: '' };
  const startWait = { timer: null, until: 0 };   // a start waiting for the sound to come back (waitForSound)
  function sfMsg(text, warn) { sfView.msg = text; sfView.warn = !!warn; renderSynth(); }
  function renderSynth() {
    const on = state.outMode === 'synth';
    $('out-mode').value = state.outMode;
    $('out-port-field').hidden = on;
    $('sf-field').hidden = !on;
    $('rh-note').hidden = !on;
    $('sf-mem-note').hidden = !on;                 // a bank costs about its file size in memory                     // the right hand through the built-in synth is a little late
    $('sf-name').textContent = sfView.loading ? 'Loading…' : (synth.bankName || 'No bank');
    let text = sfView.msg, warn = sfView.warn;
    if (synth.status === 'error') { text = `The synth didn't start: ${synth.error}`; warn = true; } else if (synth.status === 'starting') text = 'Starting the synth…';
    else if (!synth.bankName && !sfView.loading && !warn) text = 'Choose a General MIDI bank (.sf2).';
    const needTap = on && !!synth.bankName && (synth.suspended() || synth.status === 'stalled');
    if (needTap) { text = 'Tap anywhere on the page to start the sound.'; warn = true; }
    // The same in the header, where it's seen while playing (the settings are usually closed).
    const tapText = !needTap ? '' : startWait.timer != null ? 'Tap the page to start the sound: the style starts then.' : 'Tap the page to start the sound';
    if (tapText !== sfView.tapShown) { sfView.tapShown = tapText; setStatus(tapText || (midi.input ? midi.input.name : '')); }
    $('sf-status').hidden = !on || !text;
    $('sf-status').textContent = text;
    $('sf-status').classList.toggle('warn', warn);
  }
  async function loadBank(file, keep) {
    if (/\.(sf3|dls)$/i.test(file.name)) { sfMsg(`${file.name}: only .sf2 banks work here. Convert it to .sf2 with Polyphone (free, polyphone.io).`, true); return; }
    sfView.loading = true; sfMsg(`Loading ${file.name}…`);
    try {
      // Not kept in a variable: the synth hands the bytes on (transferred, not copied) and nothing else holds them.
      const r = await synth.load(await file.arrayBuffer(), file.name);
      sfView.loading = false;
      sfMsg(`${r.presets} sounds.`);
      if (keep) bankStore.put(file.name, file).catch(() => sfMsg(`${r.presets} sounds. It couldn't be kept on this device: choose it again next time.`, true));
    } catch (e) {
      sfView.loading = false;
      const why = e && e.message ? e.message : String(e);
      sfMsg(`Could not load ${file.name}${why && why !== 'Error' ? ` (${why})` : ''}. Use a .sf2 bank (convert .sf3 / .dls with Polyphone); very large banks may not fit in memory.`, true);
    }
  }
  // The audio stopped rendering (the watchdog in SoundFontSynth): new audio. The synth keeps its bank (its frame stays).
  let rebuilding = false;
  async function rebuildSynth() {
    if (rebuilding) return;
    rebuilding = true;
    if (player.playing && midi.output === synth) player.stop();
    await synth.restart();
    synthBooted = false;
    if (state.outMode === 'synth') { await bootSynth(); sfMsg('The sound had stopped: the synth was started again.', true); }
    rebuilding = false;
  }
  let synthBooted = false;
  // What comes with the app, in defaults/: a General MIDI bank and some styles (library.json and styles/, laid out
  // like an unzipped backup). The styles are added once, on the first start; the bank is used until one is chosen.
  const DEFAULT_BANK = 'FreeFont.sf2';
  async function fetchDefault(path) {
    const r = await fetch('defaults/' + path.split('/').map(encodeURIComponent).join('/'));
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async function bootSynth() {
    if (synthBooted) return;
    synthBooted = true;
    try { await synth.start(); } catch (e) { synthBooted = false; return; }
    if (synth.bankName) return;
    const rec = await bankStore.get();
    if (rec && rec.file) { if (!synth.bankName) await loadBank(rec.file, false); return; }
    // No bank chosen yet: the one that comes with the app (defaults/, fetched each time, not kept in IndexedDB).
    if (!synth.bankName) await loadBank({ name: DEFAULT_BANK, arrayBuffer: () => fetchDefault(DEFAULT_BANK).then((b) => b.buffer) }, false);
  }
  // Browsers start audio only from a tap or a key press.
  // wake() also replaces audio that iOS interrupted (the app was in the background, another audio app played).
  ['pointerdown', 'touchend', 'keydown', 'click'].forEach((t) => document.addEventListener(t, () => synth.wake(), true));
  // ---------- background ----------
  // In the background the browser slows the page's timers down (iOS stops them), so the player fell behind, notes
  // came late and slow, and on coming back everything it had missed went out at once. So the page stops sending:
  // the style stops (with its note-offs and MIDI clock Stop), the right hand isn't passed on, and nothing starts
  // until the page is back. "Background": the page is hidden (another app or tab in front, the iPad's home screen,
  // the screen off). Not a mere loss of focus: clicking into another window on the Mac keeps it playing.
  const hidden = () => document.visibilityState === 'hidden';
  // The built-in synth also drops what it had queued: the style schedules ~100 ms ahead, and on the iPad iOS takes
  // the audio away with those notes still waiting, so the next tap that started the audio again played a bit of
  // rhythm (2026-11-25). Again on coming back, for anything that came in on the way out.
  function toBackground() {
    sync.armed = false;
    stopWaiting();
    const was = player.playing;
    if (was) player.stop();
    synth.quiet();
    if (was) { panic(); setStatus('Stopped: the page went to the background.'); }
    renderTransport();
  }
  document.addEventListener('visibilitychange', () => {
    if (hidden()) { toBackground(); return; }
    if (!player.playing) synth.quiet();
    synth.visible();
  });
  window.addEventListener('pagehide', toBackground);
  $('out-mode').addEventListener('change', (ev) => {
    state.outMode = ev.target.value === 'synth' ? 'synth' : 'midi';
    save();
    if (state.outMode === 'synth') { synth.resume(); bootSynth(); }
    pickOutput();
  });
  $('sf-file').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    synth.resume();
    await loadBank(file, true);
  });

  // ---------- player ----------
  // Sends with a timestamp: the player schedules ~100 ms ahead. Without an output it still runs (the display moves).
  // The PARTS setup of the loaded style: the defaults, with the style's own changes (settings.parts) on top.
  const styleMapFor = (set) => {
    const merged = JSON.parse(JSON.stringify(state.channelMap));
    const own = (set && set.parts) || {};
    Object.keys(own).forEach((pid) => { merged[pid] = Object.assign({}, merged[pid] || {}, own[pid]); });
    return new A.ChannelMap(merged);
  };
  let channelMap = styleMapFor(null);
  const player = new A.StylePlayer({
    clock: () => performance.now(),
    timer: { every: (fn, ms) => setInterval(fn, ms), cancel: (h) => clearInterval(h) },
    send: (data, time) => { if (midi.output) { try { midi.output.send(data, time); } catch (e) { /* port gone */ } } },
    onChange: () => renderTransport(),
  });
  // PANIC: on every channel, sustain off, all sound off, all notes off and reset all controllers. Also sent when the page connects to an
  // output, which ends notes left hanging by a page reloaded mid-song.
  // Not sent while the page unloads, and no MIDIOutput.clear(): Chrome 150 on macOS 12 crashed in its MIDI service
  // (2026-11-24) when both were in place; one of them is the likely cause, not confirmed which.
  function panic(out) {
    const o = out || midi.output;
    if (!o) return;
    try {
      // Also reset all controllers (121): pitch bend, mod wheel, expression; a bend left by a cut-off pattern goes too.
      for (let c = 0; c < 16; c++) { o.send([0xB0 | c, 64, 0]); o.send([0xB0 | c, 120, 0]); o.send([0xB0 | c, 123, 0]); o.send([0xB0 | c, 121, 0]); }
    } catch (e) { /* port gone */ }
  }
  // A short flash on START / STOP when it acts (tap, space bar or a foot switch): it "took".
  function flashStart() {
    const b = $('start');
    b.classList.remove('took');
    void b.offsetWidth;                            // restart the animation if it's still running
    b.classList.add('took');
  }
  $('start').addEventListener('animationend', () => $('start').classList.remove('took'));
  function startStop() {
    if (!current) return;
    if (!player.playing && hidden()) return;       // nothing starts in the background (a chord, a foot switch)
    if (!player.playing && soundOff()) { waitForSound(); return; }
    flashStart();
    if (player.playing) player.stop(); else { player.setChord(detector.chord); player.start(); }
    renderTransport();
  }

  // Back from the background on the iPad, iOS keeps the built-in synth's audio off until a tap on the page; a MIDI
  // key or switch doesn't count. A style started then played into the stopped synth, and its notes all came out at
  // once on the next tap (2026-11-26). So a start while the sound is off (START from a controller, SYNC START, a
  // chord) waits instead: the header asks for a tap, and the style starts as soon as the sound is back and the
  // synth's clock is measured again, so it starts on time. Pressing START again cancels; so does the background.
  const soundOff = () => midi.output === synth && (synth.suspended() || synth.status !== 'ready');
  function stopWaiting(msg) {
    if (startWait.timer == null) return;
    clearInterval(startWait.timer); startWait.timer = null;
    $('start').classList.remove('waiting');
    renderSynth();
    if (msg != null) setStatus(msg);
  }
  function waitForSound() {
    if (startWait.timer != null) { stopWaiting('Start cancelled.'); return; }
    synth.resume();                                // iOS may allow it without a tap now; then no tap is needed
    $('start').classList.add('waiting');
    startWait.until = performance.now() + 30000;   // a tap much later shouldn't start a style by surprise
    startWait.timer = setInterval(() => {
      if (hidden() || !current || player.playing) { stopWaiting(); return; }
      if (performance.now() > startWait.until) { stopWaiting('Start cancelled: the page was never tapped.'); return; }
      if (soundOff() || !synth.timed()) return;
      stopWaiting(midi.input ? midi.input.name : '');
      startStop();
    }, 50);
    renderSynth();                                 // the header asks for the tap, saying the style starts then
    if (!sfView.tapShown) setStatus('Waiting for the sound to start…');
  }

  // ---------- settings pane ----------
  function fillMenus() {
    $('kb-channel').innerHTML = '<option value="0">ANY</option>' +
      Array.from({ length: 16 }, (_, k) => `<option value="${k + 1}">${k + 1}</option>`).join('');
    $('kb-channel').value = String(state.channel);
    let splits = '';
    for (let n = 24; n <= 96; n++) splits += `<option value="${n}">${N.noteName(n)}</option>`;
    $('kb-split').innerHTML = splits;
    $('kb-split').value = String(state.split);
    $('rh-channel').innerHTML = '<option value="0">OFF</option>' +
      Array.from({ length: 16 }, (_, k) => `<option value="${k + 1}">${k + 1}</option>`).join('');
    $('rh-channel').value = String(state.rhChannel);
    renderMemory();
  }
  function renderMemory() {
    $('chord-memory').checked = state.memory;
    $('chord-start').checked = state.chordStart;
    $('show-folders').checked = state.showFolders;
  }
  // The settings open as a window over the whole page; ✕, Escape or a tap on the dark background closes it.
  function showSettings(on) {
    $('settings-modal').hidden = !on;
    $('side-gear').setAttribute('aria-pressed', String(on));
  }

  $('side-gear').addEventListener('click', () => showSettings($('settings-modal').hidden));
  $('settings-close').addEventListener('click', () => showSettings(false));
  $('settings-modal').addEventListener('click', (ev) => { if (ev.target === $('settings-modal')) showSettings(false); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('settings-modal').hidden) showSettings(false); });
  $('kb-port').addEventListener('change', (ev) => {
    const ins = midi.access ? A.MidiPorts.list(midi.access.inputs) : [];
    const p = chosen(ins, ev.target.value);
    state.kbPort = p ? A.MidiPorts.ref(ins, p) : { none: true };
    save(); connect();
  });
  $('kb-channel').addEventListener('change', (ev) => {
    state.channel = Number(ev.target.value); keyboard.channel = state.channel;
    detector.allOff(); save();
  });
  $('kb-split').addEventListener('change', (ev) => {
    state.split = Number(ev.target.value); keyboard.split = state.split;
    save();
  });
  $('kb-learn').addEventListener('click', () => {
    if (keyboard.learning) { keyboard.cancelLearn(); $('kb-learn').setAttribute('aria-pressed', 'false'); return; }
    keyboard.learn();
    $('kb-learn').setAttribute('aria-pressed', 'true');
  });
  $('out-port').addEventListener('change', (ev) => {
    const outs = midi.access ? A.MidiPorts.list(midi.access.outputs) : [];
    const p = chosen(outs, ev.target.value);
    state.outPort = p ? A.MidiPorts.ref(outs, p) : { none: true };
    save(); connect();
  });
  $('clock-port').addEventListener('change', (ev) => {
    const outs = midi.access ? A.MidiPorts.list(midi.access.outputs) : [];
    const p = chosen(outs, ev.target.value);
    state.clockPort = p ? A.MidiPorts.ref(outs, p) : { none: true };
    save(); connect();
  });
  $('rh-channel').addEventListener('change', (ev) => { state.rhChannel = Number(ev.target.value); save(); });
  $('chord-start').addEventListener('change', (ev) => { state.chordStart = ev.target.checked; save(); });
  $('show-folders').addEventListener('change', (ev) => { state.showFolders = ev.target.checked; save(); renderLibrary(); showCurrentRow(); });
  $('chord-memory').addEventListener('change', (ev) => {
    state.memory = ev.target.checked; detector.setMemory(state.memory);
    save();
  });

  // ---------- style library ----------
  const TRASH_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M6 1h4l.5 1H14v1.5H2V2h3.5zM3 4.5h10l-.8 10.1a1 1 0 0 1-1 .9H4.8a1 1 0 0 1-1-.9zm3 2v7h1.2v-7zm2.8 0v7H10v-7z"/></svg>';
  const STORAGE_NOTE = {
    IndexedDB: 'Styles are kept in IndexedDB on this device.',
    localStorage: 'IndexedDB isn\'t available here: styles are kept in localStorage, which holds about 50-100.',
    memory: 'No storage here: imported styles are lost when the page reloads.',
  };
  // A favourite's row: a tiny yellow star before the name (before, so a long name's ellipsis never cuts it off).
  // The open / closed triangle of a folder header and the PARTS bar: points right, turned down (CSS) when open.
  const TRI_SVG = '<svg class="tri" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.2 8.4 5 3 8.8z"/></svg>';
  const ROW_STAR = '<svg class="row-star" viewBox="0 0 24 24" width="11" height="11" aria-label="favorite"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.3L12 17.1l-5.7 3.1 1.2-6.3-4.7-4.4 6.4-.8z"/></svg>';
  const view = { search: '', favorites: false, meter: '', confirmDelete: null, importing: false };
  let library = null;
  let current = null;                 // { entry, style } of the loaded style

  function renderLibrary() {
    if (!library) return;
    const meters = library.meters();
    const sel = $('lib-meter');
    if (view.meter && meters.indexOf(view.meter) < 0) view.meter = '';
    sel.innerHTML = '<option value="">All time signatures</option>' + meters.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    sel.value = view.meter;
    $('lib-funnel').setAttribute('aria-pressed', String(!!view.meter));     // yellow while it filters
    $('lib-fav').setAttribute('aria-pressed', String(view.favorites));
    const rows = library.list({ search: view.search, favorites: view.favorites, meter: view.meter });
    const rowHtml = (e) => {
      const on = current && current.entry.id === e.id ? ' on' : '';
      const sub = [e.meter, e.tempo + ' bpm', e.source === 'sty' ? 'Yamaha' : 'Roland'].join(' · ');
      return `<div class="row${on}" data-id="${esc(e.id)}">` +
        `<div class="row-main"><div class="row-name">${e.favorite ? ROW_STAR : ''}${esc(e.name)}</div><div class="row-sub">${esc(sub)}</div></div></div>`;
    };
    const empty = `<div class="empty">${library.size ? 'No styles match.' : 'No styles yet. + adds style files; the folder button adds every style in a folder.'}</div>`;
    $('lib-count').textContent = library.size ? `${rows.length} of ${library.size} styles` : '';
    renderStorage();
    // LAYOUT › SHOW FOLDERS off: one list, A to Z, no folder headers.
    if (!state.showFolders) {
      const sorted = rows.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
      $('lib-list').innerHTML = sorted.map(rowHtml).join('') || empty;
      return;
    }
    // Grouped by folder, each under a sticky header that collapses it (saved). While searching, every match shows.
    const groups = {};
    rows.forEach((e) => { (groups[e.folder || ''] = groups[e.folder || ''] || []).push(e); });
    const folders = Object.keys(groups).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const searching = !!view.search.trim();
    $('lib-list').innerHTML = folders.map((folder) => {
      const closed = !searching && !!state.collapsed[folder] && folder !== view.openFolder;
      const head = `<div class="folder${closed ? ' closed' : ''}" data-folder="${esc(folder)}" role="button" aria-expanded="${!closed}">` +
        `${TRI_SVG}<span class="folder-name">${esc(folder || 'Other')}</span>` +
        `<span class="folder-count">${groups[folder].length}</span></div>`;
      if (closed) return head;
      return head + groups[folder].map(rowHtml).join('');
    }).join('') || empty;
  }

  // The loaded style: name, summary, the section buttons, the parts with their channels.
  const SECTION_GROUPS = [
    { title: 'INTRO', kind: 'intro', letters: ['A', 'B', 'C'] },
    { title: 'MAIN', kind: 'main', letters: ['A', 'B', 'C', 'D'] },
    { title: 'FILL', kind: 'fill' },
    { title: 'BREAK', kind: 'break' },
    { title: 'ENDING', kind: 'ending', letters: ['A', 'B', 'C'] },
  ];
  // The VEL ADJUST menu: -80..+80 in steps of 5, added to every note of the part.
  const VEL_OPTIONS = Array.from({ length: 33 }, (_, k) => (k - 16) * 5).map((v) => `<option value="${v}">${v > 0 ? '+' + v : v}</option>`).join('');
  const CHANNEL_OPTIONS = '<option value="0">OFF</option>' + Array.from({ length: 16 }, (_, k) => `<option value="${k + 1}">${k + 1}</option>`).join('');
  // What a part plays, by GM name: the style's voice for it, else the first program change it has anywhere (some
  // Roland parts set theirs later in a section). Drums show a kit name. With the program number, as on a GM synth.
  function programOf(part, style) {
    let prog = part.voice && part.voice.program;
    if (prog == null) {
      style.order.some((id) => {
        const t = style.sections[id].tracks[part.id];
        const e = t && t.patterns[0].events.find((x) => x.type === 'program');
        if (e) prog = e.program;
        return prog != null;
      });
    }
    return prog;
  }
  // Guitar parts (GM programs 25-32) skip their notes below C1: Roland styles put strum / fret noise keys down there
  // (10% of the E-80 guitar notes), which a GM guitar plays as very low notes. A part is a guitar part when any of its
  // sounds is a guitar: Survive Disco's Acc 4 is brass in Intro A but a guitar in the mains, fills and endings, where
  // it plays the noise keys 1-8 (2026-11-25: heard as a strange sound the mixer seemed not to reach).
  function noteFloors(style) {
    const out = {};
    style.parts.forEach((p) => {
      if (p.role === 'drums') return;
      const progs = [];
      if (p.voice && p.voice.program != null) progs.push(p.voice.program);
      style.order.forEach((id) => {
        const t = style.sections[id].tracks[p.id];
        if (t) t.patterns.forEach((pat) => pat.events.forEach((e) => { if (e.type === 'program') progs.push(e.program); }));
      });
      if (progs.some((g) => g >= 24 && g <= 31)) out[p.id] = 24;
    });
    return out;
  }
  function soundName(part, style) {
    const prog = programOf(part, style);
    if (prog == null) return '';
    if (part.role === 'drums') {
      // A kit a GM synth doesn't have is sent as the Standard Kit (ChannelMap): say so.
      return A.ChannelMap.GM_KITS.indexOf(prog) >= 0 ? `${A.GmNames.kit(prog)} · ${prog + 1}` : `Standard Kit (the style asks for kit ${prog + 1})`;
    }
    return `${A.GmNames.program(prog)} · ${prog + 1}`;
  }
  function renderStyle() {
    renderDelete();
    renderFavorite();
    if (!current) {
      $('style-name').textContent = 'No style loaded';
      $('style-sum').textContent = 'Add styles with + (files) or the folder button, then tap one.';
      $('style-sections').innerHTML = ''; $('style-parts').innerHTML = '';
      renderTransport();
      return;
    }
    const s = current.style;
    $('style-name').textContent = s.name;
    $('style-sum').textContent = `${A.Style.summary(s)} · ${s.source === 'sty' ? 'Yamaha' : 'Roland'} ${s.format}`;
    // Section buttons: INTRO and ENDING letters, FILL and BREAK on the first row; the four MAINs, wide, below.
    const buttonsOf = (g) => {
      if (g.letters) {
        return g.letters.map((l) => {
          const id = g.kind + l, sec = s.sections[id];
          return `<button class="btn sec" type="button" data-kind="${g.kind}" data-letter="${l}" data-id="${id}"${sec ? '' : ' disabled'} title="${sec ? sec.bars + ' bar' + (sec.bars === 1 ? '' : 's') : 'not in this style'}">${l}</button>`;
        }).join('');
      }
      const alias = A.SectionFlow.breakAlias(s.order);   // Fill In BA as the BREAK of newer Yamaha styles
      const ids = s.order.filter((id) => (id === alias ? 'break' : s.sections[id].kind) === g.kind);
      return `<button class="btn sec wide" type="button" data-kind="${g.kind}"${ids.length ? '' : ' disabled'} title="${ids.length ? esc(ids.map((id) => s.sections[id].name).join(', ')) : 'not in this style'}">${g.title}</button>`;
    };
    const group = (kind) => SECTION_GROUPS.find((g) => g.kind === kind);
    const labelled = (kind) => `<div class="sec-group sec-${kind}"><div class="sec-title">${group(kind).title}</div><div class="sec-btns">${buttonsOf(group(kind))}</div></div>`;
    $('style-sections').innerHTML =
      `<div class="sec-row">${labelled('intro')}${labelled('ending')}<div class="sec-spacer"></div>${buttonsOf(group('fill'))}${buttonsOf(group('break'))}</div>` +
      `<div class="sec-group"><div class="sec-title">MAIN</div><div class="sec-mains">${buttonsOf(group('main'))}</div></div>`;
    // A table: a header row, then one row per part, in the same grid columns.
    $('style-parts').innerHTML = '<div class="part-row part-head"><span>PART</span><span>CHANNEL</span><span>PRG CHANGE</span>' +
      '<span>MUTE</span><span>VEL ADJUST</span><span class="parts-sound-head">SOUND</span></div>' + s.parts.map((p) => {
      const v = p.voice, m = channelMap.get(p.id);
      const voice = soundName(p, s);
      return `<div class="part-row" data-part="${esc(p.id)}"><span class="part-name">${esc(p.name)}</span>` +
        `<select data-ch title="Output channel">${CHANNEL_OPTIONS}</select>` +
        `<label class="check" title="Send bank and program changes on this channel (off for a drum plugin)"><input type="checkbox" data-prg${m.program ? ' checked' : ''}></label>` +
        `<label class="check" title="Mute this part"><input type="checkbox" data-mute${m.mute ? ' checked' : ''}></label>` +
        `<select data-vel title="Added to every note's velocity on this part">${VEL_OPTIONS}</select>` +
        `<span class="part-voice">${esc(voice)}</span></div>`;
    }).join('') +
      // DEFAULTS under the last part: drops this style's own PARTS setup.
      '<div class="parts-foot"><button id="parts-defaults" class="btn" type="button" title="Drop this style\'s own PARTS setup and use the defaults" disabled>DEFAULTS</button></div>';
    Array.from($('style-parts').querySelectorAll('.part-row[data-part]')).forEach((row) => {      // not the header row
      row.querySelector('[data-ch]').value = String(channelMap.get(row.getAttribute('data-part')).channel);
      row.querySelector('[data-vel]').value = String(channelMap.get(row.getAttribute('data-part')).velocity);
    });
    renderPartsHead();
    renderPartsBar();
    renderTransport();
  }
  // PARTS is a bar that opens the table: "7 parts on channels 2-10 · none muted". Open or closed is remembered.
  function renderPartsBar() {
    const open = !!state.partsOpen && !!current;
    $('style-parts').hidden = !open;
    $('parts-toggle').setAttribute('aria-expanded', String(open));
    if (!current) { $('parts-sum').textContent = 'Load a style to see its parts'; return; }
    const parts = current.style.parts;
    const chans = parts.map((p) => channelMap.channel(p.id)).filter(Boolean);
    const muted = parts.filter((p) => channelMap.get(p.id).mute).length;
    $('parts-sum').textContent = `${parts.length} part${parts.length === 1 ? '' : 's'}` +
      (chans.length ? ` on channels ${Math.min.apply(null, chans)}–${Math.max.apply(null, chans)}` : '') +
      ` · ${muted ? muted + ' muted' : 'none muted'}` + (open ? '' : ' · tap to open');
  }

  // Section buttons lit from the flow: the one playing, the one coming at the next bar line (blinking), where a
  // one-shot goes next, and while stopped the armed intro (blinking) and the selected main.
  function renderTransport() {
    const f = player.flow;
    // A drawn triangle / square (not ▶ ■, which iOS can turn into emoji), then the word.
    $('start').innerHTML = player.playing
      ? '<svg class="start-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="currentColor"/></svg>STOP'
      : '<svg class="start-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5v13l11.5-6.5z" fill="currentColor"/></svg>START';
    $('start').classList.toggle('on', player.playing);
    $('start').disabled = !current;
    $('sync').checked = sync.armed;
    $('autofill').checked = state.autoFill;
    $('tempo').textContent = String(Math.round(player.tempo));
    $('vol').textContent = Math.round(player.volume * 100) + '%';
    if (!f || !current) return;
    const pos = player.playing ? player.position(performance.now()) : null;
    const playingId = pos ? pos.section : null;
    Array.from($('style-sections').querySelectorAll('.sec')).forEach((b) => {
      const kind = b.getAttribute('data-kind'), id = b.getAttribute('data-id');
      const match = (x) => x && (id ? x === id : f.roleOf(x) === kind);
      b.classList.toggle('on', !!match(playingId));
      b.classList.toggle('pending', player.playing && !!match(f.pending));
      b.classList.toggle('next', player.playing && !!match(f.after) && !match(f.pending));
      // Outlined: the main START leads to, the intro START plays, the ending STOP plays (that one while playing too).
      b.classList.toggle('sel', !match(playingId) && !(player.playing && match(f.pending)) &&
        ((!player.playing && kind === 'main' && id === 'main' + f.main) || (!player.playing && id === f.intro) || id === f.ending));
    });
  }

  // The bar / beat counter, while playing: bar number, then the pulses in their groups.
  let lastCounter = '', counterFit = '';
  // Many pulses (11/16, 15/8) made the counter wider than the CHORD box: its type (and the dots, sized in em) shrinks
  // until it fits, on one line. Measured only when the meter or the bar number's digits change, or the window resizes.
  function fitCounter() {
    const el = $('counter');
    el.style.fontSize = '';
    let size = parseFloat(getComputedStyle(el).fontSize);
    for (let k = 0; k < 15 && el.scrollWidth > el.clientWidth + 1 && size > 7; k++) { size *= 0.9; el.style.fontSize = size.toFixed(1) + 'px'; }
  }
  window.addEventListener('resize', () => { counterFit = ''; lastCounter = ''; });
  function renderCounter() {
    const pos = player.playing && player.position(performance.now());
    let html = '', fit = '';
    if (pos) {
      const m = player.meter, dots = [];
      fit = m.starts.join('') + ':' + String(pos.bar + 1).length;
      for (let p = 0; p < m.num; p++) {
        if (p && m.starts[p]) dots.push('<span class="sep">|</span>');
        dots.push(`<span class="p${m.starts[p] ? ' g' : ''}${p === pos.pulse ? ' on' : ''}"></span>`);
      }
      html = `<span class="bar">${pos.bar + 1}</span>${dots.join('')}`;
      if (pos.section !== lastSection) { lastSection = pos.section; renderTransport(); }
    } else if (lastSection) { lastSection = null; renderTransport(); }
    if (html !== lastCounter) {
      $('counter').innerHTML = html; lastCounter = html;
      if (fit !== counterFit) { counterFit = fit; if (fit) fitCounter(); }
    }
    requestAnimationFrame(renderCounter);
  }
  let lastSection = null;

  function showMessages(html) { $('msgs').innerHTML = html || ''; }
  function warningsHtml(style) {
    if (!style || !style.warnings.length) return '';
    return '<div>Reading this style:</div>' + style.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  }

  async function loadStyle(id) {
    try {
      const next = await library.load(id);
      current = next;
      const set = current.entry.settings;
      channelMap = styleMapFor(set);
      if (player.playing) {
        // Playing: the new style takes over at the next bar line, in its Main A (no intro).
        player.changeStyle(current.style, channelMap, set.groups, set.tempo);
        player.setNoteFloors(noteFloors(current.style));
        player.setVolume(set.volume != null ? set.volume : 1);
      } else {
        player.load(current.style, channelMap, set.groups);
        player.setNoteFloors(noteFloors(current.style));
        player.flow.autoFill = state.autoFill;
        if (set.tempo) player.setTempo(set.tempo);
        player.setVolume(set.volume != null ? set.volume : 1);
      }
      state.styleId = id; save();
      showMessages(warningsHtml(current.style));
    } catch (e) {
      player.stop();
      current = null;
      showMessages(`<div class="warn">${esc(e.message || String(e))}</div>`);
    }
    renderStyle(); renderLibrary();
  }

  // A zip (a backup, or a pack of styles) by its first bytes, PK 3 4: iOS doesn't always keep the extension.
  async function isZip(f) {
    if (/\.zip$/i.test(f.name)) return true;
    try {
      const head = new Uint8Array(await (f.slice(0, 4).arrayBuffer ? f.slice(0, 4).arrayBuffer() : new Response(f.slice(0, 4)).arrayBuffer()));
      return head[0] === 0x50 && head[1] === 0x4B && head[2] === 3 && head[3] === 4;
    } catch (e) { return false; }
  }

  // Files from the pickers: style files only for a folder (it may hold other things), anything for a pick (the
  // content decides, and iOS doesn't always keep extensions). A zip picked with + is restored, as RESTORE does.
  async function importFiles(fileList, fromFolder) {
    if (!library || view.importing) return;
    let files = Array.from(fileList || []).filter((f) => !fromFolder || /\.(sty|stl|sth|prs|bcs|sst)$/i.test(f.name));   // .prs / .bcs / .sst: Yamaha styles too
    if (!fromFolder) {
      const zips = [];
      for (const f of files) if (await isZip(f)) zips.push(f);
      for (const z of zips) await restoreZip(z);
      if (zips.length) { files = files.filter((f) => zips.indexOf(f) < 0); if (!files.length) return; }
    }
    if (!files.length) { showMessages(fromFolder ? '<div class="warn">No style files (.sty, .prs, .bcs, .sst, .stl, .sth) in that folder.</div>' : ''); return; }
    view.importing = true;
    const items = files.map((f) => {
      const rel = f.webkitRelativePath || '';
      const parts = rel.split('/');
      return { name: f.name, folder: parts.length > 1 ? parts[parts.length - 2] : '',
        bytes: () => (f.arrayBuffer ? f.arrayBuffer() : new Response(f).arrayBuffer()).then((b) => new Uint8Array(b)) };
    });
    let lastPaint = 0;
    const r = await library.addMany(items, (done, total) => {
      const now = Date.now();
      if (now - lastPaint > 150 || done === total) { lastPaint = now; setStatus(`Importing ${done} / ${total}…`); }
    });
    view.importing = false;
    setStatus(midi.input ? midi.input.name : '');
    const lines = [`<div>Added ${r.added.length} style${r.added.length === 1 ? '' : 's'}` +
      (r.sameMusic.length ? ` (${r.sameMusic.length} with the same music as a style already there)` : '') +
      (r.duplicates.length ? `, ${r.duplicates.length} already in the library` : '') +
      (r.failed.length ? `, ${r.failed.length} skipped:` : '.') + '</div>'];
    r.failed.slice(0, 30).forEach((f) => lines.push(`<div class="warn">${esc(f.name)}: ${esc(f.error)}</div>`));
    if (r.failed.length > 30) lines.push(`<div class="warn">… and ${r.failed.length - 30} more.</div>`);
    showMessages(lines.join(''));
    renderLibrary();
    if (!current && r.added.length === 1) loadStyle(r.added[0].id);
  }

  // + and the folder button are labels for these inputs (see index.html). The folder input only exists where folders
  // can be picked (desktop Chrome): it's made here, so iPad web views never get a webkitdirectory input at all.
  $('lib-files').addEventListener('change', (ev) => { importFiles(ev.target.files, false); ev.target.value = ''; });
  const canPickFolders = 'webkitdirectory' in document.createElement('input') && !/iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);          // an iPad asking for the desktop site
  if (canPickFolders) {
    const dir = document.createElement('input');
    dir.type = 'file'; dir.id = 'lib-dir'; dir.multiple = true; dir.webkitdirectory = true; dir.className = 'sr-only'; dir.tabIndex = -1;
    $('lib-folder').after(dir);
    dir.addEventListener('change', (ev) => { importFiles(ev.target.files, true); ev.target.value = ''; });
    $('lib-folder').hidden = false;
  }
  $('lib-search').addEventListener('input', (ev) => { view.search = ev.target.value; renderLibrary(); });
  $('lib-clear').addEventListener('click', () => { view.search = ''; $('lib-search').value = ''; renderLibrary(); });
  $('lib-fav').addEventListener('click', () => { view.favorites = !view.favorites; renderLibrary(); });
  $('lib-meter').addEventListener('change', (ev) => { view.meter = ev.target.value; renderLibrary(); });
  $('lib-list').addEventListener('click', async (ev) => {
    const head = ev.target.closest('.folder');
    if (head) {
      if (view.search.trim()) return;                 // searching shows every match; folders open again after
      const f = head.getAttribute('data-folder');
      const shut = state.collapsed[f] && f !== view.openFolder;
      if (f === view.openFolder) view.openFolder = null;
      if (shut) delete state.collapsed[f]; else state.collapsed[f] = true;
      save(); renderLibrary();
      return;
    }
    const row = ev.target.closest('.row');
    if (!row) return;
    loadStyle(row.getAttribute('data-id'));
  });
  // The star next to the style name: the loaded style as a favourite (the ★ filter above the list shows only those).
  function renderFavorite() {
    const b = $('style-fav');
    b.hidden = !current;
    if (current) b.setAttribute('aria-pressed', String(!!(library.entries[current.entry.id] || current.entry).favorite));
  }
  $('style-fav').addEventListener('click', async () => {
    if (!current) return;
    const id = current.entry.id, e = library.entries[id];
    if (!e) return;
    await library.setFavorite(id, !e.favorite);
    renderFavorite();
    renderLibrary();
  });

  // The trash can in the STYLE box deletes the loaded style from the library. Two taps: the first turns it into
  // DELETE? for 3 s (no confirm(): some iPad Web MIDI browsers don't show dialogs).
  function renderDelete() {
    const b = $('style-delete');
    b.hidden = !current;
    const asking = !!current && view.confirmDelete === current.entry.id;
    b.classList.toggle('confirm', asking);
    b.innerHTML = asking ? 'DELETE?' : TRASH_SVG;
    b.title = asking ? 'Tap again to delete this style from the library' : 'Delete this style from the library';
  }
  $('style-delete').addEventListener('click', async () => {
    if (!current) return;
    const id = current.entry.id;
    if (view.confirmDelete !== id) {
      view.confirmDelete = id; renderDelete();
      setTimeout(() => { if (view.confirmDelete === id) { view.confirmDelete = null; renderDelete(); } }, 3000);
      return;
    }
    view.confirmDelete = null;
    player.stop();
    await library.remove(id);
    current = null; state.styleId = null; save();
    renderStyle(); renderLibrary(); showMessages('');
  });

  // ---------- transport and parts ----------
  $('start').addEventListener('click', startEnding);
  $('panic').addEventListener('click', () => {
    sync.armed = false;
    if (player.playing) player.stop();
    panic();
    renderTransport();
    setStatus('All notes off.');
  });

  $('sync').addEventListener('change', (ev) => { sync.armed = ev.target.checked && !player.playing; renderTransport(); });
  $('autofill').addEventListener('change', (ev) => {
    state.autoFill = ev.target.checked; save();
    if (player.flow) player.flow.autoFill = state.autoFill;
    renderTransport();
  });
  $('style-sections').addEventListener('click', (ev) => {
    const b = ev.target.closest('.sec');
    if (!b || b.disabled) return;
    player.press(b.getAttribute('data-kind'), b.getAttribute('data-letter') || (player.flow && player.flow.main));
    renderTransport();
  });
  // Tempo: − / + by 1 (hold shift for 5); a tap on the number goes back to the style's own tempo. Saved per style.
  let tempoSave = 0;
  function changeTempo(bpm) {
    if (!current) return;
    player.setTempo(Math.round(bpm));
    clearTimeout(tempoSave);
    const id = current.entry.id, own = Math.round(current.style.tempo) === Math.round(player.tempo);
    tempoSave = setTimeout(() => {
      const settings = Object.assign({}, library.entries[id] ? library.entries[id].settings : {});
      if (own) delete settings.tempo; else settings.tempo = Math.round(player.tempo);
      library.setSettings(id, settings);
    }, 600);
    renderTransport();
  }
  $('tempo-down').addEventListener('click', (ev) => changeTempo(player.tempo - (ev.shiftKey ? 5 : 1)));
  $('tempo-up').addEventListener('click', (ev) => changeTempo(player.tempo + (ev.shiftKey ? 5 : 1)));
  $('tempo').addEventListener('click', () => { if (current) changeTempo(current.style.tempo); });
  // Style volume: − / + by 10%, 0-150%; a tap on the value goes back to 100%. Saved per style.
  let volumeSave = 0;
  function changeVolume(v) {
    if (!current) return;
    player.setVolume(Math.round(Math.max(0, Math.min(1.5, v)) * 10) / 10);
    clearTimeout(volumeSave);
    const id = current.entry.id;
    volumeSave = setTimeout(() => {
      const settings = Object.assign({}, library.entries[id] ? library.entries[id].settings : {});
      if (player.volume === 1) delete settings.volume; else settings.volume = player.volume;
      library.setSettings(id, settings);
    }, 600);
    renderTransport();
  }
  $('vol-down').addEventListener('click', () => changeVolume(player.volume - 0.1));
  $('vol-up').addEventListener('click', () => changeVolume(player.volume + 0.1));
  $('vol').addEventListener('click', () => changeVolume(1));
  // PARTS changes belong to the loaded style (saved by its music hash, shared by its copies). DEFAULTS drops them.
  function settingsOfCurrent() { return Object.assign({}, current && library.entries[current.entry.id] ? library.entries[current.entry.id].settings : {}); }
  async function savePart(pid) {
    if (!current) return;
    const s = settingsOfCurrent();
    s.parts = Object.assign({}, s.parts || {});
    s.parts[pid] = channelMap.get(pid);
    await library.setSettings(current.entry.id, s);
    renderPartsHead();
  }
  // DEFAULTS, under the table: drops the loaded style's own PARTS setup; greyed out when it has none.
  function renderPartsHead() {
    const b = document.getElementById('parts-defaults');
    if (b) b.disabled = !(current && settingsOfCurrent().parts);
  }
  $('style-parts').addEventListener('click', async (ev) => {
    if (!ev.target.closest('#parts-defaults') || !current) return;
    const s = settingsOfCurrent();
    delete s.parts;
    await library.setSettings(current.entry.id, s);
    channelMap = styleMapFor(s); player.map = channelMap;
    renderStyle();
  });
  $('parts-toggle').addEventListener('click', () => {
    if (!current) return;
    state.partsOpen = !state.partsOpen; save();
    renderPartsBar();
  });
  $('style-parts').addEventListener('change', (ev) => {
    const row = ev.target.closest('.part-row');
    if (!row) return;
    const pid = row.getAttribute('data-part');
    if (ev.target.matches('[data-prg]')) channelMap.set(pid, { program: ev.target.checked });
    else if (ev.target.matches('[data-mute]')) channelMap.set(pid, { mute: ev.target.checked });
    else if (ev.target.matches('[data-vel]')) channelMap.set(pid, { velocity: Number(ev.target.value) });
    else if (ev.target.matches('[data-ch]')) channelMap.set(pid, { channel: Number(ev.target.value) });
    else return;
    savePart(pid);
    renderPartsBar();
  });
  // Space bar: start / stop (not while typing in the search box).
  document.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
    if (!$('settings-modal').hidden) return;          // the space bar presses buttons in the settings, not START
    ev.preventDefault();
    startEnding();
  });
  // The space bar (and the Start / Ending control): start with Intro A; while playing, the first ending.
  // The START / STOP button and the space bar: start with the selected intro (none selected: straight into the
  // main); while playing, the selected ending, then stop. Pressed again during the ending, or with no ending
  // selected: stop at once. (The Start / Stop control starts and stops at once.)
  function startEnding() {
    if (!current || !player.flow) return;
    flashStart();
    if (!player.playing) { startStop(); return; }
    if (player.flow.requestStop()) startStop();
    else renderTransport();
  }

  // ---------- controls from other devices ----------
  const tapper = new A.Controls.TapTempo();
  function tap() {
    const bpm = tapper.tap(performance.now());
    if (bpm && bpm >= 20 && bpm <= 400) changeTempo(bpm);
  }
  $('tap').addEventListener('click', tap);
  const controls = new A.Controls(state.controls, {
    onAction: doAction,
    onLearn: (id) => {
      state.controls = controls.toJSON(); save();
      renderControls();
      setStatus(`${A.Controls.ACTIONS.find((a) => a.id === id).name}: ${A.Controls.describe(controls.get(id))}`);
    },
  });
  // Next / previous main variation: the next (A -> B -> C -> D -> A) or previous (A -> D -> C -> B) main the style
  // has, as if its button was pressed (with a fill when AUTO FILL is on; while stopped it selects it).
  function stepMain(dir) {
    const f = player.flow;
    if (!f) return;
    const mains = f.mains();
    if (mains.length < 2) return;
    player.press('main', mains[(mains.indexOf(f.main) + dir + mains.length) % mains.length]);
    renderTransport();
  }
  function doAction(id) {
    const m = /^(intro|main|ending)([A-D])$/.exec(id);
    if (m) { player.press(m[1], m[2]); renderTransport(); return; }
    if (id === 'fill' || id === 'break') { player.press(id, player.flow && player.flow.main); renderTransport(); return; }
    if (id === 'nextMain') { stepMain(1); return; }
    if (id === 'prevMain') { stepMain(-1); return; }
    if (id === 'startStop') startStop();
    else if (id === 'startEnding') startEnding();
    else if (id === 'syncStart') $('sync').click();
    else if (id === 'autoFill') $('autofill').click();
    else if (id === 'tapTempo') tap();
    else if (id === 'tempoDown') changeTempo(player.tempo - 1);
    else if (id === 'tempoUp') changeTempo(player.tempo + 1);
    else if (id === 'soloPerc') {
      // It latches: each press of its switch turns it on, the next one off.
      player.setSoloPercussion(!player.soloPercussion);
      setStatus(player.soloPercussion ? 'Solo percussion: only the drums play.' : 'Solo percussion off.');
    }
  }
  // The list in the settings: each action, what it's assigned to, the port it listens on, LEARN and ✕.
  function renderControls() {
    const ins = midi.access ? A.MidiPorts.list(midi.access.inputs) : [];
    const clash = controls.conflicts();             // the same switch on two actions: shown in red
    $('controls-list').innerHTML = A.Controls.ACTIONS.map((act) => {
      const a = controls.get(act.id), learning = controls.learning === act.id;
      let second = '';
      if (a) {
        const known = !a.port || !!A.MidiPorts.find(ins, a.port);
        const opts = '<option value="">ANY PORT</option>' + ins.map((p, k) => `<option value="${k}">${esc(A.MidiPorts.label(ins, p))}</option>`).join('') +
          (a.port && !known ? `<option value="saved">${esc(a.port.name)} (not connected)</option>` : '');
        second = `<div class="ctl-line"><select data-port title="The port this control listens on">${opts}</select>` +
'</div>';
      }
      return `<div class="ctl-row${a ? ' set' : ''}${clash[act.id] ? ' clash' : ''}" data-act="${act.id}"${clash[act.id] ? ' title="This switch is also assigned to another action: one press does both"' : ''}><div class="ctl-line"><span class="ctl-name">${esc(act.name)}</span>` +
        `<span class="ctl-what">${learning ? 'press a switch…' : esc(A.Controls.describe(a))}</span>` +
        `<button class="btn" type="button" data-learn aria-pressed="${learning}">LEARN</button>` +
        (a ? '<button class="btn" type="button" data-clear aria-label="Remove">✕</button>' : '') + `</div>${second}</div>`;
    }).join('');
    Array.from($('controls-list').querySelectorAll('.ctl-row')).forEach((row) => {
      const a = controls.get(row.getAttribute('data-act')), sel = row.querySelector('[data-port]');
      if (!a || !sel) return;
      const p = a.port && A.MidiPorts.find(ins, a.port);
      sel.value = !a.port ? '' : p ? String(ins.indexOf(p)) : 'saved';
    });
  }
  $('controls-list').addEventListener('click', (ev) => {
    const row = ev.target.closest('.ctl-row'), b = ev.target.closest('.btn');
    if (!row || !b) return;
    const id = row.getAttribute('data-act');
    if (b.hasAttribute('data-learn')) { if (controls.learning === id) controls.cancelLearn(); else controls.learn(id); }
    else if (b.hasAttribute('data-clear')) controls.clear(id);
    state.controls = controls.toJSON(); save();
    renderControls();
  });
  $('controls-list').addEventListener('change', (ev) => {
    const row = ev.target.closest('.ctl-row');
    if (!row || !ev.target.matches('[data-port]')) return;
    const id = row.getAttribute('data-act'), a = controls.get(id);
    if (ev.target.value === 'saved') return;
    const ins = A.MidiPorts.list(midi.access ? midi.access.inputs : []);
    const p = chosen(ins, ev.target.value);
    a.port = p ? A.MidiPorts.ref(ins, p) : null;
    controls.assign(id, a);
    state.controls = controls.toJSON(); save();
  });

  // ---------- backup ----------
  // BACKUP › ALL downloads the whole library (a[download]: Chrome, and Safari on iPad). RESTORE adds a backup's styles
  // with their favourites and settings, or the styles in any zip of .sty / .stl files.
  function download(name, type, data) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  // BACKUP › ALL: the whole library. FAVORITES: only the starred styles (same zip format, RESTORE reads both).
  async function saveZip(favoritesOnly) {
    const count = library ? library.list({ favorites: favoritesOnly }).length : 0;
    if (!count) { showMessages(`<div class="warn">${favoritesOnly ? 'No favorites yet: star a style next to its name.' : 'No styles to back up.'}</div>`); return; }
    setStatus('Making the zip…');
    try {
      const zip = await A.LibraryBackup.backup(library, favoritesOnly ? { favorites: true } : undefined);
      const d = new Date(), pad = (x) => String(x).padStart(2, '0');
      const name = `arranger-${favoritesOnly ? 'favorites' : 'styles'}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
      download(name, 'application/zip', zip);
      const size = zip.length >= 1024 * 1024 ? `${(zip.length / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(zip.length / 1024)} KB`;
      showMessages(`<div>Saved ${count} ${favoritesOnly ? 'favorite' : 'style'}${count === 1 ? '' : 's'} in ${esc(name)} (${size}).</div>`);
    } catch (e) { showMessages(`<div class="warn">Saving failed: ${esc(e.message || String(e))}</div>`); }
    setStatus(midi.input ? midi.input.name : '');
  }
  // CLEAR ALL: two taps, like deleting one style (the first turns it into DELETE N STYLES? for 3 s).
  let clearAsk = 0;
  function renderClearAll() {
    const b = $('lib-clear-all');
    b.classList.toggle('confirm', !!clearAsk);
    b.textContent = clearAsk ? `DELETE ${library ? library.size : 0} STYLES?` : 'CLEAR ALL';
  }
  $('lib-clear-all').addEventListener('click', async () => {
    if (!library || !library.size) { showMessages('<div class="warn">The library is already empty.</div>'); return; }
    if (!clearAsk) {
      clearAsk = setTimeout(() => { clearAsk = 0; renderClearAll(); }, 3000);
      renderClearAll();
      return;
    }
    clearTimeout(clearAsk); clearAsk = 0;
    const n = library.size;
    player.stop();
    await library.clear();
    current = null; state.styleId = null; save();
    renderClearAll(); renderStyle(); renderLibrary();
    showMessages(`<div>Removed ${n} styles from the library.</div>`);
  });
  $('lib-backup').addEventListener('click', () => saveZip(false));
  $('lib-backup-fav').addEventListener('click', () => saveZip(true));
  $('lib-zip').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (f) await restoreZip(f);
  });
  // A backup zip (or any zip of styles) into the library: from RESTORE, or a zip picked with +.
  async function restoreZip(f) {
    if (!library || view.importing) return;
    view.importing = true;
    try {
      const bytes = new Uint8Array(await (f.arrayBuffer ? f.arrayBuffer() : new Response(f).arrayBuffer()));
      const r = await A.LibraryBackup.restore(library, bytes, (done, total) => setStatus(`Restoring ${done} / ${total}…`));
      const lines = [`<div>From ${esc(f.name)}: added ${r.added.length} style${r.added.length === 1 ? '' : 's'}` +
        (r.duplicates.length ? `, ${r.duplicates.length} already in the library` : '') +
        (r.failed.length ? `, ${r.failed.length} skipped:` : '.') + '</div>'];
      r.failed.slice(0, 30).forEach((x) => lines.push(`<div class="warn">${esc(x.name)}: ${esc(x.error)}</div>`));
      showMessages(lines.join(''));
    } catch (e) { showMessages(`<div class="warn">Couldn't restore ${esc(f.name)}: ${esc(e.message || String(e))}</div>`); }
    view.importing = false;
    setStatus(midi.input ? midi.input.name : '');
    renderLibrary();
    renderStorage();
  }

  // The first start (an empty library): the built-in styles, starred. Only once: deleting them all later doesn't bring
  // them back, and a library that already has styles is left as it is. If they can't be fetched, next start tries again.
  async function addDefaults() {
    if (state.defaultsAdded) return;
    if (!library.size) {
      try {
        const manifest = JSON.parse(new TextDecoder().decode(await fetchDefault(A.LibraryBackup.MANIFEST)));
        await A.LibraryBackup.restoreFolder(library, manifest, fetchDefault);
      } catch (e) { return; }
    }
    state.defaultsAdded = true;
    save();
  }

  // STORAGE in the settings: where styles are kept, how many, and how much space their files take.
  function renderStorage() {
    const bytes = library.totalBytes();
    const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
    const amount = library.size ? ` ${library.size} style${library.size === 1 ? '' : 's'}, ${size}.` : ' No styles yet.';
    $('storage-status').textContent = STORAGE_NOTE[library.backend.kind] + amount;
  }

  function showCurrentRow() {
    const row = $('lib-list').querySelector('.row.on');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
  }

  async function openLibrary() {
    library = await A.StyleLibrary.openBest(window);
    await addDefaults();
    renderLibrary();
    if (state.styleId && library.entries[state.styleId]) {
      // The style from before the reload: loaded, its folder opened (just for now) and its row scrolled into view.
      view.openFolder = library.entries[state.styleId].folder || '';
      await loadStyle(state.styleId);
      showCurrentRow();
    }
  }

  fillMenus();
  renderChord(null);
  renderStyle();
  renderControls();
  openLibrary();
  start();
  if (state.outMode === 'synth') bootSynth();
  requestAnimationFrame(renderCounter);
}());
