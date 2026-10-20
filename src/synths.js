// Extra keyboard sounds made entirely in the browser (no samples, nothing to download):
// electric piano (FM "tine"), drawbar organ, harpsichord and string pad. Same interface as Piano.
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

class SynthBase {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    // same soft limiter as the piano: ×0.5 here, ×2 inside the curve
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) { const x = (i / 512 - 1) * 2; curve[i] = Math.abs(x) < 0.6 ? x : Math.sign(x) * (0.6 + 0.4 * Math.tanh((Math.abs(x) - 0.6) / 0.4)); }
    shaper.curve = curve;
    this.out.connect(shaper).connect(destination || ctx.destination);
    this.voices = new Map();
    this.sustain = false;
    this.loaded = true;
    this.setVolume(1, true);
  }
  // trim: per-instrument level so every sound is about as loud as the grand piano
  setVolume(v, immediate = false) {
    this.volume = v;
    const g = 0.5 * v * (this.trim || 1);
    if (immediate) { this.out.gain.cancelScheduledValues(0); this.out.gain.value = g; } else this.out.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }
  async load() { this.loaded = true; }
  noteOn(midi, velocity = 0.6) {
    const t = this.ctx.currentTime;
    this._stop(midi, t, 0.02);
    const vel = Math.min(1, Math.max(0.02, velocity));
    const v = this.makeVoice(midi, vel, t);
    v.held = true; v.released = false; v.midi = midi;
    this.voices.set(midi, v);
    return v;
  }
  noteOff(midi) {
    const v = this.voices.get(midi);
    if (!v) return;
    v.held = false;
    if (!this.sustain) this._stop(midi, this.ctx.currentTime, this.releaseTime);
  }
  setSustain(on) {
    this.sustain = on;
    if (on) return;
    for (const [m, v] of this.voices) if (!v.held) this._stop(m, this.ctx.currentTime, this.releaseTime);
  }
  allOff() { for (const m of [...this.voices.keys()]) this._stop(m, this.ctx.currentTime, 0.05); }
  _stop(midi, t, tc) {
    const v = this.voices.get(midi);
    if (!v || v.released) return;
    v.released = true;
    v.amp.gain.cancelScheduledValues(t);
    v.amp.gain.setTargetAtTime(0, t, tc);
    for (const o of v.nodes) { try { o.stop(t + tc * 8 + 0.05); } catch { /* not started */ } }
    this.voices.delete(midi);
    setTimeout(() => { try { v.amp.disconnect(); } catch { /* gone */ } }, (tc * 8 + 0.2) * 1000);
  }
}

// Electric piano: two-operator FM, bright bell-like attack that mellows, long decay.
export class ElectricPiano extends SynthBase {
  constructor(ctx, dest) { super(ctx, dest); this.trim = 0.17; this.setVolume(1, true); this.releaseTime = 0.08; }
  makeVoice(midi, vel, t) {
    const ctx = this.ctx, f = mtof(midi);
    const amp = ctx.createGain();
    amp.connect(this.out);
    const car = ctx.createOscillator(); car.frequency.value = f;
    const mod = ctx.createOscillator(); mod.frequency.value = f * 14; // tine "ping"
    const mod2 = ctx.createOscillator(); mod2.frequency.value = f; // body
    const mg = ctx.createGain(), mg2 = ctx.createGain();
    mg.gain.setValueAtTime(f * 1.2 * vel, t); mg.gain.setTargetAtTime(0, t, 0.03);
    mg2.gain.setValueAtTime(f * (0.4 + 1.6 * vel), t); mg2.gain.setTargetAtTime(f * 0.15, t, 0.4);
    mod.connect(mg).connect(car.frequency); mod2.connect(mg2).connect(car.frequency);
    car.connect(amp);
    const peak = 0.12 + 0.5 * Math.pow(vel, 1.4);
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(peak, t + 0.003);
    amp.gain.setTargetAtTime(peak * 0.35, t + 0.003, 0.5); amp.gain.setTargetAtTime(0, t + 1.5, 2.5);
    for (const o of [car, mod, mod2]) o.start(t);
    return { amp, nodes: [car, mod, mod2] };
  }
}

// Drawbar organ: sine partials (16', 8', 4', 2 2/3', 2'), constant level while held, key click.
export class Organ extends SynthBase {
  constructor(ctx, dest) { super(ctx, dest); this.trim = 0.38; this.setVolume(1, true); this.releaseTime = 0.03; }
  makeVoice(midi, vel, t) {
    const ctx = this.ctx, f = mtof(midi);
    const amp = ctx.createGain(); amp.connect(this.out);
    const nodes = [];
    for (const [mult, lvl] of [[0.5, 0.5], [1, 0.8], [2, 0.5], [3, 0.35], [4, 0.25]]) {
      const o = ctx.createOscillator(); o.frequency.value = f * mult;
      o.detune.value = (Math.random() - 0.5) * 4;
      const g = ctx.createGain(); g.gain.value = lvl * 0.09;
      o.connect(g).connect(amp); o.start(t); nodes.push(o);
    }
    // organs don't respond to touch much: level fixed, a hint of velocity
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(0.75 + 0.25 * vel, t + 0.008);
    return { amp, nodes };
  }
}

// Harpsichord: bright plucked sawtooth through a closing filter.
export class Harpsichord extends SynthBase {
  constructor(ctx, dest) { super(ctx, dest); this.trim = 0.28; this.setVolume(1, true); this.releaseTime = 0.05; }
  makeVoice(midi, vel, t) {
    const ctx = this.ctx, f = mtof(midi);
    const amp = ctx.createGain(); amp.connect(this.out);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.Q.value = 1;
    filt.frequency.setValueAtTime(Math.min(16000, f * 24), t); filt.frequency.setTargetAtTime(f * 3, t, 0.25);
    filt.connect(amp);
    const nodes = [];
    for (const d of [-4, 4]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d; o.connect(filt); o.start(t); nodes.push(o); }
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(0.18, t + 0.002); // harpsichords have no dynamics
    amp.gain.setTargetAtTime(0, t + 0.002, 1.2);
    return { amp, nodes };
  }
}

// String pad: detuned sawtooths, soft attack, warm filter that opens with velocity.
export class Strings extends SynthBase {
  constructor(ctx, dest) { super(ctx, dest); this.trim = 0.95; this.setVolume(1, true); this.releaseTime = 0.35; }
  makeVoice(midi, vel, t) {
    const ctx = this.ctx, f = mtof(midi);
    const amp = ctx.createGain(); amp.connect(this.out);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 900 + 3500 * vel; filt.Q.value = 0.5;
    filt.connect(amp);
    const nodes = [];
    for (const d of [-9, 0, 8]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d; const g = ctx.createGain(); g.gain.value = 0.05; o.connect(g).connect(filt); o.start(t); nodes.push(o); }
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(0.4 + 0.6 * vel, t + 0.25);
    return { amp, nodes };
  }
}

export const INSTRUMENTS = {
  piano: 'Grand piano',
  epiano: 'Electric piano',
  organ: 'Organ',
  harpsichord: 'Harpsichord',
  strings: 'Strings',
};
export const SYNTHS = { epiano: ElectricPiano, organ: Organ, harpsichord: Harpsichord, strings: Strings };
