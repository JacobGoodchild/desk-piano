import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the drawn desk keyboard matches how taps are mapped', async () => {
  const { deskKeyAt, deskKeyLines } = await import('../../src/desk.js');
  for (const cal of [{ c4: { x: 400, y: 400 }, c5: { x: 750, y: 380 } }, { c4: { x: 400, y: 400 }, c5: { x: 700, y: 400 }, c6: { x: 950, y: 400 } }]) {
    const r = deskKeyLines(cal);
    for (const c of r.cs) assert.equal(deskKeyAt(cal, c.p.x, c.p.y), c.midi, JSON.stringify({ cal, c }));
  }
});
