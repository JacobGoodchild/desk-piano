import test from 'node:test';
import assert from 'node:assert/strict';
import { TapFusion } from '../../src/tap-fusion.js';
import { fakeHand } from '../synth.mjs';

// keys: 40 px columns from x=0 → midi 60 + column
function setup(resolverOpts = {}) {
  const played = [], stopped = [];
  const fusion = new TapFusion({
    keyFor: (p) => 60 + Math.floor(p.x / 40),
    play: (m, v, info) => played.push({ m, v, t: info.t }),
    stop: (m) => stopped.push(m),
    resolverOpts,
  });
  return { fusion, played, stopped };
}
function run(ctx, { to = 900, liftFn, taps = [], base = { x: 210, y: 300 }, wobble = 0 }) {
  const q = [...taps];
  for (let t = 0; t <= to; t += 33) {
    while (q.length && q[0].t <= t) ctx.fusion.onTap(q.shift());
    const lifts = liftFn(t);
    if (wobble) for (const k of Object.keys(lifts)) lifts[k] += wobble * Math.sin(t / 37 + Number(k));
    ctx.fusion.onFrame({ t, hands: [fakeHand('A', base, lifts)] });
    ctx.fusion.tick(t);
  }
  ctx.fusion.tick(to + 1000);
}
const press = (tips, at, hold = 200) => (t) => {
  const lifts = { 4: 30, 8: 30, 12: 30, 16: 30, 20: 30 };
  for (const tip of tips) {
    if (t >= at - 100 && t < at) lifts[tip] = 30 * ((at - t) / 100);
    else if (t >= at && t < at + hold) lifts[tip] = 0;
  }
  return lifts;
};

test('tap + one finger pressing plays that finger once, lifts end it', () => {
  const ctx = setup();
  run(ctx, { liftFn: press([8], 300), taps: [{ t: 300, velocity: 0.7 }] });
  assert.equal(ctx.played.length, 1, JSON.stringify(ctx.played));
  assert.equal(ctx.played[0].v, 0.7);
  assert.deepEqual(ctx.stopped, [ctx.played[0].m]);
});

test('tap while the hand hovers still (or wobbles a little) plays nothing', () => {
  const ctx = setup();
  run(ctx, { liftFn: () => ({ 4: 30, 8: 30, 12: 30, 16: 30, 20: 30 }), taps: [{ t: 300, velocity: 0.7 }, { t: 600, velocity: 0.7 }], wobble: 2 });
  assert.equal(ctx.played.length, 0);
});

test('tap while the whole hand moves down together plays at most one note', () => {
  const ctx = setup();
  const all = (t) => { const v = t < 200 ? 30 : t < 300 ? 30 * (300 - t) / 100 : 0; return { 4: v, 8: v, 12: v, 16: v, 20: v }; };
  run(ctx, { liftFn: all, taps: [{ t: 300, velocity: 0.7 }] });
  assert.ok(ctx.played.length <= 1, JSON.stringify(ctx.played));
});

test('chords when allowed: three fingers pressing together', () => {
  const ctx = setup({ chordRatio: 0.9 });
  run(ctx, { liftFn: press([4, 12, 20], 300), taps: [{ t: 300, velocity: 0.6 }] });
  assert.equal(new Set(ctx.played.map((p) => p.m)).size, 3, JSON.stringify(ctx.played));
});

test('a melody of single notes, each tap played once in order', () => {
  const ctx = setup();
  const fingers = [4, 8, 12, 16, 20, 16, 12, 8];
  const liftFn = (t) => {
    const l = { 4: 30, 8: 30, 12: 30, 16: 30, 20: 30 };
    fingers.forEach((tip, i) => { l[tip] = Math.min(l[tip], press([tip], 300 + i * 200, 120)(t)[tip]); });
    return l;
  };
  run(ctx, { to: 300 + fingers.length * 200 + 300, liftFn, taps: fingers.map((_, i) => ({ t: 300 + i * 200, velocity: 0.6 })) });
  const cols = fingers.map((tip) => 60 + Math.floor((210 - (tip / 4 - 1 - 2) * 90 * 0.32) / 40)); // hand 'A': thumb on the right
  assert.deepEqual(ctx.played.map((p) => p.m), cols, JSON.stringify(ctx.played));
});

test('two hands: only the hand that pressed plays (the other wobbles slightly)', () => {
  const ctx = setup();
  for (let t = 0; t <= 800; t += 33) {
    if (t === 297) ctx.fusion.onTap({ t: 300, velocity: 0.6 });
    const still = { 4: 30, 8: 30, 12: 30, 16: 30, 20: 30 };
    for (const k of Object.keys(still)) still[k] += 3 * Math.sin(t / 29 + Number(k)); // a restless resting hand
    ctx.fusion.onFrame({ t, hands: [fakeHand('A', { x: 210, y: 300 }, press([8], 300)(t)), fakeHand('B', { x: 600, y: 300 }, still)] });
    ctx.fusion.tick(t);
  }
  assert.equal(ctx.played.length, 1, JSON.stringify(ctx.played));
});

