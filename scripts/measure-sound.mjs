// Renders single notes and chords offline (no speakers needed) and prints their levels, to check
// the dynamic range from pp to ff and that big chords don't clip.
import { chromium } from 'playwright';
import { startServer } from '../tests/server.mjs';

const { url, close } = await startServer();
const b = await chromium.launch({ args: ['--no-proxy-server'] });
const p = await b.newPage();
await p.goto(url + 'index.html?sim=1');
const r = await p.evaluate(async () => {
  const { Piano } = await import('./src/piano.js');
  const out = {};
  for (const [name, notes, vel] of [['single pp', [60], 0.15], ['single mf', [60], 0.55], ['single ff', [60], 1], ['5-note mf chord', [48, 55, 60, 64, 67], 0.6], ['10-note ff chord', [36, 43, 48, 52, 55, 60, 64, 67, 72, 76], 1]]) {
    const ctx = new OfflineAudioContext(2, 48000 * 1.5, 48000);
    const piano = new Piano(ctx, ctx.destination);
    await piano.load('samples/piano/');
    for (const n of notes) piano.noteOn(n, vel, 0);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0;
    for (let i = 0; i < d.length; i++) { peak = Math.max(peak, Math.abs(d[i])); sum += d[i] * d[i]; }
    out[name] = `peak ${peak.toFixed(3)}, rms ${(10 * Math.log10(sum / d.length)).toFixed(1)} dB`;
  }
  return out;
});
console.log(r);
await b.close();
await close();
