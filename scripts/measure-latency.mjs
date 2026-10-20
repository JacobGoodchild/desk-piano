// Measures the software part of the tap → sound delay in headless Chromium, using a FAKE
// microphone that plays synthetic taps (generated here, written to the system temp folder).
// Reports: detection + message delay, and the browser's reported audio output latency.
import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../tests/server.mjs';
import { tapSound } from '../tests/synth.mjs';

const sr = 48000, secs = 6;
const pcm = new Int16Array(sr * secs);
for (let t = 0.5; t < secs - 0.2; t += 0.4) { const s = tapSound(sr, 0.3); for (let i = 0; i < s.length; i++) pcm[Math.round(t * sr) + i] = Math.round(s[i] * 32767); }
const dir = mkdtempSync(join(tmpdir(), 'dp-lat-'));
const wav = join(dir, 'taps.wav');
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write('WAVE', 8); header.write('fmt ', 12);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sr, 24);
header.writeUInt32LE(sr * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.byteLength, 40);
writeFileSync(wav, Buffer.concat([header, Buffer.from(pcm.buffer)]));

const { url, close } = await startServer();
const browser = await chromium.launch({ args: ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto(url + 'index.html?sim=1');
await page.click('#start');
await page.waitForFunction(() => window.deskPiano.state.tapMsgDelays.length >= 8, null, { timeout: 30000 });
const r = await page.evaluate(() => {
  const s = window.deskPiano.state;
  const d = [...s.tapMsgDelays].sort((a, b) => a - b);
  return { taps: d.length, median: d[d.length >> 1], max: d[d.length - 1], base: s.ctx.baseLatency * 1000, output: s.ctx.outputLatency * 1000, input: s.inputLatencyMs };
});
console.log(`taps heard: ${r.taps}`);
console.log(`tap detected → main thread: median ${r.median.toFixed(1)} ms, max ${r.max.toFixed(1)} ms (includes the 3 ms loudness window and one 128-sample block)`);
console.log(`browser-reported audio: base ${r.base.toFixed(1)} ms, output ${r.output.toFixed(1)} ms, input ${r.input.toFixed(1)} ms`);
console.log(`estimated tap → sound (when the finger is already seen descending): ~${(r.median + r.base + r.output + r.input).toFixed(0)} ms`);
await browser.close();
await close();
rmSync(dir, { recursive: true, force: true });
