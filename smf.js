// Smf: a Standard MIDI File reader. No DOM, no MIDI.
//   Smf.parse(bytes) -> { format, ppq, tracks: [[Event]], end, warnings }
//     bytes    Uint8Array (or array / ArrayBuffer)
//     Event    { tick, delta, status, data: [bytes after the status] }   channel messages (running status resolved)
//              { tick, delta, meta: type, data: [bytes] }                meta events (0x51 tempo, 0x58 time sig, ...)
//              { tick, delta, sysex: [bytes, F0 included] }
//     end      the byte offset after the last track: Yamaha styles put their CASM chunk after it
//   Throws SmfError with a readable message for files that aren't MIDI files. A file that is cut short keeps the
//   events that are there and gets a warning.
// Loaded as a classic script (window.Arranger.Smf) or with require() in Node (tests).
(function () {
  'use strict';

  class SmfError extends Error {}

  const toBytes = (b) => (b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : Uint8Array.from(b));
  const ascii = (b, at, n) => String.fromCharCode.apply(null, Array.from(b.subarray(at, at + n)));
  const u16 = (b, at) => (b[at] << 8) | b[at + 1];
  const u32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
  // Data bytes after each channel status (0x80-0xE0).
  const DATA_LEN = { 0x80: 2, 0x90: 2, 0xA0: 2, 0xB0: 2, 0xC0: 1, 0xD0: 1, 0xE0: 2 };

  function parse(input) {
    const b = toBytes(input);
    if (b.length < 14 || ascii(b, 0, 4) !== 'MThd') throw new SmfError('Not a MIDI file (no MThd header).');
    const hlen = u32(b, 4);
    const format = u16(b, 8), ntracks = u16(b, 10), division = u16(b, 12);
    if (division & 0x8000) throw new SmfError('SMPTE timing is not supported.');
    if (!division) throw new SmfError('The MIDI file has 0 ticks per quarter note.');
    const warnings = [];
    const tracks = [];
    let at = 8 + hlen;
    for (let t = 0; t < ntracks; t++) {
      if (at + 8 > b.length) { warnings.push(`The file ends before track ${t + 1}.`); break; }
      if (ascii(b, at, 4) !== 'MTrk') throw new SmfError(`Track ${t + 1} has no MTrk header.`);
      let len = u32(b, at + 4), start = at + 8;
      if (start + len > b.length) { warnings.push(`Track ${t + 1} is cut short.`); len = b.length - start; }
      tracks.push(parseTrack(b, start, start + len, warnings, t + 1));
      at = start + len;
    }
    return { format, ppq: division, tracks, end: at, warnings };
  }

  function parseTrack(b, start, end, warnings, num) {
    const events = [];
    let at = start, tick = 0, running = 0, eventAt = start;
    const vlq = () => {
      let v = 0;
      for (let k = 0; k < 4; k++) {
        if (at >= end) throw new RangeError();
        const c = b[at++];
        v = (v << 7) | (c & 0x7F);
        if (c < 0x80) return v;
      }
      throw new RangeError();
    };
    const take = (n) => {
      if (at + n > end) throw new RangeError();
      const out = Array.from(b.subarray(at, at + n)); at += n; return out;
    };
    try {
      while (at < end) {
        eventAt = at;
        const delta = vlq();
        tick += delta;
        if (at >= end) throw new RangeError();
        let status = b[at];
        if (status === 0xFF) {
          at++;
          const type = take(1)[0];
          const data = take(vlq());
          events.push({ tick, delta, meta: type, data });
          if (type === 0x2F) break;                      // end of track
        } else if (status === 0xF0 || status === 0xF7) {
          at++;
          const data = take(vlq());
          events.push({ tick, delta, sysex: status === 0xF0 ? [0xF0].concat(data) : data });
          running = 0;
        } else {
          if (status & 0x80) { running = status; at++; } else if (!running) throw new SmfError(`Track ${num}: data byte without a status.`);
          status = running;
          const len = DATA_LEN[status & 0xF0];
          if (len == null) throw new SmfError(`Track ${num}: unknown status ${status.toString(16)}.`);
          events.push({ tick, delta, status, data: take(len) });
        }
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      // Some style editors write the track length one byte short, cutting the end-of-track event (FF 2F 00) in two:
      // nothing is lost.
      const rest = Array.from(b.subarray(eventAt, end));
      const endOfTrack = rest.length >= 3 && rest[rest.length - 2] === 0xFF && rest[rest.length - 1] === 0x2F;
      if (!endOfTrack) warnings.push(`Track ${num} ends in the middle of an event.`);
    }
    return events;
  }

  const Smf = { parse, SmfError, ascii, u16, u32, toBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = Smf;
  else (window.Arranger = window.Arranger || {}).Smf = Smf;
}());
