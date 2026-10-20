// Practice metronome: clicks scheduled ahead on the audio clock, so the beat stays steady even if
// the page is busy. The first beat of each bar is higher.
export class Metronome {
  constructor(ctx, destination, onBeat) {
    this.ctx = ctx; this.dest = destination; this.onBeat = onBeat;
    this.bpm = 90; this.beats = 4; this.running = false; this.timer = null;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.next = this.ctx.currentTime + 0.1;
    this.beat = 0;
    const tick = () => {
      while (this.next < this.ctx.currentTime + 0.15) {
        this.click(this.next, this.beat % this.beats === 0);
        const when = this.next, b = this.beat % this.beats;
        setTimeout(() => this.onBeat && this.onBeat(b), Math.max(0, (when - this.ctx.currentTime) * 1000));
        this.next += 60 / this.bpm;
        this.beat++;
      }
    };
    tick();
    this.timer = setInterval(tick, 25);
  }
  stop() { this.running = false; clearInterval(this.timer); }
  click(t, accent) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.22, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    o.connect(g).connect(this.dest);
    o.start(t); o.stop(t + 0.06);
  }
}