test('teaching: a ring finger that is dragged along further than the middle finger', async () => {
  const { FingerTeacher } = await import('../../src/tap-resolver.js');
  // this player's ring finger (16) moves 1.3× as far as the middle finger (12) whenever the middle
  // finger presses; pressing with the ring finger itself moves it 1.6× with the middle barely
  const coupled = (tip, at) => (t) => {
    const l = { 4: 30, 8: 30, 12: 30, 16: 30, 20: 30 };
    const k = t >= at - 100 && t < at ? (at - t) / 100 : t >= at && t < at + 200 ? 0 : 1;
    if (tip === 12) { l[12] = 30 * k; l[16] = 30 - 30 * 1.3 * (1 - k); }
    else if (tip === 16) { l[16] = 30 - 30 * 1.6 * (1 - k); l[12] = 30 - 30 * 0.3 * (1 - k); }
    else l[tip] = 30 * k;
    return l;
  };
  const runOne = (ctx, tip, teachFn) => {
    for (let t = 0; t <= 700; t += 33) {
      if (t === 297) ctx.fusion.onTap({ t: 300, velocity: 0.6 });
      ctx.fusion.onFrame({ t, hands: [fakeHand('A', { x: 210, y: 300 }, coupled(tip, 300)(t))] });
      if (teachFn && t >= 380 && !teachFn.done) { teachFn.done = true; teachFn(ctx.fusion.resolver.pattern(300)); }
    }
  };
  // untaught: pressing with the middle finger plays the ring finger's key
  const plain = setup();
  runOne(plain, 12);
  const ringKey = 60 + Math.floor((210 - (16 / 4 - 1 - 2) * 90 * 0.32) / 40);
  const midKey = 60 + Math.floor((210 - (12 / 4 - 1 - 2) * 90 * 0.32) / 40);
  assert.equal(plain.played[0].m, ringKey);
  // teach: each finger three times
  const teacher = new FingerTeacher();
  for (const tip of [4, 8, 12, 16, 20]) for (let i = 0; i < 3; i++) {
    const ctx = setup();
    runOne(ctx, tip, (vec) => teacher.add(tip, vec));
  }
  const taught = setup();
  taught.fusion.resolver.templates = teacher.templates();
  runOne(taught, 12);
  assert.equal(taught.played[0].m, midKey, JSON.stringify(taught.played));
  const taught2 = setup();
  taught2.fusion.resolver.templates = teacher.templates();
  runOne(taught2, 16);
  assert.equal(taught2.played[0].m, ringKey);
});

test('a note stops when its finger slides sideways off the key', () => {
  const ctx = setup();
  for (let t = 0; t <= 900; t += 33) {
    if (t === 297) ctx.fusion.onTap({ t: 300, velocity: 0.6 });
    const shift = t > 500 ? Math.min(60, (t - 500) * 0.5) : 0; // whole hand slides right after 0.5 s
    ctx.fusion.onFrame({ t, hands: [fakeHand('A', { x: 210 + shift, y: 300 }, press([8], 300, 2000)(t))] });
  }
  assert.equal(ctx.played.length, 1);
  assert.equal(ctx.stopped.length, 1, 'stopped after sliding');
});

test('edge cases: hand vanishes mid-note → note stops', () => {
  const ctx = setup();
  for (let t = 0; t <= 900; t += 33) {
    if (t === 297) ctx.fusion.onTap({ t: 300, velocity: 0.6 });
    const hands = t < 600 ? [fakeHand('A', { x: 210, y: 300 }, press([8], 300, 2000)(t))] : [];
    ctx.fusion.onFrame({ t, hands });
  }
  assert.equal(ctx.played.length, 1);
  assert.equal(ctx.stopped.length, 1);
});

test('edge cases: a finger resting down for ages is released after the safety time', () => {
  const ctx = setup();
  for (let t = 0; t <= 5000; t += 33) {
    if (t === 297) ctx.fusion.onTap({ t: 300, velocity: 0.6 });
    ctx.fusion.onFrame({ t, hands: [fakeHand('A', { x: 210, y: 300 }, press([8], 300, 99999)(t))] });
  }
  assert.equal(ctx.stopped.length, 1);
});

test('edge cases: a tap whose camera frames never arrive is dropped, not played late', () => {
  const ctx = setup();
  for (let t = 0; t <= 297; t += 33) ctx.fusion.onFrame({ t, hands: [fakeHand('A', { x: 210, y: 300 }, press([8], 300)(t))] });
  ctx.fusion.onTap({ t: 300, velocity: 0.6 });
  ctx.fusion.tick(700); // camera stalled
  for (let t = 700; t <= 1000; t += 33) ctx.fusion.onFrame({ t, hands: [fakeHand('A', { x: 210, y: 300 }, press([8], 300)(t))] });
  assert.equal(ctx.played.length, 0);
  assert.equal(ctx.fusion.stats.tapsRejected, 1);
});

test('edge cases: no hands at all → taps rejected, nothing played', () => {
  const ctx = setup();
  for (let t = 0; t <= 600; t += 33) {
    if (t === 297) ctx.fusion.onTap({ t: 300, velocity: 0.6 });
    ctx.fusion.onFrame({ t, hands: [] });
  }
  ctx.fusion.tick(2000);
  assert.equal(ctx.played.length, 0);
});
