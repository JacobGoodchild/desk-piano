// Square fiducial markers: a 6×6 grid of cells, the outer ring black, the inner 4×4 cells
// carrying a 16-bit code. Codes are picked so that no two markers (in any rotation) are
// closer than MIN_DIST bits apart, and no marker looks like itself rotated.
import { fitHomography, applyH } from './homography.js';

const MIN_DIST = 5;
const COUNT = 32;

function rot(code) {
  // rotate a 4×4 bit grid 90° clockwise: new[r][c] = old[3-c][r]
  let out = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (code & (1 << ((3 - c) * 4 + r))) out |= 1 << (r * 4 + c);
  }
  return out;
}
function popcount(v) { let n = 0; while (v) { n += v & 1; v >>>= 1; } return n; }

function buildCodes() {
  const codes = [];
  for (let i = 0; i < 65536 && codes.length < COUNT; i++) {
    const c = (i * 40503 + 7919) & 0xffff; // odd multiplier → visits every 16-bit value once
    const ones = popcount(c);
    if (ones < 5 || ones > 11) continue;
    const r1 = rot(c), r2 = rot(r1), r3 = rot(r2);
    if (Math.min(popcount(c ^ r1), popcount(c ^ r2), popcount(c ^ r3)) < MIN_DIST) continue;
    let ok = true;
    for (const o of codes) {
      for (const r of [c, r1, r2, r3]) if (popcount(r ^ o) < MIN_DIST) { ok = false; break; }
      if (!ok) break;
    }
    if (ok) codes.push(c);
  }
  return codes;
}

export const MARKER_CODES = buildCodes();

// Cell grid for marker id: 6×6 array of 0 (white) / 1 (black).
export function markerGrid(id) {
  const code = MARKER_CODES[id];
  const g = [];
  for (let r = 0; r < 6; r++) {
    const row = [];
    for (let c = 0; c < 6; c++) {
      if (r === 0 || c === 0 || r === 5 || c === 5) row.push(1);
      else row.push(code & (1 << ((r - 1) * 4 + (c - 1))) ? 1 : 0);
    }
    g.push(row);
  }
  return g;
}

// SVG rectangles for a marker with top-left at (x, y) and side `size` (same units).
export function markerSVG(id, x, y, size) {
  // one black square, then the white cells on top (avoids hairline seams between cells)
  const cell = size / 6;
  const g = markerGrid(id);
  let s = `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="#000"/>`;
  for (let r = 1; r < 5; r++) for (let c = 1; c < 5; c++) {
    if (!g[r][c]) s += `<rect x="${(x + c * cell).toFixed(3)}" y="${(y + r * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}" fill="#fff"/>`;
  }
  return `<g>${s}</g>`;
}

// ---------------------------------------------------------------------------------------
// Detection. Input: grey Uint8Array (w×h). Output: [{id, corners:[{x,y}×4]}] where corners
// are in the marker's own order: top-left, top-right, bottom-right, bottom-left (as printed).

export function toGrey(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}

export function detectMarkers(grey, w, h, opts = {}) {
  const radius = opts.radius || Math.max(6, Math.round(Math.min(w, h) / 30));
  const C = opts.offset ?? 10;
  // integral image for the local mean
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += grey[y * w + x];
      integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const sum = integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      if (grey[y * w + x] < mean - C) dark[y * w + x] = 1;
    }
  }
  // connected components (4-neighbour flood fill), pixels stored contiguously in `queue`
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  const results = [];
  const minArea = opts.minArea || 40;
  const maxArea = w * h * 0.1;
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!dark[start] || label[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    label[start] = next;
    let minx = w, maxx = 0, miny = h, maxy = 0, sx = 0, sy = 0;
    while (head < tail) {
      const p = queue[head++];
      const px = p % w, py = (p / w) | 0;
      sx += px; sy += py;
      if (px < minx) minx = px; if (px > maxx) maxx = px;
      if (py < miny) miny = py; if (py > maxy) maxy = py;
      if (px > 0 && dark[p - 1] && !label[p - 1]) { label[p - 1] = next; queue[tail++] = p - 1; }
      if (px < w - 1 && dark[p + 1] && !label[p + 1]) { label[p + 1] = next; queue[tail++] = p + 1; }
      if (py > 0 && dark[p - w] && !label[p - w]) { label[p - w] = next; queue[tail++] = p - w; }
      if (py < h - 1 && dark[p + w] && !label[p + w]) { label[p + w] = next; queue[tail++] = p + w; }
    }
    next++;
    const n = tail;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (n < minArea || n > maxArea || bw < 8 || bh < 8) continue;
    if (bw > bh * 4 || bh > bw * 4) continue;
    const quad = quadFromPixels(queue, n, w, sx / n, sy / n);
    if (!quad) continue;
    const area = polyArea(quad);
    if (area < minArea || n / area < 0.3 || n / area > 1.05) continue;
    const m = readMarker(grey, w, h, quad);
    if (m) results.push(m);
  }
  return results;
}

