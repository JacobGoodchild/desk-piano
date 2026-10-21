import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUNES, TuneFollower } from '../../src/tunes.js';

test('every tune parses to valid notes', () => {
  for (const t of TUNES) assert.ok(t.notes.length > 5 && t.notes.every((n) => Number.isInteger(n) && n >= 48 && n <= 84), t.name);
});

test('tune follower: right notes advance, wrong ones are counted, restart when done', () => {
  const f = new TuneFollower({ name: 'x', notes: [60, 62, 64] });
  assert.equal(f.next, 60);
  f.play(60); f.play(65); f.play(62);
  assert.equal(f.next, 64);
  assert.equal(f.wrong, 1);
  f.play(64);
  assert.ok(f.done);
  assert.match(f.progress(), /Done/);
  f.play(60);
  assert.equal(f.next, 62);
  assert.equal(f.wrong, 0);
});

test('tune follower shows the notes after the next one', () => {
  const f = new TuneFollower({ name: 'x', notes: [60, 62, 64, 65] });
  assert.deepEqual(f.ahead(2), [62, 64]);
  f.play(60); f.play(62); f.play(64);
  assert.deepEqual(f.ahead(2), []);
});
