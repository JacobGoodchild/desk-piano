import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paperLayout, markerCorners, detectPaperSize } from '../../src/paper.js';
import { fitHomography, applyH } from '../../src/homography.js';
import { sceneHomography } from '../synth.mjs';

// the markers a camera would see of this paper (synthetic view)
function seen(variant, ids, opts = { tilt: 0.35, rotate: 0.05 }) {
  const L = paperLayout(variant);
  const sc = sceneHomography(L, 1280, 720, opts);
  const H = fitHomography(sc.src, sc.dst);
  const known = markerCorners(L);
  return L.markers.filter((m) => !ids || ids.includes(m.id)).map((m) => ({ id: m.id, corners: known[m.id].map((p) => applyH(H, p.x, p.y)) }));
}

test('tells the full paper from the 2-octave paper by its markers', () => {
  assert.equal(detectPaperSize(seen('full')), 'full');
  assert.equal(detectPaperSize(seen('compact')), 'compact');
  // only some markers visible
  assert.equal(detectPaperSize(seen('full', [0, 1, 2, 3, 4, 8])), 'full');
  assert.equal(detectPaperSize(seen('compact', [0, 1, 2, 3, 4, 6])), 'compact');
  assert.equal(detectPaperSize(seen('compact', [1, 2, 3, 4, 5, 8, 9], { tilt: 0.5, rotate: -0.1 })), 'compact');
  assert.equal(detectPaperSize(seen('full', [1, 2, 3, 4, 5, 6, 7], { tilt: 0.5, rotate: -0.1 })), 'full');
  // too few markers to tell
  assert.equal(detectPaperSize(seen('compact', [0, 1, 2])), null);
});
