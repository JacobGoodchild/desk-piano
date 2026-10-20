// Tap-first fusion: the microphone says WHEN (and how loud); the TapResolver says WHICH finger(s)
// by looking at how the fingers moved just before and just after the tap. Hands that hover, rest
// or move about without a tap never play. A note lasts until its finger lifts.
import { TapResolver } from './tap-resolver.js';

export const TAP_FUSION_DEFAULTS = {
  maxWaitMs: 250, // give up on a tap if no camera frame after it arrives in time
  echoMs: 250, // speaker mode: taps this soon after the app's own note need a clearer finger
  echoLeadFactor: 1.8,
  maxHoldMs: 4000, // safety: release a note if its finger was lost track of
};

export class TapFusion {
  constructor({ keyFor, play, stop, opts = {}, resolverOpts = {} }) {
    this.keyFor = keyFor; // (pick) → midi | null
    this.play = play;
    this.stop = stop;
    this.o = { ...TAP_FUSION_DEFAULTS, ...opts };
    this.resolver = new TapResolver(resolverOpts);
    this.speakerMode = false;
    this.pending = [];
    this.sounding = new Map(); // finger id → { midi, landY, size, t }
    this.lastPlayT = -1e9;
    this.stats = { taps: 0, tapsRejected: 0, notes: 0 };
    this.log = [];
  }

  onTap(tap) {
    this.stats.taps++;
    this.pending.push(tap);
    this._resolvePending();
  }

  onFrame(frame) {
    this.resolver.pushFrame(frame);
    // lifts
    for (const [id, s] of this.sounding) {
      if (this.resolver.lifted(id, s.landY, s.size, s.landX) || frame.t - s.t > this.o.maxHoldMs) {
        this.sounding.delete(id);
        this.stop(s.midi, { fingerId: id });
      }
    }
    this._resolvePending();
  }

  tick(now) {
    // taps whose camera frames never came
    const keep = [];
    for (const p of this.pending) {
      if (now - p.t > this.o.maxWaitMs) this.stats.tapsRejected++;
      else keep.push(p);
    }
    this.pending = keep;
  }

  _resolvePending() {
    const still = [];
    for (const tap of this.pending) {
      if (!this.resolver.ready(tap.t)) { still.push(tap); continue; }
      const suspicious = this.speakerMode && tap.t - this.lastPlayT >= 0 && tap.t - this.lastPlayT < this.o.echoMs;
      let picks = this.resolver.resolve(tap.t);
      if (suspicious) picks = picks.filter((p) => p.lead >= this.resolver.o.minLead * this.o.echoLeadFactor);
      let played = 0;
      const midis = new Set();
      for (const p of picks) {
        const midi = this.keyFor(p);
        if (midi == null || midis.has(midi)) continue;
        midis.add(midi);
        if (this.sounding.has(p.id)) this.stop(this.sounding.get(p.id).midi, { fingerId: p.id });
        this.sounding.set(p.id, { midi, landX: p.x, landY: p.y, size: p.size, t: tap.t });
        this.lastPlayT = tap.t;
        this.stats.notes++;
        this.log.push({ t: tap.t, midi, vel: tap.velocity, how: 'tap', fingerId: p.id });
        if (this.log.length > 200) this.log.shift();
        this.play(midi, tap.velocity, { fingerId: p.id, how: 'tap', t: tap.t, tap });
        played++;
      }
      if (!played) this.stats.tapsRejected++;
    }
    this.pending = still;
  }

  allOff() {
    for (const [id, s] of this.sounding) this.stop(s.midi, { fingerId: id });
    this.sounding.clear();
  }
}
