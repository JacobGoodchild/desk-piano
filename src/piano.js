// Sampled grand piano (Salamander Grand Piano V3, CC-BY 3.0, Alexander Holm).
// Samples every 3 semitones (C, D#, F#, A) from C2 to C7, 4 velocity layers; notes in between
// are pitch-shifted by at most ±1 semitone (well, 1.5 at the extreme) and adjacent layers are crossfaded.
const SAMPLE_PCS = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };
const LAYERS = [
  { v: 4, at: 0.22 },
  { v: 8, at: 0.48 },
  { v: 12, at: 0.74 },
  { v: 16, at: 1.0 },
];
const START_OFFSET = 0.008; // skip encoder padding before the hammer strike
const LOW = 36, HIGH = 96; // C2..C7

function sampleMidis() {
  const out = [];
  for (let m = LOW; m <= HIGH; m++) if (SAMPLE_PCS[m % 12] !== undefined) out.push(m);
  return out;
}
const fileName = (m, v) => `${SAMPLE_PCS[m % 12]}${Math.floor(m / 12) - 1}v${v}.mp3`;

export class Piano {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.6 * 0.5; // ×0.5 here, ×2 inside the shaper curve: headroom up to 2.0
    // gentle soft-clipper so big chords don't crackle (no added delay, unlike a compressor)
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1025);
    // linear up to 0.6, then rounds off smoothly towards 1 (input range ±2)
    for (let i = 0; i < curve.length; i++) { const x = (i / 512 - 1) * 2; curve[i] = Math.abs(x) < 0.6 ? x : Math.sign(x) * (0.6 + 0.4 * Math.tanh((Math.abs(x) - 0.6) / 0.4)); }
    shaper.curve = curve;
    this.out.connect(shaper).connect(destination || ctx.destination);
    this.buffers = new Map(); // `${midi}-${v}` → AudioBuffer
    this.voices = new Map(); // midi → [voice]
    this.sustain = false;
    this.loaded = false;
    this.release = 0.11; // damper time-constant (s)
  }

  async load(baseUrl = 'samples/piano/', onProgress) {
    const jobs = [];
    // load the mid layer first so something is playable quickly
    const order = [1, 3, 0, 2].map((i) => LAYERS[i]);
    for (const L of order) for (const m of sampleMidis()) jobs.push({ m, v: L.v });
    for (const m of sampleMidis()) jobs.push({ m, rel: true });
    let done = 0;
    const fetchOne = async ({ m, v, rel }) => {
      const name = rel ? `rel${m}.mp3` : fileName(m, v);
      const res = await fetch(baseUrl + encodeURIComponent(name));
      if (!res.ok) throw new Error(`sample ${name}: ${res.status}`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(rel ? `rel-${m}` : `${m}-${v}`, buf);
      done++;
      if (onProgress) onProgress(done / jobs.length);
    };
    const queue = jobs.slice();
    const workers = Array.from({ length: 6 }, async () => { while (queue.length) await fetchOne(queue.shift()); });
    await Promise.all(workers);
    this.loaded = true;
  }

  _nearestSample(midi) {
    let best = null;
    for (const m of sampleMidis()) if (best == null || Math.abs(m - midi) < Math.abs(best - midi)) best = m;
    return best;
  }

  // velocity 0..1. Returns the voice.
  noteOn(midi, velocity = 0.6, when = 0) {
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    const vel = Math.min(1, Math.max(0.02, velocity));
    // re-striking a sounding note: damp the old one quickly
    this._release(midi, t, 0.03, true);
    const sm = this._nearestSample(midi);
    const rate = Math.pow(2, (midi - sm) / 12);
    // pick two neighbouring layers and crossfade
    let hi = LAYERS.findIndex((L) => vel <= L.at);
    if (hi < 0) hi = LAYERS.length - 1;
    const lo = Math.max(0, hi - 1);
    const span = LAYERS[hi].at - (hi === lo ? 0 : LAYERS[lo].at);
    const mix = hi === lo ? 1 : Math.min(1, Math.max(0, (vel - LAYERS[lo].at) / span));
    // overall loudness follows velocity a little on top of the recorded layers
    const amp = 0.18 + 0.82 * Math.pow(vel, 1.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(amp, t);
    gain.connect(this.out);
    const sources = [];
    for (const [idx, w] of [[lo, 1 - mix], [hi, mix]]) {
      if (w < 0.02) continue;
      const buf = this.buffers.get(`${sm}-${LAYERS[idx].v}`) || this._anyLayer(sm);
      if (!buf) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = Math.sqrt(w);
      src.connect(g).connect(gain);
      src.start(t, START_OFFSET);
      sources.push(src);
      if (lo === hi) break;
    }
    const voice = { midi, gain, sources, held: true, start: t, released: false, vel };
    if (!this.voices.has(midi)) this.voices.set(midi, []);
    this.voices.get(midi).push(voice);
    sources[0] && (sources[0].onended = () => this._forget(voice));
    return voice;
  }

  _anyLayer(sm) {
    for (const L of LAYERS) { const b = this.buffers.get(`${sm}-${L.v}`); if (b) return b; }
    return null;
  }

  _forget(voice) {
    const list = this.voices.get(voice.midi);
    if (!list) return;
    const i = list.indexOf(voice);
    if (i >= 0) list.splice(i, 1);
    try { voice.gain.disconnect(); } catch { /* already gone */ }
  }

  _release(midi, t, tc, force) {
    const list = this.voices.get(midi);
    if (!list) return;
    for (const v of list) {
      if (v.released) continue;
      if (!force && this.sustain) { v.held = false; continue; }
      v.released = true;
      v.held = false;
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0, t, tc);
      if (!force) this._releaseSound(midi, v.vel, t);
      for (const s of v.sources) { try { s.stop(t + tc * 8); } catch { /* not started */ } }
    }
  }

  // the soft "thump" of the damper landing back on the strings (recorded release samples)
  _releaseSound(midi, vel, t) {
    const sm = this._nearestSample(midi);
    const buf = this.buffers.get(`rel-${sm}`);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (midi - sm) / 12);
    const g = this.ctx.createGain();
    g.gain.value = 0.02 + 0.06 * vel; // the recordings are normalised loud; real damper noise is subtle
    src.connect(g).connect(this.out);
    src.start(t);
    src.onended = () => { try { g.disconnect(); } catch { /* gone */ } };
  }

  noteOff(midi) {
    // notes above ~G6 have no dampers on a real grand: let them ring
    if (midi >= 91) { const list = this.voices.get(midi) || []; list.forEach((v) => (v.held = false)); return; }
    this._release(midi, this.ctx.currentTime, this.release, false);
  }

  setSustain(on) {
    this.sustain = on;
    if (on) return;
    const t = this.ctx.currentTime;
    for (const [midi, list] of this.voices) {
      for (const v of list) {
        if (!v.held && !v.released && midi < 91) {
          v.released = true;
          v.gain.gain.cancelScheduledValues(t);
          v.gain.gain.setTargetAtTime(0, t, this.release * 1.4);
          this._releaseSound(midi, v.vel * 0.6, t);
          for (const s of v.sources) { try { s.stop(t + 1.2); } catch { /* ignore */ } }
        }
      }
    }
  }

  allOff() {
    const t = this.ctx.currentTime;
    for (const midi of this.voices.keys()) this._release(midi, t, 0.05, true);
  }
}
