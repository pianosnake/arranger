// MidiPorts: picking ports and sharing inputs between the parts of the page. No DOM.
//   list(portMap)               the ports of MIDIAccess.inputs / .outputs as an array (also takes an array)
//   pick(ports, saved, pattern) saved = { id, name }: the port with the saved id, else the saved name (ids change
//                               between sessions on some systems; names can repeat, "Bluetooth" on iOS), else the
//                               first whose name matches pattern, else the first port; null if there are none.
//                               saved.none = true: the user chose no port.
//   InputHub                    several routes (keyboard, the button controls, MIDI learn) can listen to the same
//                               input, which has only one onmidimessage. route(key, port, fn, priority) sets one
//                               (port null removes it); fn(data, port) returning true consumes the message, so
//                               lower-priority routes don't see it (a foot switch's CC never reaches the keyboard).
//                               Only ports with a route get an onmidimessage handler; the others are set to null.
//                               routeAll(key, fn, priority) listens on every input (MIDI learn).
// Loaded as a classic script (window.Arranger.MidiPorts) or with require() in Node (tests).
(function () {
  'use strict';

  function list(map) {
    if (!map) return [];
    if (Array.isArray(map)) return map.slice();
    const out = [];
    map.forEach((p) => out.push(p));
    return out;
  }

  function pick(ports, saved, pattern) {
    const s = saved || {};
    if (s.none) return null;
    return (s.id && ports.find((p) => p.id === s.id)) ||
      (s.name && ports.find((p) => p.name === s.name)) ||
      (pattern && ports.find((p) => pattern.test(p.name || ''))) ||
      ports[0] || null;
  }

  class InputHub {
    constructor() { this.ports = []; this.routes = {}; this.handled = []; }
    // The current inputs (call again after a statechange).
    setPorts(ports) { this.ports = ports.slice(); this.apply(); }
    route(key, port, fn, priority) {
      if (!port || !fn) delete this.routes[key];
      else this.routes[key] = { port, fn, priority: priority || 0, all: false };
      this.apply();
    }
    routeAll(key, fn, priority) {
      if (!fn) delete this.routes[key];
      else this.routes[key] = { port: null, fn, priority: priority || 0, all: true };
      this.apply();
    }
    // Routes for a port, highest priority first.
    routesFor(port) {
      return Object.keys(this.routes).map((k) => this.routes[k])
        .filter((r) => r.all || r.port === port || (r.port && port && r.port.id === port.id))
        .sort((a, b) => b.priority - a.priority);
    }
    dispatch(port, data) {
      const rs = this.routesFor(port);
      for (let k = 0; k < rs.length; k++) if (rs[k].fn(data, port) === true) return true;
      return false;
    }
    apply() {
      this.handled.forEach((p) => { if (this.ports.indexOf(p) < 0) p.onmidimessage = null; });
      this.handled = [];
      this.ports.forEach((p) => {
        if (this.routesFor(p).length) {
          p.onmidimessage = (ev) => this.dispatch(p, ev.data);
          this.handled.push(p);
        } else if (p.onmidimessage) p.onmidimessage = null;
      });
    }
  }

  const MidiPorts = { list, pick, InputHub };
  if (typeof module !== 'undefined' && module.exports) module.exports = MidiPorts;
  else (window.Arranger = window.Arranger || {}).MidiPorts = MidiPorts;
}());
