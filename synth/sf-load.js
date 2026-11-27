// arrangerLoadSFont(synth, { buffer }): loads a SoundFont into FluidSynth without copying it on the way.
// js-synthesizer's own loadSFont copies the bank into Emscripten's in-memory file system (FS.writeFile) before
// FluidSynth reads it. Here the file system is told it may own the bytes (FS.write with canOwn), so the only other
// copy is the one FluidSynth keeps. The file is removed again at once. Returns the SoundFont id (< 0: not a bank).
// Also arrangerBoot(rate, settings) -> { synth, seq }: FluidSynth and its sequencer at this sample rate.
// Loaded in the synth's frame (SoundFontSynth writes it), after the FluidSynth library.
(function () {
  'use strict';
  let serial = 0;

  function arrangerLoadSFont(synth, param) {
    const M = self.Module;
    const bytes = new Uint8Array(param.buffer);
    const name = '/arranger-bank-' + (++serial);   // no extension: MIDIWeb's offline save rewrites file-like strings
    const stream = M.FS.open(name, 'w');
    M.FS.write(stream, bytes, 0, bytes.length, 0, true);   // canOwn: the file uses these bytes, no copy
    M.FS.close(stream);
    const len = M.lengthBytesUTF8(name) + 1, ptr = M._malloc(len);
    M.stringToUTF8(name, ptr, len);
    try { return M._fluid_synth_sfload(synth.getRawSynthesizer(), ptr, 1); } finally { M._free(ptr); M.FS.unlink(name); }
  }

  // After a load the bank's bytes are garbage, but nothing else makes much garbage, so the collector didn't run and
  // the whole file stayed in memory (Airfont 340: +149 MB instead of +81 MB, measured 2026-11-25). Allocating some
  // short-lived ArrayBuffers (external memory) makes V8 run a full collection, and the file's buffer goes with it; a
  // burst of small objects did not (the buffer isn't in the young generation).
  function arrangerSweep() {
    let n = 0;
    for (let i = 0; i < 96; i++) { const b = new ArrayBuffer(1 << 20); n += b.byteLength; }
    return n;
  }

  // A synth and its sequencer at this sample rate. The sequencer runs on the samples rendered (not a timer).
  async function arrangerBoot(rate, settings) {
    self.JSSynth.Synthesizer.initializeWithFluidSynthModule(self.Module);
    await self.JSSynth.Synthesizer.waitForWasmInitialized();
    const synth = new self.JSSynth.Synthesizer();
    synth.init(rate, settings);
    const seq = await self.JSSynth.Synthesizer.createSequencer();
    await seq.registerSynthesizer(synth);
    return { synth, seq };
  }

  self.arrangerBoot = arrangerBoot;
  self.arrangerLoadSFont = arrangerLoadSFont;
  self.arrangerSweep = arrangerSweep;
}());
