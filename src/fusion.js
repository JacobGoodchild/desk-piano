// Combines microphone taps (WHEN + how loud) with camera finger strikes (WHICH key).
// Rules (see CLAUDE.md):
//  - a tap only plays if a fingertip is landing (or about to land) at that moment;
//  - a clear camera strike with no tap still plays, a little later and quieter;
//  - in speaker mode, taps right after the app's own notes need a confirmed landing;
//  - the note lasts until the camera sees that finger lift (or the sustain pedal holds it).
export const FUSION_DEFAULTS = {
  matchMs: 90, // a tap and a landing this close in time belong together
  pendingMs: 120, // how long a tap waits for the camera to confirm a landing
  cameraOnlyMs: 100, // how long a landing waits for a tap before playing on its own
  descendLookMs: 80, // a finger seen descending this recently can be played straight away
  echoMs: 250, // window after the app's own note in which taps are suspicious (speaker mode)
  cameraOnlyVelocity: 0.3,
};

export class Fusion {
  constructor({ keyFor, play, stop, opts = {} }) {
    this.keyFor = keyFor; // (fingerEvent|fingerState) → midi | null
    this.play = play; // (midi, velocity, info)
    this.stop = stop; // (midi, info)
    this.o = { ...FUSION_DEFAULTS, ...opts };
    this.speakerMode = false;
    this.pendingTaps = [];
    this.landings = []; // unmatched landings
    this.fingerNote = new Map(); // finger id → midi currently sounding
    this.lastPlayT = -1e9;
    this.stats = { taps: 0, tapsRejected: 0, cameraOnly: 0, notes: 0, lastLatencyMs: null };
    this.log = [];
  }

  _start(fingerId, midi, vel, t, how) {
    if (midi == null) return false;
    if (this.fingerNote.has(fingerId)) this.stop(this.fingerNote.get(fingerId), { fingerId });
    this.fingerNote.set(fingerId, midi);
    this.lastPlayT = t;
    this.stats.notes++;
    this.log.push({ t, midi, vel, how, fingerId });
    if (this.log.length > 200) this.log.shift();
    this.play(midi, vel, { fingerId, how, t });
    return true;
  }

  // tap = { t (ms), velocity (0..1) }; detector = StrikeDetector (for fingers still descending)
  onTap(tap, detector) {
    this.stats.taps++;
    const suspicious = this.speakerMode && tap.t - this.lastPlayT >= 0 && tap.t - this.lastPlayT < this.o.echoMs;
    let played = 0;
    // landings already seen close to the tap
    for (const L of this.landings) {
      if (!L.used && Math.abs(L.t - tap.t) <= this.o.matchMs) {
        L.used = true;
        if (this._start(L.id, L.midi, tap.velocity, tap.t, 'tap+land')) played++;
      }
    }
    // fingers still on their way down: play now rather than wait a frame
    if (!suspicious && detector) {
      for (const f of detector.descending()) {
        if (this.fingerNote.has(f.id) || f.claimed) continue;
        const lastT = f.hist[f.hist.length - 1].t;
        if (tap.t - lastT > this.o.descendLookMs) continue;
        const midi = this.keyFor(detector.predict(f, tap.t));
        f.claimed = { midi, t: tap.t, velocity: tap.velocity };
        if (this._start(f.id, midi, tap.velocity, tap.t, 'tap+descending')) played++;
      }
    }
    // keep the tap open briefly so other fingers of a chord (or a late camera frame) can join
    this.pendingTaps.push({ ...tap, played, expires: tap.t + this.o.pendingMs });
    return played;
  }

  onStrikeEvents(events, detector) {
    for (const ev of events) {
      if (ev.type === 'land') {
        const f = detector && detector.fingers.get(ev.id);
        const midi = this.keyFor(ev);
        if (f && f.claimed) {
          // already playing from the tap; if the guess was the wrong key, correct it quickly
          const c = f.claimed;
          f.claimed = false;
          if (midi != null && midi !== c.midi && ev.t - c.t < 80 && this.fingerNote.get(ev.id) === c.midi) {
            this.stats.corrected = (this.stats.corrected || 0) + 1;
            this._start(ev.id, midi, c.velocity, ev.t, 'tap+corrected');
          }
          continue;
        }
        const tap = this.pendingTaps.find((p) => Math.abs(p.t - ev.t) <= this.o.matchMs);
        if (tap) {
          if (this._start(ev.id, midi, tap.velocity, ev.t, 'land+tap')) tap.played++;
        } else {
          this.landings.push({ ...ev, midi, used: false, expires: ev.t + this.o.cameraOnlyMs });
        }
      } else if (ev.type === 'lift' || ev.type === 'abort') {
        const f = detector && detector.fingers.get(ev.id);
        if (ev.type === 'abort' && !(f && f.claimed)) continue;
        if (f) f.claimed = false;
        const midi = this.fingerNote.get(ev.id);
        if (midi != null) { this.fingerNote.delete(ev.id); this.stop(midi, { fingerId: ev.id }); }
      }
    }
  }

  // call often (each frame / timer) with the current time in ms
  tick(now) {
    for (const p of this.pendingTaps) if (p.expires <= now && !p.played) this.stats.tapsRejected++;
    this.pendingTaps = this.pendingTaps.filter((p) => p.expires > now);
    for (const L of this.landings) {
      if (!L.used && L.expires <= now) {
        L.used = true;
        const v = Math.min(0.45, this.o.cameraOnlyVelocity + 0.03 * (L.speed || 0));
        if (this._start(L.id, L.midi, v, now, 'camera-only')) this.stats.cameraOnly++;
      }
    }
    this.landings = this.landings.filter((L) => !L.used);
  }

  allOff() {
    for (const [id, midi] of this.fingerNote) this.stop(midi, { fingerId: id });
    this.fingerNote.clear();
  }
}
