import test from 'node:test';
import assert from 'node:assert/strict';
import { HandIds } from '../../src/hand-ids.js';

const hand = (x, y = 100) => ({ points: Array.from({ length: 21 }, () => ({ x, y })) });

test('hand ids stay with the same hand even if the detector swaps their order', () => {
  const ids = new HandIds();
  const a = ids.assign([hand(100), hand(500)]);
  assert.deepEqual(a.map((h) => h.label), ['A', 'B']);
  const b = ids.assign([hand(505), hand(102)]); // order swapped, hands moved slightly
  assert.deepEqual(b.map((h) => h.label), ['B', 'A']);
  const c = ids.assign([hand(510)]); // one hand leaves
  assert.deepEqual(c.map((h) => h.label), ['B']);
  const d = ids.assign([hand(90), hand(512)]); // it comes back
  assert.deepEqual(d.map((h) => h.label), ['A', 'B']);
});
