import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMarkers, MARKER_CODES } from '../../src/markers.js';
import { fitHomography, applyH } from '../../src/homography.js';
import { paperLayout, markerCorners, paperToKey } from '../../src/paper.js';
import { renderPaperScene, sceneHomography } from '../synth.mjs';

test('enough distinct marker codes', () => {
  assert.ok(MARKER_CODES.length >= 16);
});

for (const [name, opts] of [['straight-on', { tilt: 0.1, rotate: 0 }], ['45° from across the desk', { tilt: 0.35, rotate: 0.05 }], ['tilted and shifted', { tilt: 0.45, rotate: -0.12, shift: 20 }]]) {
  test(`finds the paper in a synthetic camera scene (${name}) and maps keys correctly`, () => {
    const L = paperLayout('full');
    const w = 960, h = 540;
    const { src, dst } = sceneHomography(L, w, h, opts);
    const Htrue = fitHomography(src, dst);
    const img = renderPaperScene(L, Htrue, w, h);
    const found = detectMarkers(img, w, h);
    const known = markerCorners(L);
    const ids = new Set(found.map((f) => f.id));
    assert.ok(ids.size >= L.markers.length - 2, `found ${ids.size} of ${L.markers.length} markers`);
    const s = [], d = [];
    for (const f of found) for (let i = 0; i < 4; i++) { s.push(known[f.id][i]); d.push(f.corners[i]); }
    const H = fitHomography(s, d);
    // every key centre projected by the true homography maps back to the same key
    let worst = 0;
    for (const k of L.kb.keys) {
      const px = L.keysX + (k.x0 + k.x1) / 2, py = L.keysY + (k.black ? 50 : 125);
      const img1 = applyH(Htrue, px, py), img2 = applyH(H, px, py);
      worst = Math.max(worst, Math.hypot(img1.x - img2.x, img1.y - img2.y));
      const inv = fitHomography(d, s);
      const back = applyH(inv, img1.x, img1.y);
      assert.equal(paperToKey(L, back.x, back.y), k.midi, `key ${k.midi}`);
    }
    assert.ok(worst < 4, `projection error ${worst.toFixed(2)} px`);
  });
}

test('no markers in an empty scene', () => {
  const w = 320, h = 240;
  const img = new Uint8Array(w * h);
  for (let i = 0; i < img.length; i++) img[i] = 100 + ((i * 7919) % 31);
  assert.equal(detectMarkers(img, w, h).length, 0);
});
