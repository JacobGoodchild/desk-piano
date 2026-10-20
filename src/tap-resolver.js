// Tap-first note picking. When the microphone hears a tap, look back over the last ~quarter
// second of hand tracking and pick the finger(s) that came down MORE than the rest of that hand.
// Measuring against the hand's other fingers matters: when you rest your hand on the paper or
// move it about, all fingers move together and nothing should play; when you press a key, one
// finger moves more than its neighbours. Several fingers clearly moving more = a chord.
export const TIPS = [4, 8, 12, 16, 20];

export const RESOLVER_DEFAULTS = {
  lookbackMs: 250, // how far back to look for the finger's highest point before the tap
  afterMs: 70, // also use frames up to this long after the tap (the landing frame); tuned on real clips: 70 ms
  // scored ~46%, 35 ms ~37% — it's the 'faster ↔ more accurate' setting
  minTravel: 0.03, // a pressing finger must come down at least this far (hand-sizes)
  minLead: 0.03, // ...and this much more than the hand's typical finger
  chordRatio: 0.9, // other fingers join as a chord if they moved at least this fraction as much
  lateMs: 100, // a real press is still moving down in the last ~100 ms before the tap...
  minLate: 0.04, // ...by at least this much (hand-sizes)
  maxAfter: 0.2, // ...and has stopped by the frame after the tap (no further travel than this)
  lateWeight: 1, // score = travel + lateWeight × late
  liftDist: 0.12, // a sounding finger is lifted when it rises this far above where it landed
  historyMs: 1200,
};

export class TapResolver {
  constructor(opts = {}) {
    this.o = { ...RESOLVER_DEFAULTS, ...opts };
    this.frames = []; // {t, hands:[{label, points}]}
  }

  pushFrame(frame) {
    this.frames.push(frame);
    while (this.frames.length > 2 && frame.t - this.frames[0].t > this.o.historyMs) this.frames.shift();
  }

  latestT() { return this.frames.length ? this.frames[this.frames.length - 1].t : -Infinity; }

  // Can a tap at time t be resolved yet (have we seen a frame after it)?
  ready(t) { return this.latestT() >= t + this.o.afterMs; }

  // Returns [{ id, hand, tip, x, y, travel, lead }] — possibly empty (nothing pressed).
  resolve(t) {
    const o = this.o;
    const win = this.frames.filter((f) => f.t >= t - o.lookbackMs && f.t <= t + o.afterMs);
    if (!win.length) return [];
    const last = win[win.length - 1];
    // the frame closest to the tap, and the one ~lateMs before it
    const atTap = nearest(win, t), before = nearest(this.frames, t - o.lateMs);
    const picks = [];
    for (const hand of last.hands) {
      const P = hand.points;
      const size = handSize(P);
      const hTap = atTap && atTap.hands.find((x) => x.label === hand.label);
      const hBefore = before && before.hands.find((x) => x.label === hand.label);
      const fingers = TIPS.map((tip) => {
        let minY = Infinity;
        for (const f of win) {
          const h = f.hands.find((x) => x.label === hand.label);
          if (h) minY = Math.min(minY, h.points[tip].y);
        }
        const travel = (P[tip].y - minY) / size;
        const late = hTap && hBefore ? (hTap.points[tip].y - hBefore.points[tip].y) / size : travel;
        const after = hTap ? (P[tip].y - hTap.points[tip].y) / size : 0;
        return { tip, travel, late, after, score: travel + o.lateWeight * late };
      });
      const sorted = fingers.map((x) => x.score).sort((a, b) => a - b);
      const typical = sorted[2]; // median finger of this hand
      const ok = (f) => f.travel >= o.minTravel && f.late >= o.minLate && f.after <= o.maxAfter;
      const cands = fingers.filter(ok);
      if (!cands.length) continue;
      const best = cands.reduce((a, b) => (b.score > a.score ? b : a));
      const bestLead = best.score - typical;
      if (bestLead < o.minLead) continue;
      for (const f of cands) {
        const lead = f.score - typical;
        if (f === best || (lead >= o.minLead && lead >= bestLead * o.chordRatio)) {
          picks.push({ id: `${hand.label}-${f.tip}`, hand: hand.label, tip: f.tip, x: P[f.tip].x, y: P[f.tip].y, travel: f.travel, lead, size });
        }
      }
    }
    return picks;
  }

  // Has this finger lifted since it landed at landY? (image y, larger = lower)
  lifted(id, landY, size) {
    const [label, tipStr] = id.split('-');
    const tip = Number(tipStr);
    const f = this.frames[this.frames.length - 1];
    const h = f && f.hands.find((x) => x.label === label);
    if (!h) return true; // hand gone
    return (landY - h.points[tip].y) / size > this.o.liftDist;
  }
}

function nearest(frames, t) {
  let best = null;
  for (const f of frames) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return best;
}

export function handSize(P) {
  const span = Math.hypot(P[17].x - P[5].x, P[17].y - P[5].y);
  const wm = Math.hypot(P[9].x - P[0].x, P[9].y - P[0].y);
  return (span > 0.4 * wm ? span * 0.8 : wm) || 1;
}
