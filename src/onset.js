// Fast tap ("tok") onset detector. Pure JS so it runs in the AudioWorklet, in Node tests and in
// the clip-test script. Feed it blocks of samples; it returns onsets with their sample position
// and peak level (used for loudness/velocity).
export class OnsetDetector {
  constructor(sampleRate, opts = {}) {
    this.sr = sampleRate;
    this.setOptions(opts);
    this.hpPrevX = 0; this.hpPrevY = 0;
    this.fast = 0; this.mid = 0; this.slow = 0;
    this.floor = 1e-2; // background noise level, learnt (starts high and settles in ~0.2 s)
    this.pos = 0; // absolute sample index of next sample
    this.lastOnset = -1e12;
    this.pending = null; // onset waiting for its peak window
    this.levelMax = 0;
  }

  setOptions({ sensitivity = 0.5, refractoryMs = 45, peakMs = 3, ratio = 4 } = {}) {
    // A tap must stand out from the room's background noise by this much: sensitivity 0..1 →
    // 22 dB (0) down to 8 dB (1). Microphones far from the desk hear taps only ~15-25 dB above
    // the background, so a fixed level doesn't work.
    this.aboveFloor = Math.pow(10, (22 - 14 * sensitivity) / 20);
    this.minLevel = Math.pow(10, -95 / 20); // absolute floor (digital silence)
    this.kFloorUp = 1 - Math.exp(-1 / (2.0 * this.sr));
    this.kFloorDown = 1 - Math.exp(-1 / (0.05 * this.sr));
    this.refractory = Math.round((refractoryMs / 1000) * this.sr);
    this.peakLen = Math.round((peakMs / 1000) * this.sr);
    this.ratio = ratio;
    const hpHz = 250;
    const rc = 1 / (2 * Math.PI * hpHz);
    this.hpA = rc / (rc + 1 / this.sr);
    this.dFast = Math.exp(-1 / (0.02 * this.sr));
    this.ring = new Float32Array(Math.max(8, Math.round(0.002 * this.sr))); // fast envelope 2 ms ago
    this.ringPos = 0;
    this.kMid = 1 - Math.exp(-1 / (0.015 * this.sr));
    this.kSlow = 1 - Math.exp(-1 / (0.08 * this.sr));
  }

  process(block) {
    const out = [];
    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      const y = this.hpA * (this.hpPrevY + x - this.hpPrevX);
      this.hpPrevX = x; this.hpPrevY = y;
      const a = Math.abs(y);
      this.fast = a > this.fast ? a : this.fast * this.dFast; // peak follower
      if (a > this.levelMax) this.levelMax = a;
      const n = this.pos;
      if (this.pending) {
        if (a > this.pending.peak) this.pending.peak = a;
        if (n - this.pending.sample >= this.peakLen) { out.push(this.pending); this.pending = null; }
      } else if (n - this.lastOnset > this.refractory && this.fast > this.minLevel && this.fast > this.floor * this.aboveFloor && this.fast > this.slow * this.ratio && this.fast > this.mid * 2.5 && this.fast > this.ring[this.ringPos] * 3) {
        // a tap rises within ~1 ms; speech and music swell much more slowly
        this.pending = { sample: n, peak: a, floor: this.floor };
        this.lastOnset = n;
      }
      // the slow (background) envelope rises slowly and is held up just after an onset so
      // the tail of one tap doesn't look like a new one
      const k = n - this.lastOnset < this.refractory ? this.kSlow * 4 : this.kSlow;
      this.slow += (this.fast - this.slow) * k;
      this.mid += (this.fast - this.mid) * this.kMid;
      // background floor: follows quiet stretches quickly, rises only slowly (taps don't lift it)
      this.floor += (this.mid - this.floor) * (this.mid < this.floor ? this.kFloorDown : this.kFloorUp);
      if (this.floor < 1e-6) this.floor = 1e-6;
      this.ring[this.ringPos] = this.fast;
      this.ringPos = (this.ringPos + 1) % this.ring.length;
      this.pos++;
    }
    return out;
  }

  // peak level since last call (for meters)
  takeLevel() { const l = this.levelMax; this.levelMax = 0; return l; }
}

// Loudness of a tap → piano velocity 0..1, from how far it stands out above the background
// noise (so it works whether the microphone is close or across the room).
export function peakToVelocity(peak, sensitivity = 0.5, floor = null) {
  if (floor) {
    const snr = 20 * Math.log10(Math.max(peak, 1e-9) / floor);
    const lo = 20 - 14 * sensitivity, hi = lo + 30;
    return Math.min(1, Math.max(0.08, 0.12 + 0.88 * ((snr - lo) / (hi - lo))));
  }
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  const lo = -36 - 24 * sensitivity; // quietest tap that still counts
  const hi = -6 - 10 * sensitivity; // loudest
  const v = (db - lo) / (hi - lo);
  return Math.min(1, Math.max(0.08, 0.08 + 0.92 * v));
}

// Learns the player's own range of tap loudness (desks, paper and microphones differ a lot) so
// their softest taps come out pp and their hardest ff. Until enough taps are heard it uses the
// fixed mapping above.
export class VelocityMapper {
  constructor(sensitivity = 0.5) { this.sensitivity = sensitivity; this.dbs = []; }
  static level(peak, floor) { return 20 * Math.log10(Math.max(peak, 1e-9) / (floor || 1)); }
  add(peak, floor = null) {
    this.dbs.push(VelocityMapper.level(peak, floor));
    if (this.dbs.length > 60) this.dbs.shift();
  }
  map(peak, floor = null) {
    const fixed = peakToVelocity(peak, this.sensitivity, floor);
    if (this.dbs.length < 8) return fixed;
    const sorted = [...this.dbs].sort((a, b) => a - b);
    const hi = sorted[Math.floor(sorted.length * 0.9)] + 3;
    const lo = Math.min(sorted[Math.floor(sorted.length * 0.1)] - 3, hi - 24);
    const db = VelocityMapper.level(peak, floor);
    const learnt = Math.min(1, Math.max(0.08, 0.1 + 0.9 * ((db - lo) / (hi - lo))));
    const w = Math.min(1, (this.dbs.length - 7) / 12); // blend in gradually
    return fixed * (1 - w) + learnt * w;
  }
}
