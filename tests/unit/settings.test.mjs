import test from 'node:test';
import assert from 'node:assert/strict';

test('old saved settings get the new tuned defaults but keep personal choices', async () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  store['deskPiano.settings.v1'] = JSON.stringify({ sensitivity: 0.5, camera: 'abc', mirror: false, volume: 1 });
  const { loadSettings, DEFAULTS } = await import('../../src/settings.js');
  const s = loadSettings();
  assert.equal(s.sensitivity, DEFAULTS.sensitivity);
  assert.equal(s.volume, DEFAULTS.volume);
  assert.equal(s.camera, 'abc');
  assert.equal(s.mirror, false);
  assert.equal(s.version, 2);
  delete globalThis.localStorage;
});