function polySigned(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], r = q[(i + 1) % q.length];
    a += p.x * r.y - r.x * p.y;
  }
  return a / 2;
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], r = q[(i + 1) % q.length];
    a += p.x * r.y - r.x * p.y;
  }
  return Math.abs(a) / 2;
}

function quadFromPixels(queue, n, w, cx, cy) {
  const pt = (i) => ({ x: queue[i] % w, y: (queue[i] / w) | 0 });
  let best = -1, p1 = null;
  for (let i = 0; i < n; i++) {
    const p = pt(i);
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d > best) { best = d; p1 = p; }
  }
  best = -1;
  let p2 = null;
  for (let i = 0; i < n; i++) {
    const p = pt(i);
    const d = (p.x - p1.x) ** 2 + (p.y - p1.y) ** 2;
    if (d > best) { best = d; p2 = p; }
  }
  let bestPos = 0, bestNeg = 0, p3 = null, p4 = null;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  for (let i = 0; i < n; i++) {
    const p = pt(i);
    const cr = dx * (p.y - p1.y) - dy * (p.x - p1.x);
    if (cr > bestPos) { bestPos = cr; p3 = p; }
    if (cr < bestNeg) { bestNeg = cr; p4 = p; }
  }
  if (!p3 || !p4) return null;
  let ordered = [p1, p3, p2, p4];
  if (polySigned(ordered) < 0) ordered = [p1, p4, p2, p3];
  // nudge corners outward by half a pixel (pixel centres → pixel edges)
  const q = ordered.map((p) => {
    const vx = p.x - cx, vy = p.y - cy, L = Math.hypot(vx, vy) || 1;
    return { x: p.x + 0.5 + (vx / L) * 0.7, y: p.y + 0.5 + (vy / L) * 0.7 };
  });
  return q;
}

function readMarker(grey, w, h, quad) {
  const unit = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }, { x: 0, y: 6 }];
  const H = fitHomography(unit, quad);
  if (!H) return null;
  const vals = [];
  let mn = 255, mx = 0;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    let s = 0, k = 0;
    for (const oy of [0.3, 0.5, 0.7]) for (const ox of [0.3, 0.5, 0.7]) {
      const p = applyH(H, c + ox, r + oy);
      const xi = Math.round(p.x), yi = Math.round(p.y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
      s += grey[yi * w + xi]; k++;
    }
    const v = s / k;
    vals.push(v);
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
  if (mx - mn < 30) return null;
  const thr = (mn + mx) / 2;
  let borderDark = 0, code = 0;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    const black = vals[r * 6 + c] < thr;
    if (r === 0 || c === 0 || r === 5 || c === 5) { if (black) borderDark++; }
    else if (black) code |= 1 << ((r - 1) * 4 + (c - 1));
  }
  if (borderDark < 19) return null;
  // try the four rotations; rotation k means the printed top-left is at quad[k]
  let rc = code;
  for (let k = 0; k < 4; k++) {
    for (let id = 0; id < MARKER_CODES.length; id++) {
      if (popcount(MARKER_CODES[id] ^ rc) <= 1) {
        const corners = [0, 1, 2, 3].map((i) => quad[(i + k) % 4]);
        return { id, corners };
      }
    }
    rc = rot(rc);
  }
  return null;
}
