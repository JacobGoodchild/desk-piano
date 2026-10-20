import test from 'node:test';
import assert from 'node:assert/strict';
import { StrikeDetector } from '../../src/strike.js';
import { Fusion } from '../../src/fusion.js';
import { fakeHand } from '../synth.mjs';

// A tiny simulated world: keys are 40 px wide columns starting at x=0 → midi 60 + column.
function setup(opts = {}) {
  const played = [], stopped = [];
  const det = new StrikeDetector();
  const fusion = new Fusion({
    keyFor: (p) => 60 + Math.floor(p.x / 40),
    play: (m, v, info) => played.push({ m, v, how: info.how, t: info.t }),
    stop: (m) => stopped.push(m),
    opts,
  });
  return { det, fusion, played, stopped };
}

// Run a timeline: each frame at 30 fps, `liftFn(t)` → lifts for the right hand {tip: px}.
function runFrames(ctx, { from = 0, to = 600, liftFn, taps = [], base = { x: 210, y: 300 } }) {
  const { det, fusion } = ctx;
  const tapQueue = [...taps];
  for (let t = from; t <= to; t += 33) {
    while (tapQueue.length && tapQueue[0].t <= t) fusion.onTap(tapQueue.shift(), det);
    const frame = { t, hands: [fakeHand('Right', base, liftFn(t))] };
    fusion.onStrikeEvents(det.update(frame), det);
    fusion.tick(t);
  }
  fusion.tick(to + 500);
}

// finger `tip` presses at time `at` (ms): up 30 px, comes down over 100 ms, stays down `hold` ms
const press = (tips, at, hold = 200) => (t) => {
  const lifts = {};
  for (const tip of [4, 8, 12, 16, 20]) lifts[tip] = 30;
  for (const tip of tips) {
    if (t < at - 100) lifts[tip] = 30;
    else if (t < at) lifts[tip] = 30 * ((at - t) / 100);
    else if (t < at + hold) lifts[tip] = 0;
    else lifts[tip] = 30;
  }
  return lifts;
};

test('tap + finger landing plays that finger\'s key, with tap loudness', () => {
  const ctx = setup();
  runFrames(ctx, { liftFn: press([8], 300), taps: [{ t: 300, velocity: 0.8 }] });
  assert.equal(ctx.played.length, 1, JSON.stringify(ctx.played));
  // finger 8 (index) of a right hand at base x=210 with spread → column of its x
  assert.equal(ctx.played[0].v, 0.8);
  assert.ok(ctx.stopped.includes(ctx.played[0].m), 'note stops when the finger lifts');
});

test('three fingers landing together with one tap = chord', () => {
  const ctx = setup();
  runFrames(ctx, { liftFn: press([4, 12, 20], 300), taps: [{ t: 305, velocity: 0.6 }] });
  assert.equal(ctx.played.length, 3, JSON.stringify(ctx.played));
  assert.equal(new Set(ctx.played.map((p) => p.m)).size, 3);
  assert.ok(ctx.played.every((p) => p.v === 0.6));
});

test('a tap with no finger moving (talking, knocks) plays nothing', () => {
  const ctx = setup();
  runFrames(ctx, { liftFn: () => ({ 4: 30, 8: 30, 12: 30, 16: 30, 20: 30 }), taps: [{ t: 200, velocity: 0.7 }, { t: 400, velocity: 0.9 }] });
  assert.equal(ctx.played.length, 0);
  assert.equal(ctx.fusion.stats.tapsRejected, 2);
});

test('by default, a finger strike with no tap plays nothing (hovering hands)', () => {
  const ctx = setup();
  runFrames(ctx, { liftFn: press([12], 300), taps: [] });
  assert.equal(ctx.played.length, 0);
});

test('with the camera-only option, a clear finger strike the microphone missed still plays, quieter', () => {
  const ctx = setup({ cameraOnly: true });
  runFrames(ctx, { liftFn: press([12], 300), taps: [] });
  assert.equal(ctx.played.length, 1);
  assert.equal(ctx.played[0].how, 'camera-only');
  assert.ok(ctx.played[0].v < 0.5);
});

test('speaker mode: the app\'s own echo right after a note does not add notes', () => {
  const ctx = setup();
  ctx.fusion.speakerMode = true;
  // real press at 300 with tap; echo "taps" at 340 and 420 with no new finger
  runFrames(ctx, { liftFn: press([8], 300, 400), taps: [{ t: 300, velocity: 0.7 }, { t: 340, velocity: 0.5 }, { t: 420, velocity: 0.5 }] });
  assert.equal(ctx.played.length, 1, JSON.stringify(ctx.played));
});

test('a sequence of notes (scale) at a moderate speed', () => {
  const ctx = setup();
  const fingers = [4, 8, 12, 16, 20];
  const liftFn = (t) => {
    const lifts = {};
    fingers.forEach((tip, i) => { lifts[tip] = press([tip], 300 + i * 250, 180)(t)[tip]; });
    return lifts;
  };
  runFrames(ctx, { to: 1800, liftFn, taps: fingers.map((_, i) => ({ t: 300 + i * 250, velocity: 0.5 + i * 0.1 })) });
  assert.equal(ctx.played.length, 5, JSON.stringify(ctx.played));
  const notes = ctx.played.map((p) => p.m);
  assert.deepEqual(notes, [...notes].sort((a, b) => a - b), 'ascending');
  assert.ok(ctx.played.every((p) => p.how !== 'camera-only'));
});

test('fast run: 10 notes per second, alternating fingers, all detected in order', () => {
  const ctx = setup();
  const fingers = [4, 8, 12, 16, 20, 16, 12, 8, 4, 8, 12, 16];
  const gap = 100;
  const liftFn = (t) => {
    const lifts = { 4: 30, 8: 30, 12: 30, 16: 30, 20: 30 };
    fingers.forEach((tip, i) => {
      const at = 300 + i * gap;
      // quick strike: down over 66 ms, held 60 ms, up again
      if (t >= at - 66 && t < at) lifts[tip] = Math.min(lifts[tip], 30 * ((at - t) / 66));
      else if (t >= at && t < at + 60) lifts[tip] = 0;
    });
    return lifts;
  };
  runFrames(ctx, { to: 300 + fingers.length * gap + 300, liftFn, taps: fingers.map((_, i) => ({ t: 300 + i * gap, velocity: 0.6 })) });
  const expected = fingers.map((tip) => 60 + Math.floor((210 + (tip / 4 - 1 - 2) * 90 * 0.32) / 40));
  assert.deepEqual(ctx.played.map((p) => p.m), expected, JSON.stringify(ctx.played));
});
