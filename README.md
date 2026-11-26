# Arranger

A Web MIDI page that will play Yamaha `.sty` and Roland `.stl` accompaniment styles. You play chords with your left
hand, the page finds the chord, and it plays the style's parts on separate MIDI channels, so the host can route them
(for example everything to a GM SoundFont player, drums to a drum plugin). See `PLAN.md` for the whole plan.

## Status

**Phase 1:** chord detection. Pick the keyboard's port and channel in the settings (gear), set the split point (or
press LEARN and then a key), and the page shows the chord you play below the split. Chord latch keeps the chord
after you let go, as on arranger keyboards.

**Yamaha formats:** SFF1 and SFF2 (Tyros-era `.sty`, with `Ctb2` chord rules).

**Phase 2:** the style list. + adds `.sty` / `.prs` / `.bcs` / `.sst` (Yamaha) and `.stl` / `.sth` (Roland) files; the folder button (desktop Chrome) adds every style in a folder.
The list is searchable, filters by time signature and keeps favourites. Tap a style to see its sections and parts.
Styles are stored in IndexedDB, so they're still there after a reload.

**Phase 3:** playback.
- Pick an OUTPUT port in the settings. It can be a synth, or the host's MIDI input, which then routes the channels.
- START, the MAIN A-D buttons, FILL, BREAK, INTRO and ENDING work. Changes land on the next bar line, and with
  AUTO FILL a fill plays first.
- SYNC START waits for your first chord.
- Tempo is set with − / +; a tap on the number goes back to the style's own tempo. It is saved per style.
- The counter shows the bar and the beat groups, e.g. 3+2+2 for 7/8.
- Each part's output channel, program changes (PRG) and MUTE are set under PARTS. The defaults are drums 10,
  bass 2, chords 3-4, pad 5 and phrases 6-8.
- RIGHT HAND sends the keys from the split up to a channel of your choice.
- Space bar: starts with Intro A (when there is one); pressed while playing it plays the first ending, then stops. Pressed again during the ending, it stops at once. START/STOP always stops at once.
- Picking another style while playing switches at the next bar line, into its Main A.
- CHORD STARTS STYLE (settings): a chord played while stopped starts the style.
- STORAGE (settings): how many styles there are and their size. BACKUP › ALL downloads the whole library as one zip
  (the style files in their folders, plus `library.json` with favourites and tempos). LIBRARY › RESTORE adds the styles back
  from such a zip, or from any zip of `.sty` / `.stl` / `.sth` files. A zip picked with + is restored the same way. BACKUP › FAVORITES saves only the starred styles, in the
  same format.
- Notes are sent about 100 ms ahead with timestamps. When the page goes to the background (another app or tab in
  front, the home screen), the style stops and nothing is sent until it's back: browsers slow down or stop a
  background page's timers, so the notes came slow and then all at once.

**Phase 4:** controls from other devices.
- In the settings, CONTROLS lists every button: Intro A-C, Main A-D, Fill, Break, Ending A-C, Start / Stop,
  Start / Ending (what the space bar does), Sync Start, Auto Fill, Tap Tempo and Tempo − / +.
- Tap LEARN next to one and press a switch: a CC, a note (pads) or a program change (pedal boards). The assignment
  keeps that switch's port and channel. Pick another port, or ANY PORT, from its menu.
- Messages used by a control never reach the keyboard: a foot switch on the keyboard's channel adds no notes.
- TAP (next to the tempo) sets the tempo from the last few taps, in quarter notes.

**Phase 5:** Roland `.stl` styles from the EM-2000 / EM-50 / G-800 era (all 167 files of the roland-em-styles
collection read).
- The Basic arrangement's Original / Variation are Main A / B; the Advanced arrangement's are Main C / D, when they
  differ from Basic. Each has its fills. Intro and Ending A come from Basic, B from Advanced when it differs.
- Each part has separate major, minor and seventh patterns; the one for the chord you play is used.
- Which Roland slot is which (intro, fills, ending) is worked out from their lengths: still to be confirmed by ear.
- Roland `.sth` styles too (13 Romanian styles checked): the same data as `.stl`, laid out a little differently.

**Built-in synth:** in the settings, OUTPUT › SOUND: SOUNDFONT plays the style on this device instead of sending
it to a MIDI port. BANK › CHOOSE… picks a General MIDI bank: `.sf2` only. `.sf3` isn't supported, so the page can use the SF2-only
FluidSynth build, which is about 4× smaller; FluidSynth's WebAssembly builds don't read `.dls`. Convert either to `.sf2`
with Polyphone (free).
- The bank is kept in IndexedDB and loads again with the page. The synth plays at a fixed level (50% gain);
  the style's VOL and the iPad's volume set the loudness.
- The synth is FluidSynth compiled to WebAssembly (js-synthesizer, in `lib/`). It renders on the page's own thread
  through a ScriptProcessor with a 2048-frame buffer, on every device: that's what sounded smooth on the iPad.
  Notes are timed by FluidSynth's sequencer on the samples rendered. The libraries load only when SOUNDFONT is
  chosen.
- FluidSynth lives in a hidden frame (`sf-frame.html`). Choosing another bank throws the frame away and makes a new
  one, so the old bank's memory really goes back (WebAssembly memory never shrinks otherwise).
- Browsers start audio only after a tap or a key press on the page: notes from the MIDI keyboard don't count. The
  settings say so when the sound hasn't started yet.
- RIGHT HAND and PANIC go to the synth as well. CLOCK PORT still sends MIDI clock to a port.
- Style timing isn't hurt by the buffer (notes are scheduled ahead); the right hand through the synth is a little
  late, so use MIDI PORT for live playing. On the iPad the ring / silent switch can mute web audio.

**MIDI clock:** pick a CLOCK PORT in the settings (off by default; it can be the same port as the output). It
sends Start on the first beat, 24 clocks a quarter note through every section, style and tempo change, and Stop when
the style stops (also at the end of an ending), so a looper or DAW follows the arranger.

**Music hash:** every style gets a hash of its music (everything the reader gets from the file, not its name), once,
when it's imported. Copies with different bytes (another name, folder, editor, or STL vs STH) share it.
- Tempo, VOL and the PARTS setup belong to the hash: copies share them, and they come back when a style is imported
  again.
- DEFAULTS, in the PARTS table's header, drops the loaded style's own PARTS setup; it's greyed out when there's none.
- Imports say how many new styles have the same music as one already in the library.

## Running it

Plain HTML and JS, no network. The only libraries are the built-in synth's, in `lib/` (js-synthesizer 1.13.0,
BSD-3, its main-thread build only, and its FluidSynth 2.4.6 WebAssembly build `externals/libfluidsynth-2.4.6.js`, LGPL-2.1), copied from npm. Start a web server in this folder and open http://localhost:8000 in
Chrome:

```
python3 -m http.server 8000
```

On the iPad, import the folder into MIDI Charmer and route the keyboard into the plugin in AUM.

Tests: `node --test arranger/tests/unit/` from `charmer/` (see `tests/README.md`).
