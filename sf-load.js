// arrangerLoadSFont(synth, { buffer, port }): loads a SoundFont into FluidSynth without copying it on the way.
// js-synthesizer's own loadSFont copies the bank twice before FluidSynth reads it (a structured clone to the audio
// thread, then FS.writeFile into Emscripten's in-memory file system). Here the page transfers the buffer to the
// worklet (callFunction), and the file system is told it may own the bytes (FS.write with canOwn), so the only
// other copy is the one FluidSynth keeps. The file is removed again at once.
// The SoundFont id goes back through port (callFunction returns nothing); it's also the return value.
// Runs in the AudioWorklet (added with addModule after the FluidSynth library; js-synthesizer looks the function up
// on AudioWorkletGlobalScope) and on the page (a classic script, window.arrangerLoadSFont) when there's no worklet.
(function () {
  'use strict';
  const inWorklet = typeof AudioWorkletGlobalScope !== 'undefined';
  let serial = 0;

  function arrangerLoadSFont(synth, param) {
    let id = -1, error = '';
    try {
      const M = inWorklet ? AudioWorkletGlobalScope.wasmModule : self.Module;
      const bytes = new Uint8Array(param.buffer);
      const name = '/arranger-bank-' + (++serial) + '.sf2';
      const stream = M.FS.open(name, 'w');
      M.FS.write(stream, bytes, 0, bytes.length, 0, true);   // canOwn: the file uses these bytes, no copy
      M.FS.close(stream);
      const len = M.lengthBytesUTF8(name) + 1, ptr = M._malloc(len);
      M.stringToUTF8(name, ptr, len);
      try { id = M._fluid_synth_sfload(synth.getRawSynthesizer(), ptr, 1); } finally { M._free(ptr); M.FS.unlink(name); }
      if (id < 0) error = 'Not a SoundFont FluidSynth can read';
    } catch (e) { id = -1; error = e && e.message ? e.message : String(e); }
    if (param.port) { param.port.postMessage({ id, error }); param.port.close(); }
    return id;
  }

  // After a load the bank's bytes are garbage, but the audio thread makes almost no garbage of its own, so its
  // collector didn't run and the whole file stayed in memory (Airfont 340: the tab at +149 MB instead of +81 MB,
  // measured 2026-11-25). Allocating some short-lived ArrayBuffers (external memory) makes V8 run a full collection,
  // and the file's buffer goes with it; a burst of small objects did not (the buffer isn't in the young generation).
  // Called as its own message, after the load's message is done (that message still holds the buffer). The answer
  // comes back through port. On the page (no worklet) it does the same for the page's heap.
  function arrangerSweep(synth, param) {
    // Short-lived 1 MB buffers: external memory that makes V8 run a full collection, which frees the file's buffer.
    let n = 0;
    for (let i = 0; i < 96; i++) { const b = new ArrayBuffer(1 << 20); n += b.byteLength; }
    if (param && param.port) { param.port.postMessage(n); param.port.close(); }
    return n;
  }

  if (inWorklet) { AudioWorkletGlobalScope.arrangerLoadSFont = arrangerLoadSFont; AudioWorkletGlobalScope.arrangerSweep = arrangerSweep; }
  else { self.arrangerLoadSFont = arrangerLoadSFont; self.arrangerSweep = arrangerSweep; }
}());
