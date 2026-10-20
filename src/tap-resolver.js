// Tap-first note picking. When the microphone hears a tap, look back over the last ~quarter
// second of hand tracking and pick the finger(s) that came down MORE than the rest of that hand.
// Measuring against the hand's other fingers matters: when you rest your hand on the paper or
// move it about, all fingers move together and nothing should play; when you press a key, one
// finger moves more than its neighbours. Several fingers clearly moving more = a chord.
export const TIPS = [4, 8, 12, 16, 20];

// Defaults tuned on Jacob's first real clips (see CLAUDE.md overnight log).
export const RESOLVER_DEFAULTS = {
  lookbackMs: 250, // how far back to look for the finger's highest point before the tap
  afterMs: 70, // also use frames up to this long after the tap (the landing frame). 70 ms scored
  // ~46% on the clips, 35 ms ~37% — this is the "faster ↔ more accurate" setting
  minTravel: 0.03, // a pressing finger must come down at least this far (hand-sizes)
  minLead: 0.03, // ...and this much more than the hand's typical finger
  chordRatio: 1.01, // other fingers join as a chord if they moved at least this fraction as much;
  // > 1 = one note per hand per tap (default), 0.9 when chords are switched on in Settings
  lateMs: 100, // a real press is still moving down in the last ~100 ms before the tap...
  minLate: 0.04, // ...by at least this much (hand-sizes)
  maxAfter: 0.2, // ...and has stopped by the frame after the tap (no further travel than this)
  lateWeight: 1, // score = travel + lateWeight × late (+ zWeight × depth change)
  typicalRank: 1, // compare against this finger in travel order (0 = least moved, 2 = median)
  zWeight: 1, // weight of MediaPipe's fingertip depth change (helped the chromatic clip)
  handRatio: 0.6, // second hand joins a tap only if its best finger led by this fraction of the first's
  repeatMs: 600, // repeated notes: replay the last finger within this window (0 = off)...
  repeatLateFactor: 0, // ...as long as that finger isn't rising
  liftDist: 0.12, // a sounding finger is lifted when it rises this far above where it landed
  slideDist: 0.35, // ...or slides sideways this far (hand-sizes; ~a key width)
  historyMs: 1200,
};

