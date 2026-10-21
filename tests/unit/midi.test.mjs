import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../../src/midi.js';

test('recorder writes a valid standard MIDI file', () => {
  const r = new Recorder();
  const events = [{ t: 0, type: 'on', a: 60, b: 0.8 }, { t: 500, type: 'off', a: 60 }, { t: 500, type: 'pedal', a: true }, { t: 1000, type: 'on', a: 64, b: 0.5 }];
  const f = r.toMidiFile(events);
  assert.equal(String.fromCharCode(...f.slice(0, 4)), 'MThd');
  assert.equal(String.fromCharCode(...f.slice(14, 18)), 'MTrk');
  const len = (f[18] << 24) | (f[19] << 16) | (f[20] << 8) | f[21];
  assert.equal(len, f.length - 22);
  // first note-on: delta 0, 0x90 60 velocity ~102
  const i = 22 + 7; // after tempo meta event
  assert.deepEqual([...f.slice(i, i + 4)], [0, 0x90, 60, 102]);
  // the end-of-track marker
  assert.deepEqual([...f.slice(-3)], [0xff, 0x2f, 0x00]);
});

test('stopping a recording mid-note closes held notes and the pedal', () => {
  const r = new Recorder();
  r.start();
  r.add('on', 60, 0.5); r.add('on', 64, 0.5); r.add('off', 64); r.add('pedal', true);
  const ev = r.stop();
  const tail = ev.slice(4);
  assert.deepEqual(tail.map((e) => [e.type, e.a]), [['off', 60], ['pedal', false]]);
});

test('a MIDI sustain pedal (controller 64) on any input works the pedal', async () => {
  const { MidiOut } = await import('../../src/midi.js');
  const m = new MidiOut();
  const seen = [];
  m.onPedal = (on) => seen.push(on);
  m._in([0xb0, 64, 127]); m._in([0xb3, 64, 0]); m._in([0xb0, 7, 100]); m._in([0x90, 60, 100]);
  assert.deepEqual(seen, [true, false]);
});
