// Synthetic test data generators: rendered paper scenes, fake hand movements, fake tap sounds.
// No real camera or microphone data is ever used in tests.
import { markerGrid } from '../src/markers.js';
import { applyH, invertH } from '../src/homography.js';

// Render the paper's markers (and dark keys) into a grey image seen through homography H
// (paper mm → image px). Simple inverse mapping with 2×2 supersampling, plus noise.
export function renderPaperScene(layout, H, w, h, { noise = 6, bg = 90, seed = 1 } = {}) {
  const inv = invertH(H);
  const img = new Uint8Array(w * h);
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const cells = layout.markers.map((m) => ({ m, g: markerGrid(m.id) }));
  const valueAt = (x, y) => {
    if (x < 0 || y < 0 || x > layout.width || y > layout.height) return bg;
    for (const { m, g } of cells) {
      if (x >= m.x && x < m.x + m.size && y >= m.y && y < m.y + m.size) {
        const c = Math.floor(((x - m.x) / m.size) * 6), r = Math.floor(((y - m.y) / m.size) * 6);
        return g[r][c] ? 25 : 235;
      }
    }
    const kx = x - layout.keysX, ky = y - layout.keysY;
    if (ky >= 0 && ky < layout.kb.blackLen) for (const k of layout.kb.keys) if (k.black && kx >= k.x0 && kx < k.x1) return 25;
    return 235;
  };
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    let sum = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const p = applyH(inv, px + ox, py + oy);
      sum += valueAt(p.x, p.y);
    }
    img[py * w + px] = Math.max(0, Math.min(255, sum / 4 + (rnd() - 0.5) * 2 * noise));
  }
  return img;
}

// A plausible camera view: paper seen from across the desk at ~45°, upside-down relative to
// the print (camera on the far side), filling most of a w×h frame.
export function sceneHomography(layout, w, h, { tilt = 0.35, rotate = 0.04, shift = 0 } = {}) {
  // corners of the paper in the image: back edge (y=0, near the camera) at the bottom, wider
  const L = layout;
  const cx = w / 2 + shift, near = w * 0.92, far = near * (1 - tilt);
  const yBack = h * 0.88, yFront = h * 0.3;
  const rot = (p) => ({ x: cx + (p.x - cx) * Math.cos(rotate) - (p.y - h / 2) * Math.sin(rotate), y: h / 2 + (p.x - cx) * Math.sin(rotate) + (p.y - h / 2) * Math.cos(rotate) });
  // camera on the far side → the paper's left end appears on the image's right
  const dst = [
    rot({ x: cx + near / 2, y: yBack }), // paper (0,0)
    rot({ x: cx - near / 2, y: yBack }), // paper (W,0)
    rot({ x: cx - far / 2, y: yFront }), // paper (W,H)
    rot({ x: cx + far / 2, y: yFront }), // paper (0,H)
  ];
  const src = [{ x: 0, y: 0 }, { x: L.width, y: 0 }, { x: L.width, y: L.height }, { x: 0, y: L.height }];
  return { src, dst };
}

// Fake hand: 21 points. The fingertip `tip` is placed at (x, y) in image px plus a lift
// (in px, upwards in the image) for each finger given in `lift` {tip: px}.
export function fakeHand(label, base, lifts = {}, size = 90) {
  const pts = [];
  for (let i = 0; i < 21; i++) pts.push({ x: base.x, y: base.y });
  pts[0] = { x: base.x, y: base.y - size * 1.6 }; // wrist (towards the player = up the picture)
  pts[9] = { x: base.x, y: base.y - size * 0.6 }; // middle knuckle → size ≈ hand size
  const spread = size * 0.32;
  const tips = [4, 8, 12, 16, 20];
  tips.forEach((tip, i) => {
    const off = (label === 'Right' ? 1 : -1) * (i - 2) * spread;
    const t = { x: base.x + off, y: base.y - (lifts[tip] || 0) };
    pts[tip] = t;
    for (let j = 1; j <= 3; j++) pts[tip - j] = { x: t.x, y: base.y - size * 0.6 + j * 0 - (3 - j) * 0 }; // joints near knuckle line
  });
  return { label, points: pts };
}

// Fake tap sound: a short decaying noise burst ("tok"), amplitude `amp`.
export function tapSound(sr, amp, seed = 3) {
  const n = Math.round(sr * 0.04);
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const env = Math.min(1, i / (sr * 0.0005)) * Math.exp(-i / (sr * 0.006));
    out[i] = amp * env * ((s / 2147483647) * 2 - 1);
  }
  return out;
}

// Fake speech-ish sound: harmonic tone with slow amplitude modulation (should NOT be a tap).
export function speechSound(sr, amp, seconds = 1) {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t - Math.PI / 2);
    let v = 0;
    for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * 140 * k * t) / k;
    out[i] = amp * env * env * v * 0.4;
  }
  return out;
}
