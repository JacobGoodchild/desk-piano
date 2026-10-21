import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTune, alignCorrect } from '../../src/auto-tune.js';
import { RESOLVER_DEFAULTS } from '../../src/tap-resolver.js';

test('alignCorrect counts notes matched in order', () => {
  assert.equal(alignCorrect([60, 62, 64], [60, 64]), 2);
  assert.equal(alignCorrect([60, 62, 64], [61, 60, 62, 64, 65]), 3);
  assert.equal(alignCorrect([60], []), 0);
});

// One synthetic hand (tips 50 px apart, hand ~100 px). This player's pressing finger does most of
// its travel early and only creeps down in the last 100 ms before the tap — below the default
// "still moving down" gate (minLate 0.04 hand-widths), so the defaults miss every note.
function session(presses) {
  const frames = [], taps = [];
  const tips = [4, 8, 12, 16, 20];
  let t = 1000;
  for (const finger of presses) {
    const tapT = t + 300;
    for (let ft = t; ft <= tapT + 200; ft += 33) {
      const P = Array.from({ length: 21 }, () => ({ x: 100, y: 200, z: 0 }));
      P[0] = { x: 100, y: 300, z: 0 }; P[5] = { x: 50, y: 200, z: 0 }; P[9] = { x: 100, y: 200, z: 0 }; P[17] = { x: 175, y: 200, z: 0 };
      tips.forEach((tip, i) => {
        let y = 380;
        if (tip === finger) {
          const dt = ft - tapT; // ms relative to the tap
          y = dt < -250 ? 360 : dt < -100 ? 360 + (20 * (dt + 250)) / 150 : dt < 0 ? 380 + (3 * (dt + 100)) / 100 : 383;
        }
        P[tip] = { x: i * 50, y, z: 0 };
        P[tip - 1] = { x: i * 50, y: y - 20, z: 0 };
      });
      frames.push({ t: ft, hands: [{ label: 'R', points: P }] });
    }
    taps.push({ t: tapT, velocity: 0.6 });
    t = tapT + 400;
  }
  return { frames, taps };
}

test('auto-tune finds settings that fit this player, and leaves good settings alone', () => {
  const presses = [4, 8, 12, 16, 12, 8, 4];
  const keyOf = { 0: 60, 50: 62, 100: 64, 150: 65, 200: 67 };
  const expected = presses.map((tip) => keyOf[[4, 8, 12, 16, 20].indexOf(tip) * 50]);
  const { frames, taps } = session(presses);
  const keyFor = (p) => keyOf[Math.round(p.x)] ?? null;
  const r = autoTune({ frames, taps, expected, keyFor, base: { ...RESOLVER_DEFAULTS } });
  assert.ok(r.before < 3, `defaults should miss most notes here (got ${r.before})`);
  assert.ok(r.params, `a better setting was found: ${JSON.stringify(r)}`);
  assert.ok(r.after >= r.before + 2, JSON.stringify(r));
  // already-good settings: nothing changes
  const again = autoTune({ frames, taps, expected, keyFor, base: { ...RESOLVER_DEFAULTS, ...r.params } });
  assert.equal(again.params, null);
});
