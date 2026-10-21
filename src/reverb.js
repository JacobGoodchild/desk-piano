// A small, natural room reverb made in the browser: a stereo impulse response of decaying noise
// (with a little early-reflection pattern), fed alongside the untouched dry signal, so it adds
// no delay to the notes.
export function makeReverbBus(ctx, destination = ctx.destination) {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.buffer = roomImpulse(ctx, 2.2);
  input.connect(dry).connect(destination);
  input.connect(conv).connect(wet).connect(destination);
  let amount = 0.2, pedal = false;
  const apply = () => {
    const t = ctx.currentTime;
    // with the sustain pedal down every string is free to ring in sympathy: a little more resonance
    const a = Math.min(1, amount + (pedal ? 0.12 : 0));
    wet.gain.setTargetAtTime(a * 0.6, t, pedal ? 0.15 : 0.3);
    dry.gain.setTargetAtTime(1 - Math.min(1, amount) * 0.25, t, 0.05);
  };
  const bus = {
    input,
    setAmount(a) { amount = a; apply(); }, // 0..1
    setPedal(on) { if (on !== pedal) { pedal = on; apply(); } },
  };
  apply();
  return bus;
}

function roomImpulse(ctx, seconds) {
  const sr = ctx.sampleRate, n = Math.round(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // smooth onset (no click), then exponential decay; high frequencies die faster (approximated
      // by averaging neighbouring noise samples more as time goes on)
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 3.2);
      d[i] = rnd() * env;
    }
    // simple progressive low-pass: later parts get darker
    let prev = 0;
    for (let i = 0; i < n; i++) { const k = 0.25 + 0.7 * Math.min(1, i / n * 2); prev = prev + (d[i] - prev) * (1 - k * 0.9); d[i] = prev; }
    // a few early reflections
    for (const [ms, g] of [[11, 0.5], [17, 0.35], [23, 0.3], [31, 0.25], [41, 0.2]]) {
      const i = Math.round((ms + ch * 1.7) / 1000 * sr);
      if (i < n) d[i] += g;
    }
  }
  return buf;
}
