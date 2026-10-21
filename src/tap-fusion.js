// Tap-first fusion: the microphone says WHEN (and how loud); the TapResolver says WHICH finger(s)
// by looking at how the fingers moved just before and just after the tap. Hands that hover, rest
// or move about without a tap never play. A note lasts until its finger lifts.
import { TapResolver } from './tap-resolver.js';

export const TAP_FUSION_DEFAULTS = {
  maxWaitMs: 250, // give up on a tap if no camera frame after it arrives in time
  echoMs: 250, // speaker mode: taps this soon after the app's own note need a clearer finger
  echoLeadFactor: 1.8,
  maxHoldMs: 4000, // safety: release a note if its finger was lost track of
  earlyMs: 0, // > 0: decide this soon after the tap when one finger is clearly ahead...
  earlyMargin: 0.2, // ...by at least this much (otherwise wait the full time). On the clips: ~11% of
  // notes go early at 0.2 with no accuracy loss; 0.15 starts to cost accuracy
  // Auto-sync: on Jacob's (in-sync) clips the pressing finger stops ~17 ms before the tap is heard.
  // If the live app sees a different typical gap, the microphone and camera clocks are offset (each
  // device has its own delays) and taps are shifted to line up again. Accuracy is very sensitive to
  // this (±15 ms cost 4–10 points on the clips).
  autoSync: true,
  syncTargetMs: -17,
  syncSamples: 25,
  syncMaxMs: 120,
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
    this.syncOffset = 0; // ms added to tap times
    this.syncQueue = []; this.syncData = [];
    this.sounding = new Map(); // finger id → { midi, landY, size, t }
    this.lastPlayT = -1e9;
    this.stats = { taps: 0, tapsRejected: 0, notes: 0 };
    this.log = [];
  }

  onTap(tap) {
    this.stats.taps++;
    this.pending.push({ ...tap, t: tap.t + this.syncOffset });
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
    this._measureSync();
  }

  _measureSync() {
    if (!this.o.autoSync) return;
    const r = this.resolver;
    while (this.syncQueue.length && r.latestT() >= this.syncQueue[0].t + 120) {
      const { t, pick } = this.syncQueue.shift();
      const land = r.landingTime(t, pick);
      if (land == null) continue;
      this.syncData.push(land - t);
      if (this.syncData.length >= this.o.syncSamples) {
        const sorted = [...this.syncData].sort((a, b) => a - b);
        const err = sorted[sorted.length >> 1] - this.o.syncTargetMs; // >0: picture runs late vs sound
        if (Math.abs(err) > 15) {
          this.syncOffset = Math.max(-this.o.syncMaxMs, Math.min(this.o.syncMaxMs, this.syncOffset + Math.max(-30, Math.min(30, err * 0.5))));
        }
        this.syncData = [];
      }
    }
  }

  tick(now) {
    // safety: release notes whose finger hasn't been seen lifting for a long time (also when the
    // camera stops sending frames altogether)
    for (const [id, s] of this.sounding) {
      if (now - s.t > this.o.maxHoldMs) { this.sounding.delete(id); this.stop(s.midi, { fingerId: id }); }
    }
    // taps whose camera frames never came
    const keep = [];
    for (const p of this.pending) {
      if (now - p.t > this.o.maxWaitMs) { this.stats.tapsRejected++; this.stats.why = this.stats.why || {}; this.stats.why['no camera frame in time'] = (this.stats.why['no camera frame in time'] || 0) + 1; }
      else keep.push(p);
    }
    this.pending = keep;
  }

  _resolvePending() {
    const still = [];
    for (const tap of this.pending) {
      let early = null;
      if (!this.resolver.ready(tap.t)) {
        if (this.o.earlyMs && !tap.triedEarly && this.resolver.ready(tap.t, this.o.earlyMs)) {
          tap.triedEarly = true;
          const ep = this.resolver.resolve(tap.t, this.o.earlyMs);
          if (ep.length && ep.every((p) => p.margin >= this.o.earlyMargin)) early = ep;
        }
        if (!early) { still.push(tap); continue; }
      }
      const suspicious = this.speakerMode && tap.t - this.lastPlayT >= 0 && tap.t - this.lastPlayT < this.o.echoMs;
      if (early) this.stats.early = (this.stats.early || 0) + 1;
      let picks = early || this.resolver.resolve(tap.t);
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
        this.play(midi, tap.velocity, { fingerId: p.id, how: 'tap', t: tap.t - this.syncOffset, tap });
        played++;
        this.resolver.played(p, tap.t);
        if (!p.repeat && this.syncQueue.length < 50) this.syncQueue.push({ t: tap.t, pick: p });
      }
      if (!played) {
        this.stats.tapsRejected++;
        const why = picks.length ? (suspicious ? 'echo' : 'off the keys') : (this.resolver.lastWhy || []).join(' / ') || 'nothing';
        this.stats.why = this.stats.why || {};
        this.stats.why[why] = (this.stats.why[why] || 0) + 1;
        this.stats.lastWhy = why;
      }
    }
    this.pending = still;
  }

  allOff() {
    for (const [id, s] of this.sounding) this.stop(s.midi, { fingerId: id });
    this.sounding.clear();
  }
}
