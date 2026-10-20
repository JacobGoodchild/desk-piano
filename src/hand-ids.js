// Gives each tracked hand a stable id from frame to frame. MediaPipe's "Left"/"Right" label can
// flicker (and is mirrored for a camera facing the player), which would reset finger tracking
// and cut notes short, so we match hands by wrist position instead.
export class HandIds {
  constructor() { this.prev = []; } // [{id, x, y}]

  assign(hands) {
    const used = new Set();
    const out = hands.map((h) => ({ ...h }));
    // greedy nearest-wrist matching to the previous frame
    const pairs = [];
    out.forEach((h, i) => this.prev.forEach((p) => pairs.push({ i, id: p.id, d: Math.hypot(h.points[0].x - p.x, h.points[0].y - p.y) })));
    pairs.sort((a, b) => a.d - b.d);
    const done = new Set();
    for (const p of pairs) {
      if (done.has(p.i) || used.has(p.id)) continue;
      out[p.i].label = p.id; done.add(p.i); used.add(p.id);
    }
    // new hands: the one further left in the picture gets 'A' unless taken
    const order = out.map((h, i) => i).filter((i) => !done.has(i)).sort((a, b) => out[a].points[0].x - out[b].points[0].x);
    for (const i of order) {
      const id = ['A', 'B', 'C', 'D'].find((x) => !used.has(x));
      out[i].label = id; used.add(id);
    }
    this.prev = out.map((h) => ({ id: h.label, x: h.points[0].x, y: h.points[0].y }));
    return out;
  }
}
