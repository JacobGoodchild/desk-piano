// Plain desk mode: no paper. Two calibration taps (middle C, then the C above) define where
// the keyboard is in the camera picture: a straight line along the keys and the octave width.
// Taps further from you (towards the camera = lower in the picture) are black keys.
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
  const u = (px * dx + py * dy) / L2; // octaves to the right of middle C
  let nx = -dy, ny = dx;
  if (ny < 0) { nx = -nx; ny = -ny; } // normal pointing down the picture (towards the camera)
  const v = (px * nx + py * ny) / L2; // octaves towards the camera
  return kb.keyAt(C4_X + u * OCT_MM, TAP_Y - v * OCT_MM, 60);
}
