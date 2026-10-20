// Finger-strike detection from hand landmarks over time.
// Input each video frame: { t (ms), hands: [{ label: stable hand id, points: [{x,y}] ×21 (pixels) }] }
// A fingertip moving "down" toward the desk moves DOWN the image (larger y) when the camera
// faces the player from across the desk, tilted down. Speeds are measured in hand-sizes per
// second (hand size ≈ 0.8 × the knuckle span), so they don't depend on camera distance.
export const TIPS = [4, 8, 12, 16, 20];
const MCP = { 4: 2, 8: 5, 12: 9, 16: 13, 20: 17 };

export const STRIKE_DEFAULTS = {
  downSpeed: 1.2, // hand-sizes/s: a finger moving down at least this fast is "striking"
  stopRatio: 0.35, // landed when speed falls below this fraction of the peak
  liftDist: 0.09, // lifted when the tip rises this far (hand-sizes) above where it landed
  liftSpeed: 0.9, // ...or rises at least this fast
  minDrop: 0.06, // a strike must move down at least this far in total
  history: 250, // ms of history kept
  knuckleWeight: 0.6, // how much of the knuckle's own movement is subtracted from the tip's
};

export class StrikeDetector {
  constructor(opts = {}) {
    this.o = { ...STRIKE_DEFAULTS, ...opts };
    this.fingers = new Map(); // id → state
    this.lastT = 0;
  }

  update(frame) {
    const events = [];
    const seen = new Set();
    this.lastT = frame.t;
    for (const hand of frame.hands) {
      const P = hand.points;
      // hand size: the knuckle span (index→little finger) faces the camera and isn't foreshortened
      // like the wrist→knuckle length is when fingers point towards the camera
      const span = Math.hypot(P[17].x - P[5].x, P[17].y - P[5].y);
      const wm = Math.hypot(P[9].x - P[0].x, P[9].y - P[0].y);
      const size = (span > 0.4 * wm ? span * 0.8 : wm) || 1;
      for (const tip of TIPS) {
        const id = `${hand.label}-${tip}`;
        seen.add(id);
        let f = this.fingers.get(id);
        if (!f) { f = { id, hand: hand.label, tip, hist: [], down: false, peak: 0, landY: 0, descending: false }; this.fingers.set(id, f); }
        const p = P[tip];
        f.x = p.x; f.y = p.y; f.size = size;
        f.depth = (p.y - P[MCP[tip]].y) / size; // how far the tip hangs below its knuckle
        // measure the tip against its knuckle a little, so sliding the whole hand forward on
        // the desk (which also moves it down the picture) isn't mistaken for a strike
        f.hist.push({ t: frame.t, y: (p.y - this.o.knuckleWeight * P[MCP[tip]].y) / size, px: p.x, py: p.y });
        while (f.hist.length > 2 && frame.t - f.hist[0].t > this.o.history) f.hist.shift();
        const n = f.hist.length;
        if (n < 2) continue;
        const a = f.hist[n - 2], b = f.hist[n - 1];
        const dt = Math.max(1, b.t - a.t) / 1000;
        const vy = (b.y - a.y) / dt; // + = moving down
        f.vy = vy;
        if (!f.down) {
          if (vy > this.o.downSpeed) {
            if (!f.descending) { f.descending = true; f.startY = a.y; f.peak = 0; f.descendT = a.t; }
            f.peak = Math.max(f.peak, vy);
          } else if (f.descending) {
            // decelerated: landed if it had been moving fast and travelled far enough
            const drop = b.y - f.startY;
            if (vy < f.peak * this.o.stopRatio && drop >= this.o.minDrop) {
              f.down = true; f.descending = false; f.landY = b.y; f.landT = b.t;
              events.push({ type: 'land', id, t: b.t, x: p.x, y: p.y, speed: f.peak, depth: f.depth, hand: hand.label, tip });
            } else if (vy <= 0) {
              f.descending = false;
              events.push({ type: 'abort', id, t: b.t });
            }
          }
        } else {
          f.landY = Math.max(f.landY, b.y); // settle to the lowest point
          if (f.landY - b.y > this.o.liftDist || vy < -this.o.liftSpeed * 1.5) {
            f.down = false; f.descending = false;
            events.push({ type: 'lift', id, t: b.t });
          }
        }
      }
    }
    // hands that vanished: lift their fingers
    for (const [id, f] of this.fingers) {
      if (!seen.has(id)) {
        if (f.down) events.push({ type: 'lift', id, t: frame.t });
        this.fingers.delete(id);
      }
    }
    return events;
  }

  // Where a descending fingertip will probably touch down at time t (straight-line guess,
  // at most 50 ms ahead), in image pixels.
  predict(f, t) {
    const n = f.hist.length;
    if (n < 2) return { x: f.x, y: f.y };
    const a = f.hist[n - 2], b = f.hist[n - 1];
    const dt = Math.max(1, b.t - a.t);
    const ahead = Math.min(50, Math.max(0, t - b.t + 15));
    const vy = Math.max(0, (b.py - a.py) / dt);
    return { x: b.px + ((b.px - a.px) / dt) * ahead * 0.5, y: b.py + vy * ahead };
  }

  // Fingers currently on their way down (likely about to land).
  descending() {
    return [...this.fingers.values()].filter((f) => f.descending && f.peak > this.o.downSpeed);
  }
}
