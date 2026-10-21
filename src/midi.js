// MIDI: send what you play to a real keyboard / synth / music app (Web MIDI), and record what
// you play as a standard MIDI file you can download. Nothing is uploaded anywhere.

export class MidiOut {
  constructor() { this.access = null; this.port = null; }
  async enable() {
    if (!navigator.requestMIDIAccess) throw new Error('This browser has no Web MIDI');
    this.access = await navigator.requestMIDIAccess();
    return this.outputs();
  }
  outputs() { return this.access ? [...this.access.outputs.values()].map((o) => ({ id: o.id, name: o.name })) : []; }
  select(id) { this.port = this.access && id ? this.access.outputs.get(id) || null : null; }
  noteOn(midi, vel) { if (this.port) this.port.send([0x90, midi & 127, Math.max(1, Math.min(127, Math.round(vel * 127)))]); }
  noteOff(midi) { if (this.port) this.port.send([0x80, midi & 127, 64]); }
  pedal(on) { if (this.port) this.port.send([0xb0, 64, on ? 127 : 0]); }
}

export class Recorder {
  constructor() { this.events = null; this.t0 = 0; this.last = null; }
  get recording() { return !!this.events; }
  start() { this.events = []; this.t0 = performance.now(); }
  stop() {
    // close anything still held when recording stopped (notes, pedal), so playback and the saved
    // file don't leave a note or the pedal stuck on
    if (this.events) {
      const t = performance.now() - this.t0;
      const held = new Map();
      let pedal = false;
      for (const e of this.events) {
        if (e.type === 'on') held.set(e.a, (held.get(e.a) || 0) + 1);
        else if (e.type === 'off') held.set(e.a, Math.max(0, (held.get(e.a) || 0) - 1));
        else if (e.type === 'pedal') pedal = !!e.a;
      }
      for (const [m, n] of held) for (let i = 0; i < n; i++) this.events.push({ t, type: 'off', a: m });
      if (pedal) this.events.push({ t, type: 'pedal', a: false });
    }
    this.last = this.events; this.events = null; return this.last;
  }
  add(type, a, b) { if (this.events) this.events.push({ t: performance.now() - this.t0, type, a, b }); }

  // Standard MIDI file (format 0, 480 ticks per beat at 120 bpm → 1 tick ≈ 1.04 ms)
  toMidiFile(events = this.last) {
    const bytes = [];
    const vlq = (n) => { const out = [n & 127]; while ((n >>= 7)) out.unshift((n & 127) | 128); return out; };
    const ticks = (ms) => Math.round(ms * 480 / 500);
    let prev = 0;
    bytes.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // tempo 500000 µs/beat (120 bpm)
    for (const e of events || []) {
      const t = ticks(e.t);
      bytes.push(...vlq(Math.max(0, t - prev)));
      prev = t;
      if (e.type === 'on') bytes.push(0x90, e.a & 127, Math.max(1, Math.min(127, Math.round(e.b * 127))));
      else if (e.type === 'off') bytes.push(0x80, e.a & 127, 64);
      else if (e.type === 'pedal') bytes.push(0xb0, 64, e.a ? 127 : 0);
    }
    bytes.push(0x00, 0xff, 0x2f, 0x00);
    const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (480 >> 8) & 255, 480 & 255];
    const len = bytes.length;
    const track = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...bytes];
    return new Uint8Array([...header, ...track]);
  }
}
