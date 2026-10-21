// Plain desk mode: no paper. Two calibration taps (middle C, then the C above) define where
// the keyboard is in the camera picture: a straight line along the keys and the octave width.
// Taps further from you (towards the camera = lower in the picture) are black keys.
// An optional third tap on the C above that (C6) corrects for perspective (keys further from the
// camera look narrower): positions along the line are then mapped with a 1-D projective curve.
import { KeyboardLayout } from './layout.js';

const kb = new KeyboardLayout(36, 96); // C2..C7 virtual keyboard
const OCT_MM = 7 * kb.whiteW;
const C4_X = (4 - 2) * OCT_MM + kb.whiteW / 2; // middle of the C4 key
const TAP_Y = 120; // a calibration tap is assumed to be on the white part of the key

export function deskKeyAt(cal, x, y) {
  if (!cal || !cal.c4 || !cal.c5) return null;
  const dx = cal.c5.x - cal.c4.x, dy = cal.c5.y - cal.c4.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1) return null;
  const px = x - cal.c4.x, py = y - cal.c4.y;
  let u = (px * dx + py * dy) / L2; // octaves to the right of middle C (in picture units)
  if (cal.c6) {
    // k(u) = (1+g)u / (1+g·u) passes through k(0)=0, k(1)=1 and k(u6)=2
    const u6 = ((cal.c6.x - cal.c4.x) * dx + (cal.c6.y - cal.c4.y) * dy) / L2;
    // only when the curve stays finite over the whole keyboard (C2–C7, u from −2 to +3)
    if (u6 > 1.6 && u6 < 3.3) {
      const g = (u6 - 2) / u6;
      const den = 1 + g * u;
      if (den > 0.05) u = ((1 + g) * u) / den;
    }
  }
  let nx = -dy, ny = dx;
  if (ny < 0) { nx = -nx; ny = -ny; } // normal pointing down the picture (towards the camera)
  const v = (px * nx + py * ny) / L2; // octaves towards the camera
  return kb.keyAt(C4_X + u * OCT_MM, TAP_Y - v * OCT_MM, 60);
}

// Where the invisible keys are, for drawing on the camera picture: white-key boundary lines (from
// the back to the front of the keys) and the position of each C, in the calibration's picture
// pixels. Same geometry as deskKeyAt.
export function deskKeyLines(cal, low = 48, high = 84) {
  if (!cal || !cal.c4 || !cal.c5) return null;
  const dx = cal.c5.x - cal.c4.x, dy = cal.c5.y - cal.c4.y;
  if (dx * dx + dy * dy < 1) return null;
  let nx = -dy, ny = dx;
  if (ny < 0) { nx = -nx; ny = -ny; }
  let g = 0;
  if (cal.c6) {
    const u6 = ((cal.c6.x - cal.c4.x) * dx + (cal.c6.y - cal.c4.y) * dy) / (dx * dx + dy * dy);
    if (u6 > 1.6 && u6 < 3.3) g = (u6 - 2) / u6;
  }
  const toU = (k) => k / ((1 + g) - g * k); // inverse of the perspective curve
  const at = (k, v) => { const u = toU(k); return { x: cal.c4.x + u * dx + v * nx, y: cal.c4.y + u * dy + v * ny }; };
  const vBack = TAP_Y / OCT_MM, vFront = (TAP_Y - kb.whiteLen) / OCT_MM;
  const lines = [], cs = [];
  const c4w = whiteIdx(60);
  for (let m = low; m <= high + 1; m++) {
    if (isBlackKey(m)) continue;
    const k = (whiteIdx(m) - c4w - 0.5) / 7; // left edge of this white key, in octaves from C4's centre
    lines.push([at(k, vBack), at(k, vFront)]);
    if (m % 12 === 0 && m <= high) cs.push({ midi: m, p: at((whiteIdx(m) - c4w) / 7, vFront * 0.5) });
  }
  return { lines, cs };
}
const whiteIdx = (m) => Math.floor(m / 12) * 7 + [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][m % 12];
const isBlackKey = (m) => [1, 3, 6, 8, 10].includes(m % 12);
