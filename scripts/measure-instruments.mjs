// Renders a C major chord (mf) with each instrument offline and prints the levels, to keep the
// sounds at similar loudness.
import { chromium } from 'playwright';
import { startServer } from '../tests/server.mjs';

const { url, close } = await startServer();
const b = await chromium.launch({ args: ['--no-proxy-server'] });
const p = await b.newPage();
await p.goto(url + 'index.html?sim=1');
const r = await p.evaluate(async () => {
  const { Piano } = await import('./src/piano.js');
  const { SYNTHS } = await import('./src/synths.js');
  const out = {};
  for (const id of ['piano', ...Object.keys(SYNTHS)]) {
    const ctx = new OfflineAudioContext(2, 48000 * 2, 48000);
    const inst = id === 'piano' ? new Piano(ctx, ctx.destination) : new SYNTHS[id](ctx, ctx.destination);
    if (id === 'piano') await inst.load('samples/piano/');
    for (const n of [60, 64, 67]) inst.noteOn(n, 0.6);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0;
    for (let i = 0; i < 48000; i++) { peak = Math.max(peak, Math.abs(d[i])); sum += d[i] * d[i]; }
    out[id] = `peak ${peak.toFixed(2)}, rms (first second) ${(10 * Math.log10(sum / 48000)).toFixed(1)} dB`;
  }
  return out;
});
console.log(r);
await b.close();
await close();
