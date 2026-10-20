import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardLayout } from '../../src/layout.js';
import { fitHomography, applyH, invertH } from '../../src/homography.js';
import { paperLayout, paperToKey, markerCorners } from '../../src/paper.js';
import { noteName, parseNote } from '../../src/notes.js';

test('note names round-trip', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(parseNote('C4'), 60);
  assert.equal(parseNote('F#3'), 54);
  assert.equal(parseNote('Bb4'), 70);
});

test('keyboard layout: real key sizes and black/white by depth', () => {
  const kb = new KeyboardLayout(48, 84);
  assert.equal(kb.whiteCount, 22);
  assert.ok(Math.abs(kb.width - 22 * 23.5) < 1e-9);
  // C3 white key front part
  assert.equal(kb.keyAt(10, 130), 48);
  // boundary between C3 and D3, at the back → C#3
  assert.equal(kb.keyAt(23.5 - 2, 40), 49);
  // same x at the front → white
  assert.equal(kb.keyAt(23.5 - 2, 130), 48);
  // middle C: 7 white keys in
  assert.equal(kb.keyAt(7 * 23.5 + 10, 130), 60);
  assert.equal(kb.keyAt(-100, 50), null);
});

test('homography fit recovers a perspective map', () => {
  const H = [1.2, 0.1, 30, -0.05, 0.9, 50, 0.0004, 0.0002, 1];
  const src = [];
  for (let i = 0; i < 12; i++) src.push({ x: (i * 37) % 300, y: (i * 53) % 180 });
  const dst = src.map((p) => applyH(H, p.x, p.y));
  const F = fitHomography(src, dst);
  for (const p of src) {
    const a = applyH(F, p.x, p.y), b = applyH(H, p.x, p.y);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6);
  }
  const I = invertH(F);
  const back = applyH(I, dst[3].x, dst[3].y);
  assert.ok(Math.hypot(back.x - src[3].x, back.y - src[3].y) < 1e-6);
});

test('paper layouts: sheets fit A4, markers unique and away from joins', () => {
  for (const v of ['full', 'compact']) {
    const L = paperLayout(v);
    assert.ok(L.height <= 190, 'fits page height');
    assert.ok(L.pages.length >= 2);
    const ids = L.markers.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(L.markers.length >= 6);
    for (const p of L.pages.slice(1)) for (const m of L.markers) assert.ok(m.x + m.size < p.x0 || m.x > p.x0 + 15, `marker ${m.id} clear of overlap`);
    const corners = markerCorners(L);
    assert.equal(Object.keys(corners).length, L.markers.length);
  }
  const L = paperLayout('full');
  assert.equal(paperToKey(L, L.keysX + 7 * 23.5 + 10, L.keysY + 130), 60);
  assert.equal(paperToKey(L, L.keysX + 0.5, L.keysY + 140), 48);
  assert.equal(paperToKey(L, L.keysX + L.kb.width - 1, L.keysY + 140), 84);
});
