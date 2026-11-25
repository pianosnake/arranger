// Arranger page: the DOM and Web MIDI wiring. The logic lives in the classes it loads (chord-detector.js,
// keyboard-input.js, midi-ports.js, ...), which have no DOM and are tested in Node.
// Plain JS, no libraries or network: it must run unmodified in desktop Chrome and inside the MIDI Charmer AUv3
// (iPad, iOS 15 WebKit: no class fields, no .at(), no container queries).
(function () {
  'use strict';
  const A = window.Arranger;
  const N = A.ChordNames;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const STORE = 'arranger-settings';
  const KEYS_LOW = 36, KEYS_HIGH = 95;          // the keyboard strip: C2..B6

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
    clockPort: saved.clockPort || { none: true }, // where MIDI clock goes; none by default
    rhChannel: saved.rhChannel || 0,             // right hand (keys from the split up) to this channel; 0 = off
    channelMap: saved.channelMap || {},          // ChannelMap.toJSON(): part -> { channel, program, mute }
    autoFill: saved.autoFill == null ? true : !!saved.autoFill,
    chordStart: !!saved.chordStart,              // a chord played while stopped starts the style
    controls: saved.controls || {},
    collapsed: saved.collapsed || {},            // style list: folder name -> collapsed              // Controls.toJSON(): action -> { port, channel, type, number, latch }
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
    onKeys: renderKeys,
  });
  const sync = { armed: false };
  let upperHeld = {};
  const keyboard = new A.KeyboardInput({
    channel: state.channel, split: state.split,
    lower: detector,
    upper: (d) => {
      const t = d[0] & 0xF0;
      if (t === 0x90 && d[2] > 0) upperHeld[d[1]] = true;
      else if (t === 0x80 || t === 0x90) delete upperHeld[d[1]];
      // The right hand plays through on its own channel.
      if (state.rhChannel && midi.output) {
        try { midi.output.send([t | (state.rhChannel - 1)].concat(Array.from(d).slice(1))); } catch (e) { /* port gone */ }
      }
      renderKeys();
    },
    onSplit: (note) => {
      state.split = note; save();
      $('kb-split').value = String(note);
      $('kb-learn').setAttribute('aria-pressed', 'false');
      renderKeys();
    },
  });

  function renderChord(c) {
    $('chord').textContent = c ? N.chordName(c) : '–';
  }

  // The keyboard strip: white keys first, black keys on top; held keys lit, the split as a red line.
  const IS_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
  const WHITE_W = 14, BLACK_W = 8, H = 70, BLACK_H = 44;
  function keyLayout() {
    const keys = [];
    let x = 0;
    for (let n = KEYS_LOW; n <= KEYS_HIGH; n++) {
      if (IS_BLACK[n % 12]) keys.push({ n, black: true, x: x - BLACK_W / 2 });
      else { keys.push({ n, black: false, x }); x += WHITE_W; }
    }
    return { keys, width: x };
  }
  const LAYOUT = keyLayout();
  function renderKeys() {
    const held = {};
    detector.held().forEach((n) => { held[n] = true; });
    Object.keys(upperHeld).forEach((n) => { held[n] = true; });
    const rect = (k) => {
      const cls = (k.black ? 'b' : 'w') + (held[k.n] ? ' held' : '') + (k.n >= keyboard.split ? ' right' : '');
      return `<rect class="${cls}" x="${k.x}" y="0" width="${k.black ? BLACK_W : WHITE_W}" height="${k.black ? BLACK_H : H}"/>`;
    };
    const whites = LAYOUT.keys.filter((k) => !k.black), blacks = LAYOUT.keys.filter((k) => k.black);
    const labels = whites.filter((k) => k.n % 12 === 0)
      .map((k) => `<text class="label" x="${k.x + 3}" y="${H - 4}">${N.noteName(k.n)}</text>`);
    let split = '';
    const sk = LAYOUT.keys.find((k) => k.n === keyboard.split);
    if (sk) split = `<line class="split" x1="${sk.x}" y1="-2" x2="${sk.x}" y2="${H + 2}"/>`;
    const svg = $('keys');
    svg.setAttribute('viewBox', `0 0 ${LAYOUT.width} ${H}`);
    svg.innerHTML = whites.map(rect).join('') + blacks.map(rect).join('') + labels.join('') + split;
    $('split-label').textContent = `Split ${N.noteName(keyboard.split)}: chords below, right hand from ${N.noteName(keyboard.split)} up.`;
  }

  // ---------- MIDI ----------
  const midi = { access: null, input: null, output: null, clock: null };
  const hub = new A.MidiPorts.InputHub();
  function setConn(text, cls) { const el = $('conn-status'); el.textContent = text; el.className = 'status ' + cls; }
  function setStatus(text) { $('status-text').textContent = text || ''; }

  // A port menu: (none) plus each port; ports with the same name get a number so they can be told apart.
  function fillPortMenu(sel, ports, current) {
    const count = {};
    sel.innerHTML = '<option value="">(none)</option>' + ports.map((p) => {
      count[p.name] = (count[p.name] || 0) + 1;
      const label = count[p.name] > 1 ? `${p.name} (${count[p.name]})` : p.name;
      return `<option value="${esc(p.id)}">${esc(label)}</option>`;
    }).join('');
    sel.value = current ? current.id : '';
  }

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
    const outs = A.MidiPorts.list(midi.access.outputs);
    const output = A.MidiPorts.pick(outs, state.outPort);
    if (output !== midi.output) {
      if (player.playing) player.stop();
      if (midi.output) panic(midi.output);         // leave nothing sounding on the old output
      if (output) panic(output);                   // nor anything a previous page left on the new one
    }
    midi.output = output;
    fillPortMenu($('out-port'), outs, output);
    const clockOut = A.MidiPorts.pick(outs, state.clockPort);
    if (clockOut !== midi.clock && midi.clock && player.playing) { try { midi.clock.send([0xFC]); } catch (e) { /* port gone */ } }
    midi.clock = clockOut;
    player.sendClock = clockOut ? (data, time) => { try { clockOut.send(data, time); } catch (e) { /* port gone */ } } : null;
    fillPortMenu($('clock-port'), outs, clockOut);
    if (input) setConn('Connected', 'on');
    else setConn(ins.length ? 'No keyboard' : 'No MIDI inputs', 'off');
    setStatus(input ? input.name : '');
  }

  async function start() {
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

  // ---------- player ----------
  // Sends with a timestamp: the player schedules ~100 ms ahead. Without an output it still runs (the display moves).
  const channelMap = new A.ChannelMap(state.channelMap);
  const player = new A.StylePlayer({
    clock: () => performance.now(),
    timer: { every: (fn, ms) => setInterval(fn, ms), cancel: (h) => clearInterval(h) },
    send: (data, time) => { if (midi.output) { try { midi.output.send(data, time); } catch (e) { /* port gone */ } } },
    onChange: () => renderTransport(),
  });
  // PANIC: on every channel, sustain off, all sound off and all notes off. Also sent when the page connects to an
  // output, which ends notes left hanging by a page reloaded mid-song.
  // Not sent while the page unloads, and no MIDIOutput.clear(): Chrome 150 on macOS 12 crashed in its MIDI service
  // (2026-11-24) when both were in place; one of them is the likely cause, not confirmed which.
  function panic(out) {
    const o = out || midi.output;
    if (!o) return;
    try {
      for (let c = 0; c < 16; c++) { o.send([0xB0 | c, 64, 0]); o.send([0xB0 | c, 120, 0]); o.send([0xB0 | c, 123, 0]); }
    } catch (e) { /* port gone */ }
  }
  function startStop() {
    if (!current) return;
    if (player.playing) player.stop(); else { player.setChord(detector.chord); player.start(); }
    renderTransport();
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
    [['chord-memory', state.memory], ['chord-start', state.chordStart]].forEach(([id, on]) => {
      const b = $(id);
      b.textContent = on ? 'ON' : 'OFF';
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function showSettings(on) {
    $('pane-settings').hidden = !on;
    $('pane-styles').hidden = on;
    document.querySelector('.side').classList.toggle('settings-open', on);
    $('side-gear').setAttribute('aria-pressed', String(on));
  }

  $('side-gear').addEventListener('click', () => showSettings($('pane-settings').hidden));
  $('settings-close').addEventListener('click', () => showSettings(false));
  $('kb-port').addEventListener('change', (ev) => {
    const ins = midi.access ? A.MidiPorts.list(midi.access.inputs) : [];
    const p = ins.find((x) => x.id === ev.target.value);
    state.kbPort = p ? { id: p.id, name: p.name } : { none: true };
    save(); connect();
  });
  $('kb-channel').addEventListener('change', (ev) => {
    state.channel = Number(ev.target.value); keyboard.channel = state.channel;
    detector.allOff(); save();
  });
  $('kb-split').addEventListener('change', (ev) => {
    state.split = Number(ev.target.value); keyboard.split = state.split;
    save(); renderKeys();
  });
  $('kb-learn').addEventListener('click', () => {
    if (keyboard.learning) { keyboard.cancelLearn(); $('kb-learn').setAttribute('aria-pressed', 'false'); return; }
    keyboard.learn();
    $('kb-learn').setAttribute('aria-pressed', 'true');
  });
  $('out-port').addEventListener('change', (ev) => {
    const outs = midi.access ? A.MidiPorts.list(midi.access.outputs) : [];
    const p = outs.find((x) => x.id === ev.target.value);
    state.outPort = p ? { id: p.id, name: p.name } : { none: true };
    save(); connect();
  });
  $('clock-port').addEventListener('change', (ev) => {
    const outs = midi.access ? A.MidiPorts.list(midi.access.outputs) : [];
    const p = outs.find((x) => x.id === ev.target.value);
    state.clockPort = p ? { id: p.id, name: p.name } : { none: true };
    save(); connect();
  });
  $('rh-channel').addEventListener('change', (ev) => { state.rhChannel = Number(ev.target.value); save(); });
  $('chord-start').addEventListener('click', () => { state.chordStart = !state.chordStart; save(); renderMemory(); });
  $('chord-memory').addEventListener('click', () => {
    state.memory = !state.memory; detector.setMemory(state.memory);
    save(); renderMemory();
  });

  // ---------- style library ----------
  const TRASH_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M6 1h4l.5 1H14v1.5H2V2h3.5zM3 4.5h10l-.8 10.1a1 1 0 0 1-1 .9H4.8a1 1 0 0 1-1-.9zm3 2v7h1.2v-7zm2.8 0v7H10v-7z"/></svg>';
  const STORAGE_NOTE = {
    IndexedDB: 'Styles are kept in IndexedDB on this device.',
    localStorage: 'IndexedDB isn\'t available here: styles are kept in localStorage, which holds about 50-100.',
    memory: 'No storage here: imported styles are lost when the page reloads.',
  };
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
    // Grouped by folder, each under a sticky header that collapses it (saved). While searching, every match shows.
    const groups = {};
    rows.forEach((e) => { (groups[e.folder || ''] = groups[e.folder || ''] || []).push(e); });
    const folders = Object.keys(groups).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const searching = !!view.search.trim();
    $('lib-list').innerHTML = folders.map((folder) => {
      const closed = !searching && !!state.collapsed[folder];
      const head = `<div class="folder${closed ? ' closed' : ''}" data-folder="${esc(folder)}" role="button" aria-expanded="${!closed}">` +
        `<span class="folder-arrow">${closed ? '▸' : '▾'}</span><span class="folder-name">${esc(folder || 'Other')}</span>` +
        `<span class="folder-count">${groups[folder].length}</span></div>`;
      if (closed) return head;
      return head + groups[folder].map((e) => {
        const on = current && current.entry.id === e.id ? ' on' : '';
        const sub = [e.meter, e.tempo + ' bpm', e.source === 'sty' ? 'Yamaha' : 'Roland'].join(' · ');
        return `<div class="row${on}" data-id="${esc(e.id)}">` +
          `<div class="row-main"><div class="row-name">${esc(e.name)}</div><div class="row-sub">${esc(sub)}</div></div></div>`;
      }).join('');
    }).join('') || `<div class="empty">${library.size ? 'No styles match.' : 'No styles yet. + adds style files; the folder button adds every style in a folder.'}</div>`;
    $('lib-count').textContent = library.size ? `${rows.length} of ${library.size} styles` : '';
    renderStorage();
  }

  // The loaded style: name, summary, the section buttons, the parts with their channels.
  const SECTION_GROUPS = [
    { title: 'INTRO', kind: 'intro', letters: ['A', 'B', 'C'] },
    { title: 'MAIN', kind: 'main', letters: ['A', 'B', 'C', 'D'] },
    { title: 'FILL', kind: 'fill' },
    { title: 'BREAK', kind: 'break' },
    { title: 'ENDING', kind: 'ending', letters: ['A', 'B', 'C'] },
  ];
  // The VEL menu: -40..+40 in steps of 5, added to every note of the part.
  const VEL_OPTIONS = Array.from({ length: 17 }, (_, k) => (k - 8) * 5).map((v) => `<option value="${v}">${v > 0 ? '+' + v : v === 0 ? 'VEL 0' : v}</option>`).join('');
  const CHANNEL_OPTIONS = '<option value="0">OFF</option>' + Array.from({ length: 16 }, (_, k) => `<option value="${k + 1}">${k + 1}</option>`).join('');
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
    $('style-sections').innerHTML = SECTION_GROUPS.map((g) => {
      let btns;
      if (g.letters) {
        btns = g.letters.map((l) => {
          const id = g.kind + l, sec = s.sections[id];
          return `<button class="btn sec" type="button" data-kind="${g.kind}" data-letter="${l}" data-id="${id}"${sec ? '' : ' disabled'} title="${sec ? sec.bars + ' bar' + (sec.bars === 1 ? '' : 's') : 'not in this style'}">${l}</button>`;
        });
      } else {
        const ids = s.order.filter((id) => s.sections[id].kind === g.kind);
        btns = [`<button class="btn sec" type="button" data-kind="${g.kind}"${ids.length ? '' : ' disabled'} title="${ids.length ? esc(ids.map((id) => s.sections[id].name).join(', ')) : 'not in this style'}">${g.title}</button>`];
      }
      return `<div class="sec-group"><div class="sec-title">${g.kind === 'fill' || g.kind === 'break' ? '&nbsp;' : g.title}</div><div class="sec-btns${g.letters ? ' pill' : ''}">${btns.join('')}</div></div>`;
    }).join('');
    $('style-parts').innerHTML = s.parts.map((p) => {
      const v = p.voice, m = channelMap.get(p.id);
      const voice = v.program != null ? `program ${v.program + 1}${v.msb ? ' (bank ' + v.msb + ')' : ''}` : '';
      return `<div class="part-row" data-part="${esc(p.id)}"><span class="part-name">${esc(p.name)}</span>` +
        `<select data-ch title="Output channel">${CHANNEL_OPTIONS}</select>` +
        `<button class="btn" type="button" data-prg aria-pressed="${m.program}" title="Send bank and program changes on this channel (off for a drum plugin)">PRG</button>` +
        `<button class="btn" type="button" data-mute aria-pressed="${m.mute}" title="Mute">MUTE</button>` +
        `<select data-vel title="Velocity boost: added to every note of this part (all styles)">${VEL_OPTIONS}</select>` +
        `<span class="part-voice">${esc(voice)}</span></div>`;
    }).join('');
    Array.from($('style-parts').querySelectorAll('.part-row')).forEach((row) => {
      row.querySelector('[data-ch]').value = String(channelMap.get(row.getAttribute('data-part')).channel);
      row.querySelector('[data-vel]').value = String(channelMap.get(row.getAttribute('data-part')).velocity);
    });
    renderTransport();
  }

  // Section buttons lit from the flow: the one playing, the one coming at the next bar line (blinking), where a
  // one-shot goes next, and while stopped the armed intro (blinking) and the selected main.
  function renderTransport() {
    const f = player.flow;
    $('start').textContent = player.playing ? 'STOP' : 'START';
    $('start').classList.toggle('on', player.playing);
    $('start').disabled = !current;
    $('sync').setAttribute('aria-pressed', String(sync.armed));
    $('autofill').setAttribute('aria-pressed', String(state.autoFill));
    $('tempo').textContent = String(Math.round(player.tempo));
    $('vol').textContent = Math.round(player.volume * 100) + '%';
    if (!f || !current) return;
    const pos = player.playing ? player.position(performance.now()) : null;
    const playingId = pos ? pos.section : null;
    Array.from($('style-sections').querySelectorAll('.sec')).forEach((b) => {
      const kind = b.getAttribute('data-kind'), id = b.getAttribute('data-id');
      const match = (x) => x && (id ? x === id : A.SectionFlow.kindOf(x) === kind);
      b.classList.toggle('on', !!match(playingId));
      b.classList.toggle('pending', player.playing ? !!match(f.pending) : (kind === 'intro' && match(f.armed)));
      b.classList.toggle('next', player.playing && !!match(f.after) && !match(f.pending));
      b.classList.toggle('sel', !player.playing && kind === 'main' && id === 'main' + f.main);
    });
  }

  // The bar / beat counter, while playing: bar number, then the pulses in their groups.
  let lastCounter = '';
  function renderCounter() {
    const pos = player.playing && player.position(performance.now());
    let html = '';
    if (pos) {
      const m = player.meter, dots = [];
      for (let p = 0; p < m.num; p++) {
        if (p && m.starts[p]) dots.push('<span class="sep">|</span>');
        dots.push(`<span class="p${m.starts[p] ? ' g' : ''}${p === pos.pulse ? ' on' : ''}">●</span>`);
      }
      html = `<span class="bar">${pos.bar + 1}</span>${dots.join('')}`;
      if (pos.section !== lastSection) { lastSection = pos.section; renderTransport(); }
    } else if (lastSection) { lastSection = null; renderTransport(); }
    if (html !== lastCounter) { $('counter').innerHTML = html; lastCounter = html; }
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
      if (player.playing) {
        // Playing: the new style takes over at the next bar line, in its Main A (no intro).
        player.changeStyle(current.style, channelMap, set.groups, set.tempo);
        player.setVolume(set.volume != null ? set.volume : 1);
      } else {
        player.load(current.style, channelMap, set.groups);
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

  // Files from the pickers: style files only for a folder (it may hold other things), anything for a pick (the
  // content decides, and iOS doesn't always keep extensions).
  async function importFiles(fileList, fromFolder) {
    if (!library || view.importing) return;
    const files = Array.from(fileList || []).filter((f) => !fromFolder || /\.(sty|stl|sth)$/i.test(f.name));
    if (!files.length) { showMessages(fromFolder ? '<div class="warn">No .sty or .stl files in that folder.</div>' : ''); return; }
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
      (r.duplicates.length ? `, ${r.duplicates.length} already in the library` : '') +
      (r.failed.length ? `, ${r.failed.length} skipped:` : '.') + '</div>'];
    r.failed.slice(0, 30).forEach((f) => lines.push(`<div class="warn">${esc(f.name)}: ${esc(f.error)}</div>`));
    if (r.failed.length > 30) lines.push(`<div class="warn">… and ${r.failed.length - 30} more.</div>`);
    showMessages(lines.join(''));
    renderLibrary();
    if (!current && r.added.length === 1) loadStyle(r.added[0].id);
  }

  $('lib-import').addEventListener('click', () => $('lib-files').click());
  $('lib-folder').addEventListener('click', () => $('lib-dir').click());
  $('lib-folder').hidden = !('webkitdirectory' in document.createElement('input')) || /iPad|iPhone/.test(navigator.userAgent);
  $('lib-files').addEventListener('change', (ev) => { importFiles(ev.target.files, false); ev.target.value = ''; });
  $('lib-dir').addEventListener('change', (ev) => { importFiles(ev.target.files, true); ev.target.value = ''; });
  $('lib-search').addEventListener('input', (ev) => { view.search = ev.target.value; renderLibrary(); });
  $('lib-clear').addEventListener('click', () => { view.search = ''; $('lib-search').value = ''; renderLibrary(); });
  $('lib-fav').addEventListener('click', () => { view.favorites = !view.favorites; renderLibrary(); });
  $('lib-meter').addEventListener('change', (ev) => { view.meter = ev.target.value; renderLibrary(); });
  $('lib-list').addEventListener('click', async (ev) => {
    const head = ev.target.closest('.folder');
    if (head) {
      if (view.search.trim()) return;                 // searching shows every match; folders open again after
      const f = head.getAttribute('data-folder');
      if (state.collapsed[f]) delete state.collapsed[f]; else state.collapsed[f] = true;
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
  $('start').addEventListener('click', startStop);
  $('panic').addEventListener('click', () => {
    sync.armed = false;
    if (player.playing) player.stop();
    panic();
    renderTransport();
    setStatus('All notes off.');
  });

  $('sync').addEventListener('click', () => { sync.armed = !sync.armed && !player.playing; renderTransport(); });
  $('autofill').addEventListener('click', () => {
    state.autoFill = !state.autoFill; save();
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
  $('style-parts').addEventListener('change', (ev) => {
    const row = ev.target.closest('.part-row');
    if (!row) return;
    if (ev.target.matches('[data-vel]')) {
      channelMap.set(row.getAttribute('data-part'), { velocity: Number(ev.target.value) });
      state.channelMap = channelMap.toJSON(); save();
      return;
    }
    if (!ev.target.matches('[data-ch]')) return;
    channelMap.set(row.getAttribute('data-part'), { channel: Number(ev.target.value) });
    state.channelMap = channelMap.toJSON(); save();
  });
  $('style-parts').addEventListener('click', (ev) => {
    const row = ev.target.closest('.part-row'), b = ev.target.closest('.btn');
    if (!row || !b) return;
    const id = row.getAttribute('data-part'), m = channelMap.get(id);
    if (b.hasAttribute('data-prg')) channelMap.set(id, { program: !m.program });
    if (b.hasAttribute('data-mute')) channelMap.set(id, { mute: !m.mute });
    state.channelMap = channelMap.toJSON(); save();
    b.setAttribute('aria-pressed', String(b.hasAttribute('data-prg') ? !m.program : !m.mute));
  });
  // Space bar: start / stop (not while typing in the search box).
  document.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
    ev.preventDefault();
    startEnding();
  });
  // The space bar (and the Start / Ending control): start with Intro A; while playing, the first ending.
  function startEnding() {
    if (!current || !player.flow) return;
    const f = player.flow;
    if (!player.playing) {
      // Starting from the space bar plays Intro A first, when the style has one and no other intro is armed.
      if (!f.armed && current.style.sections.introA) player.press('intro', 'A');
      startStop();
      return;
    }
    // While playing: the first ending (A, else the nearest one the style has), then stop. Pressed again during
    // the ending (or with no ending in the style): stop at once.
    const ending = f.currentKind === 'ending' || A.SectionFlow.kindOf(f.pending) === 'ending';
    const hasEnding = current.style.order.some((id) => current.style.sections[id].kind === 'ending');
    if (ending || !hasEnding) startStop();
    else { player.press('ending', 'A'); renderTransport(); }
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
  function doAction(id) {
    const m = /^(intro|main|ending)([A-D])$/.exec(id);
    if (m) { player.press(m[1], m[2]); renderTransport(); return; }
    if (id === 'fill' || id === 'break') { player.press(id, player.flow && player.flow.main); renderTransport(); return; }
    if (id === 'startStop') startStop();
    else if (id === 'startEnding') startEnding();
    else if (id === 'syncStart') $('sync').click();
    else if (id === 'autoFill') $('autofill').click();
    else if (id === 'tapTempo') tap();
    else if (id === 'tempoDown') changeTempo(player.tempo - 1);
    else if (id === 'tempoUp') changeTempo(player.tempo + 1);
  }
  // The list in the settings: each action, what it's assigned to, the port it listens on, LEARN, LATCH and ✕.
  function renderControls() {
    const ins = midi.access ? A.MidiPorts.list(midi.access.inputs) : [];
    $('controls-list').innerHTML = A.Controls.ACTIONS.map((act) => {
      const a = controls.get(act.id), learning = controls.learning === act.id;
      let second = '';
      if (a) {
        const known = !a.port || ins.some((p) => p.id === a.port.id || p.name === a.port.name);
        const opts = '<option value="">ANY PORT</option>' + ins.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') +
          (a.port && !known ? `<option value="${esc(a.port.id || '')}">${esc(a.port.name)} (not connected)</option>` : '');
        second = `<div class="ctl-line"><select data-port title="The port this control listens on">${opts}</select>` +
          (a.type === 'cc' ? `<button class="btn" type="button" data-latch aria-pressed="${!!a.latch}" title="For pedals that send on and off on alternate presses">LATCH</button>` : '') + '</div>';
      }
      return `<div class="ctl-row${a ? ' set' : ''}" data-act="${act.id}"><div class="ctl-line"><span class="ctl-name">${esc(act.name)}</span>` +
        `<span class="ctl-what">${learning ? 'press a switch…' : esc(A.Controls.describe(a))}</span>` +
        `<button class="btn" type="button" data-learn aria-pressed="${learning}">LEARN</button>` +
        (a ? '<button class="btn" type="button" data-clear aria-label="Remove">✕</button>' : '') + `</div>${second}</div>`;
    }).join('');
    Array.from($('controls-list').querySelectorAll('.ctl-row')).forEach((row) => {
      const a = controls.get(row.getAttribute('data-act')), sel = row.querySelector('[data-port]');
      if (a && sel) sel.value = a.port ? (ins.find((p) => p.id === a.port.id || p.name === a.port.name) || a.port).id || '' : '';
    });
  }
  $('controls-list').addEventListener('click', (ev) => {
    const row = ev.target.closest('.ctl-row'), b = ev.target.closest('.btn');
    if (!row || !b) return;
    const id = row.getAttribute('data-act');
    if (b.hasAttribute('data-learn')) { if (controls.learning === id) controls.cancelLearn(); else controls.learn(id); }
    else if (b.hasAttribute('data-clear')) controls.clear(id);
    else if (b.hasAttribute('data-latch')) { const a = controls.get(id); a.latch = !a.latch; controls.assign(id, a); }
    state.controls = controls.toJSON(); save();
    renderControls();
  });
  $('controls-list').addEventListener('change', (ev) => {
    const row = ev.target.closest('.ctl-row');
    if (!row || !ev.target.matches('[data-port]')) return;
    const id = row.getAttribute('data-act'), a = controls.get(id);
    const p = A.MidiPorts.list(midi.access ? midi.access.inputs : []).find((x) => x.id === ev.target.value);
    a.port = p ? { id: p.id, name: p.name } : null;
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
  $('lib-restore').addEventListener('click', () => $('lib-zip').click());
  $('lib-zip').addEventListener('change', async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f || !library || view.importing) return;
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
  });

  // STORAGE in the settings: where styles are kept, how many, and how much space their files take.
  function renderStorage() {
    const bytes = library.totalBytes();
    const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
    const amount = library.size ? ` ${library.size} style${library.size === 1 ? '' : 's'}, ${size}.` : ' No styles yet.';
    $('storage-status').textContent = STORAGE_NOTE[library.backend.kind] + amount;
  }

  async function openLibrary() {
    library = await A.StyleLibrary.openBest(window);
    renderLibrary();
    if (state.styleId && library.entries[state.styleId]) loadStyle(state.styleId);
  }

  fillMenus();
  renderChord(null);
  renderKeys();
  renderStyle();
  renderControls();
  openLibrary();
  start();
  requestAnimationFrame(renderCounter);
}());
