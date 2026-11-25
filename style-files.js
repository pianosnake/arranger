// StyleFiles: reads a style file of any supported kind, by its content (not its extension).
//   StyleFiles.kind(bytes)          'sty' | 'stl' (Roland .stl and .sth) | null
//   StyleFiles.read(bytes, name)    -> Style; throws Error with a readable message
// Loaded as a classic script (window.Arranger.StyleFiles) or with require() in Node (tests).
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const Smf = isNode ? require('./smf.js') : window.Arranger.Smf;
  const StyReader = isNode ? require('./sty-reader.js') : window.Arranger.StyReader;
  const StlReader = () => (isNode ? (() => { try { return require('./stl-reader.js'); } catch (e) { return null; } })() : window.Arranger.StlReader);

  function kind(input) {
    const b = Smf.toBytes(input);
    const head = Smf.ascii(b, 0, Math.min(4, b.length));
    if (head === 'MThd') return 'sty';
    if (head.slice(0, 2) === 'G8' || head.slice(0, 2) === 'EV') return 'stl';
    const R = StlReader();
    if (R && R.isSth(b)) return 'stl';                 // Roland STH: read by the same reader
    return null;
  }

  function read(input, name) {
    const b = Smf.toBytes(input);
    const k = kind(b);
    if (k === 'sty') return StyReader.parse(b, name);
    if (k === 'stl') {
      const R = StlReader();
      if (!R) throw new Error('Roland styles aren\'t supported yet.');
      return R.parse(b, name);
    }
    if (!b.length) throw new Error('The file is empty.');
    throw new Error('Not a Yamaha (.sty) or Roland (.stl / .sth) style.');
  }

  const StyleFiles = { kind, read };
  if (isNode) module.exports = StyleFiles;
  else (window.Arranger = window.Arranger || {}).StyleFiles = StyleFiles;
}());
