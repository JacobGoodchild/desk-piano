// Settings, saved in localStorage when available (wrapped in try/catch: private mode etc.).
const KEY = 'deskPiano.settings.v1';
export const DEFAULTS = {
  mode: 'paper', paperSize: 'full', octave: 0, transpose: 0, sensitivity: 0.65,
  output: 'headphones', pedalAlways: false, showCamera: true, showRoll: true, mirror: true, debug: false, camera: '', mic: '', volume: 1.2, instrument: 'piano', bpm: 90, beatsPerBar: 4, dynamics: 'taps', fixedVelocity: 0.7, fingerTemplates: null, midiOut: '', reverb: 0.2, cameraOnly: false, engine: 'tap', response: 'accurate', chords: false,
  desk: null, // plain-desk calibration { c4: {x,y}, c5: {x,y}, w, h }
};
// Bump when tuned defaults change; the listed keys are then reset to the new defaults once, while
// personal choices (camera, microphone, volume, sound, calibration…) are kept.
const VERSION = 2;
const RETUNED = { 2: ['sensitivity', 'cameraOnly', 'volume'] };

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  for (let v = (saved.version || 1) + 1; v <= VERSION; v++) for (const k of RETUNED[v] || []) delete saved[k];
  return { ...DEFAULTS, ...saved, version: VERSION };
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
