// MidiPorts: picking ports and sharing inputs between the parts of the page. No DOM.
//   list(portMap)               the ports of MIDIAccess.inputs / .outputs as an array (also takes an array), without
//                               ports that went away (Chrome keeps them, 'disconnected'). Walked with next() by hand:
//                               the iOS Web MIDI Browser app's map iterator isn't iterable (from gokeys).
//   pick(ports, saved, pattern) saved = { id, name }: the port with the saved id, else the saved name if only one port
//                               has it (ids change between sessions on some systems; in the iOS Web MIDI Browser app
//                               every Bluetooth device's port is called "Bluetooth"), else the first whose name matches
//                               pattern, else the first port; null if there are none. saved.none: no port chosen.
//   ref(ports, port)            { id, name, nth } to save; find(ports, saved): that port again, or null (see find)
//   label(ports, port)          the port's name for menus; a name several ports share gets a number in port order
//                               ("Bluetooth 1", "Bluetooth 2"), as in gokeys
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
    const out = [];
    const add = (p) => { if (p && p.state !== 'disconnected') out.push(p); };
    if (Array.isArray(map)) map.forEach(add);
    else if (typeof map.values === 'function') {
      const it = map.values();
      for (let o = it.next(); !o.done; o = it.next()) add(o.value);
    } else if (typeof map.forEach === 'function') map.forEach(add);
    return out;
  }

  // What to save about a port: its id (as text, '' when it has none), its name, and which of the ports with that
  // name it is (nth). Some browsers (the iOS Web MIDI Browser app) give ports no usable id, or the same one.
  function ref(ports, port) {
    const same = ports.filter((q) => q.name === port.name);
    return { id: port.id == null ? '' : String(port.id), name: port.name, nth: Math.max(0, same.indexOf(port)) };
  }
  // The saved port among these: by id when exactly one port has it; else by name and position among the ports with
  // that name; else by name when only one has it. null when it isn't there.
  function find(ports, saved) {
    const s = saved || {};
    if (s.none) return null;
    const byId = s.id ? ports.filter((p) => p.id != null && String(p.id) === String(s.id)) : [];
    if (byId.length === 1) return byId[0];
    const named = s.name ? ports.filter((p) => p.name === s.name) : [];
    if (s.nth != null && named[s.nth]) return named[s.nth];
    return named.length === 1 ? named[0] : null;
  }
  function pick(ports, saved, pattern) {
    const s = saved || {};
    if (s.none) return null;
    return find(ports, s) || (pattern && ports.find((p) => pattern.test(p.name || ''))) || ports[0] || null;
  }

  function label(ports, port) {
    const same = ports.filter((q) => q.name === port.name);
    return same.length > 1 ? `${port.name} ${same.indexOf(port) + 1}` : port.name;
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

  const MidiPorts = { list, pick, find, ref, label, InputHub };
  if (typeof module !== 'undefined' && module.exports) module.exports = MidiPorts;
  else (window.Arranger = window.Arranger || {}).MidiPorts = MidiPorts;
}());
