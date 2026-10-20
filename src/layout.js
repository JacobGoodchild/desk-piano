// Physical piano keyboard geometry in millimetres.
// Keyboard coordinates: x runs left→right from the left edge of the lowest white key,
// y runs from the BACK edge of the keys (y = 0, far from the player) to the FRONT edge
// (y = whiteLen, nearest the player).
import { isBlack, whiteIndex, whiteToMidi } from './notes.js';

export const REAL_KEYS = { whiteW: 23.5, whiteLen: 150, blackW: 13.7, blackLen: 95 };

// Black-key centre offsets (in white-key widths) from the boundary between the two white
// keys either side, roughly as on a real piano (C# and D# lean apart, F#/G#/A# spread out).
const BLACK_SHIFT = { 1: -0.1, 3: 0.1, 6: -0.13, 8: 0, 10: 0.13 };

export class KeyboardLayout {
  constructor(lowMidi, highMidi, dims = REAL_KEYS) {
    this.lowMidi = lowMidi;
    this.highMidi = highMidi;
    Object.assign(this, dims);
    this.lowWhite = whiteIndex(lowMidi);
    this.whiteCount = whiteIndex(highMidi) - this.lowWhite + 1;
    this.width = this.whiteCount * this.whiteW;
    this.keys = [];
    for (let m = lowMidi; m <= highMidi; m++) this.keys.push(this.keyRect(m));
  }

  keyRect(midi) {
    if (!isBlack(midi)) {
      const x0 = (whiteIndex(midi) - this.lowWhite) * this.whiteW;
      return { midi, black: false, x0, x1: x0 + this.whiteW, y0: 0, y1: this.whiteLen };
    }
    const boundary = (whiteIndex(midi) - this.lowWhite + 1) * this.whiteW;
    const cx = boundary + BLACK_SHIFT[midi % 12] * this.whiteW;
    return { midi, black: true, x0: cx - this.blackW / 2, x1: cx + this.blackW / 2, y0: 0, y1: this.blackLen };
  }

  // Centre of the playing area of a key (where a finger would naturally land).
  keyCentre(midi) {
    const r = this.keyRect(midi);
    if (r.black) return { x: (r.x0 + r.x1) / 2, y: r.blackLen ? r.y1 * 0.6 : r.y1 * 0.6 };
    return { x: (r.x0 + r.x1) / 2, y: this.blackLen + (this.whiteLen - this.blackLen) * 0.5 };
  }

  // Which key is at (x, y)? Allows a little slack beyond the printed edges.
  keyAt(x, y, slack = 12) {
    if (y < -slack || y > this.whiteLen + slack * 2) return null;
    if (x < -slack || x > this.width + slack) return null;
    const xc = Math.min(Math.max(x, 0), this.width - 0.01);
    if (y < this.blackLen) {
      for (const k of this.keys) if (k.black && xc >= k.x0 && xc < k.x1) return k.midi;
    }
    const wi = Math.floor(xc / this.whiteW) + this.lowWhite;
    return whiteToMidi(wi);
  }
}
