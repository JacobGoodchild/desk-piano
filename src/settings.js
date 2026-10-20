// Settings, saved in localStorage when available (wrapped in try/catch: private mode etc.).
const KEY = 'deskPiano.settings.v1';
export const DEFAULTS = {
  mode: 'paper', paperSize: 'full', octave: 0, transpose: 0, sensitivity: 0.5,
  output: 'headphones', pedalAlways: false, showCamera: true, mirror: true, debug: false, camera: '',
  desk: null, // plain-desk calibration { c4: {x,y}, c5: {x,y}, w, h }
};
export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  return { ...DEFAULTS, ...saved };
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