export class TapResolver {
  constructor(opts = {}) {
    this.o = { ...RESOLVER_DEFAULTS, ...opts };
    this.frames = []; // {t, hands:[{label, points}]}
    this.templates = null; // taught finger patterns: { tip: [5 numbers] } (see FingerTeacher)
    this.lastPick = new Map(); // hand → { tip, t } of its last played finger
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
        // optional: change in MediaPipe's estimated depth over the same window (+ = away from camera)
        let dz = 0;
        if (o.zWeight && hBefore && P[tip].z != null && hBefore.points[tip].z != null) dz = (P[tip].z - hBefore.points[tip].z) / size;
        return { tip, travel, late, after, score: travel + o.lateWeight * late + o.zWeight * dz };
      });
      this.lastScores = { t, hand: hand.label, fingers: fingers.map((f) => ({ tip: f.tip, score: +f.score.toFixed(2), late: +f.late.toFixed(2) })) };
      const sorted = fingers.map((x) => x.score).sort((a, b) => a - b);
      const typical = sorted[o.typicalRank]; // a 'typical' non-pressing finger of this hand
      const ok = (f) => f.travel >= o.minTravel && f.late >= o.minLate && f.after <= o.maxAfter;
      const cands = fingers.filter(ok);
      if (!cands.length) {
        // Repeated notes: the same finger often presses again without lifting far, so it barely
        // moves. If the finger that played last (recently) dipped again, repeat it.
        const prev = this.lastPick.get(hand.label);
        if (o.repeatMs && prev && t - prev.t <= o.repeatMs) {
          const f = fingers.find((x) => x.tip === prev.tip);
          if (f && f.late >= o.minLate * o.repeatLateFactor && f.after <= o.maxAfter) {
            picks.push({ id: `${hand.label}-${f.tip}`, hand: hand.label, tip: f.tip, x: P[f.tip].x, y: P[f.tip].y, travel: f.travel, lead: 0, size, repeat: true });
          }
        }
        continue;
      }
      let best = cands.reduce((a, b) => (b.score > a.score ? b : a));
      // If the player has taught us how their fingers move together, pick the finger whose
      // learnt pattern best matches this tap (e.g. the ring finger dragged along by the middle).
      const vec = fingers.map((f) => Math.max(0, f.score - typical));
      if (this.templates) {
        let bestSim = -Infinity;
        for (const f of cands) {
          const T = this.templates[f.tip];
          if (!T) continue;
          const sim = cosine(vec, T);
          if (sim > bestSim) { bestSim = sim; best = f; }
        }
      }
      const bestLead = best.score - typical;
      if (bestLead < o.minLead) continue;
      for (const f of cands) {
        const lead = f.score - typical;
        if (f === best || (lead >= o.minLead && lead >= bestLead * o.chordRatio)) {
          picks.push({ id: `${hand.label}-${f.tip}`, hand: hand.label, tip: f.tip, x: P[f.tip].x, y: P[f.tip].y, travel: f.travel, lead, size });
        }
      }
    }
    // One tap usually comes from one hand. The other hand only joins if its finger moved
    // nearly as decisively (both hands striking together).
    const bestByHand = new Map();
    for (const p of picks) bestByHand.set(p.hand, Math.max(bestByHand.get(p.hand) ?? -Infinity, p.lead));
    const top = Math.max(-Infinity, ...bestByHand.values());
    const kept = picks.filter((p) => bestByHand.size < 2 || bestByHand.get(p.hand) >= top * o.handRatio);
    for (const p of kept) this.lastPick.set(p.hand, { tip: p.tip, t });
    return kept;
  }

  // When did this finger stop coming down (velocity fell below 25% of its peak), around tap time t?
  // Needs frames up to t+120 ms. Returns a time or null. Used to keep sound and picture in sync.
  landingTime(t, pick) {
    const ser = [];
    for (const f of this.frames) {
      if (f.t < t - 200 || f.t > t + 120) continue;
      const h = f.hands.find((x) => x.label === pick.hand);
      if (h) ser.push({ t: f.t, y: h.points[pick.tip].y / handSize(h.points) });
    }
    if (ser.length < 5) return null;
    const v = [];
    for (let i = 1; i < ser.length; i++) v.push({ t: (ser[i].t + ser[i - 1].t) / 2, v: (ser[i].y - ser[i - 1].y) / ((ser[i].t - ser[i - 1].t) / 1000) });
    let pk = 0;
    for (let i = 1; i < v.length; i++) if (v[i].v > v[pk].v) pk = i;
    if (v[pk].v < 0.5) return null;
    const lim = v[pk].v * 0.25;
    for (let i = pk + 1; i < v.length; i++) {
      if (v[i].v < lim) { const a = v[i - 1], b = v[i]; return a.t + ((a.v - lim) / (a.v - b.v)) * (b.t - a.t); }
    }
    return null;
  }

  // For teaching: the movement pattern of the hand that moved most at time t (5 numbers, thumb →
  // little finger), or null.
  pattern(t) {
    const o = this.o;
    const win = this.frames.filter((f) => f.t >= t - o.lookbackMs && f.t <= t + o.afterMs);
    if (!win.length) return null;
    const last = win[win.length - 1];
    const atTap = nearest(win, t), before = nearest(this.frames, t - o.lateMs);
    let bestVec = null, bestSum = 0;
    for (const hand of last.hands) {
      const P = hand.points, size = handSize(P);
      const hTap = atTap && atTap.hands.find((x) => x.label === hand.label);
      const hBefore = before && before.hands.find((x) => x.label === hand.label);
      const scores = TIPS.map((tip) => {
        let minY = Infinity;
        for (const f of win) { const h = f.hands.find((x) => x.label === hand.label); if (h) minY = Math.min(minY, h.points[tip].y); }
        const travel = (P[tip].y - minY) / size;
        const late = hTap && hBefore ? (hTap.points[tip].y - hBefore.points[tip].y) / size : travel;
        return travel + o.lateWeight * late;
      });
      const typical = [...scores].sort((a, b) => a - b)[o.typicalRank];
      const vec = scores.map((v) => Math.max(0, v - typical));
      const sum = vec.reduce((a, b) => a + b, 0);
      if (sum > bestSum) { bestSum = sum; bestVec = vec; }
    }
    return bestVec;
  }

  // Has this finger lifted (or slid sideways off its key) since it landed at (landX, landY)?
  lifted(id, landY, size, landX = null) {
    const [label, tipStr] = id.split('-');
    const tip = Number(tipStr);
    const f = this.frames[this.frames.length - 1];
    const h = f && f.hands.find((x) => x.label === label);
    if (!h) return true; // hand gone
    if (landX != null && Math.abs(h.points[tip].x - landX) / size > this.o.slideDist) return true;
    return (landY - h.points[tip].y) / size > this.o.liftDist;
  }
}

function cosine(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

// Collects taught patterns: tip → average normalised movement pattern.
export class FingerTeacher {
  constructor() { this.sums = {}; this.counts = {}; }
  add(tip, vec) {
    if (!vec) return false;
    const n = Math.hypot(...vec);
    if (!n) return false;
    const s = this.sums[tip] || (this.sums[tip] = [0, 0, 0, 0, 0]);
    vec.forEach((v, i) => { s[i] += v / n; });
    this.counts[tip] = (this.counts[tip] || 0) + 1;
    return true;
  }
  templates() {
    const out = {};
    for (const [tip, s] of Object.entries(this.sums)) out[tip] = s.map((v) => v / this.counts[tip]);
    return out;
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
