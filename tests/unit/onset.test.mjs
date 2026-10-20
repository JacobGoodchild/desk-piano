import test from 'node:test';
import assert from 'node:assert/strict';
import { OnsetDetector, peakToVelocity } from '../../src/onset.js';
import { tapSound, speechSound } from '../synth.mjs';

const SR = 48000;
function run(signal, opts) {
  const det = new OnsetDetector(SR, opts);
  const out = [];
  for (let i = 0; i < signal.length; i += 128) out.push(...det.process(signal.subarray(i, i + 128)));
  return out;
}
function place(total, items) {
  const s = new Float32Array(Math.round(total * SR));
  let noise = 7;
  for (let i = 0; i < s.length; i++) { noise = (noise * 16807) % 2147483647; s[i] = ((noise / 2147483647) - 0.5) * 0.002; }
  for (const { at, sound } of items) { const o = Math.round(at * SR); for (let i = 0; i < sound.length && o + i < s.length; i++) s[o + i] += sound[i]; }
  return s;
}

test('detects synthetic taps at the right time with ~ms delay', () => {
  const times = [0.2, 0.45, 0.6, 0.75, 1.1];
  const sig = place(1.4, times.map((at, i) => ({ at, sound: tapSound(SR, 0.2, i + 1) })));
  const on = run(sig);
  assert.equal(on.length, times.length);
  on.forEach((o, i) => {
    const err = (o.sample / SR - times[i]) * 1000;
    assert.ok(err >= -0.5 && err < 3, `onset ${i} error ${err.toFixed(2)} ms`);
  });
});

test('fast repeated notes (12 per second) are all detected', () => {
  const times = Array.from({ length: 12 }, (_, i) => 0.1 + i / 12);
  const on = run(place(1.3, times.map((at) => ({ at, sound: tapSound(SR, 0.15) }))));
  assert.equal(on.length, 12);
});

test('louder taps give higher velocity', () => {
  const amps = [0.01, 0.05, 0.2, 0.6];
  const on = run(place(1.5, amps.map((a, i) => ({ at: 0.4 + i * 0.25, sound: tapSound(SR, a) })))); // after the ~0.2 s settling
  assert.equal(on.length, 4);
  const v = on.map((o) => peakToVelocity(o.peak));
  for (let i = 1; i < v.length; i++) assert.ok(v[i] > v[i - 1], `velocity rises ${v.join(', ')}`);
  assert.ok(v[0] < 0.45 && v[3] > 0.8);
});

// The detector is tuned to catch soft taps through compressed far-away webcam audio, so it may
// fire once per syllable of speech: those are rejected later because no finger is coming down
// (see the fusion tests).
test('speech-like sound gives at most one onset per syllable', () => {
  const on = run(place(1.2, [{ at: 0.1, sound: speechSound(SR, 0.1, 1) }]));
  assert.ok(on.length <= 4, `got ${on.length}`); // 4 syllables
});

test('velocity mapper learns a quiet player\'s range', async () => {
  const { VelocityMapper } = await import('../../src/onset.js');
  const vm = new VelocityMapper(0.5);
  // a player whose taps are all quite soft (mic far away): peaks 0.002 .. 0.02
  for (let i = 0; i < 30; i++) vm.add(0.002 * Math.pow(10, (i % 10) / 9));
  const soft = vm.map(0.002), loud = vm.map(0.02);
  assert.ok(loud > 0.75, `their loudest tap is loud: ${loud}`);
  assert.ok(soft < 0.35, `their softest is soft: ${soft}`);
});
