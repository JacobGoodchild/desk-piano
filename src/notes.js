// Note naming helpers. MIDI 60 = C4 = middle C.
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);

export function isBlack(midi) {
  return BLACK.has(((midi % 12) + 12) % 12);
}

export function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function parseNote(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(name).trim());
  if (!m) return null;
  let pc = NOTE_NAMES.indexOf(m[1].toUpperCase());
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  return (Number(m[3]) + 1) * 12 + pc;
}

// Index of a white key counted from C-1 (so each octave has 7 white keys).
export function whiteIndex(midi) {
  const oct = Math.floor(midi / 12);
  const pc = midi - oct * 12;
  const map = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
  return oct * 7 + map[pc];
}

const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
export function whiteToMidi(wi) {
  const oct = Math.floor(wi / 7);
  return oct * 12 + WHITE_PCS[wi - oct * 7];
}
