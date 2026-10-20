// AudioWorklet: runs the onset detector on the microphone input with ~3 ms of delay.
// Nothing is recorded or stored; samples are analysed and dropped.
import { OnsetDetector } from './onset.js';

class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.det = new OnsetDetector(sampleRate);
    this.frames = 0;
    this.port.onmessage = (e) => { if (e.data.type === 'options') this.det.setOptions(e.data.options); };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const startSample = this.det.pos;
    const blockTime = currentTime; // context time of the first sample of this block
    const onsets = this.det.process(ch);
    for (const o of onsets) {
      this.port.postMessage({ type: 'onset', time: blockTime + (o.sample - startSample) / sampleRate, peak: o.peak, floor: o.floor, now: currentTime + ch.length / sampleRate });
    }
    if (++this.frames % 8 === 0) this.port.postMessage({ type: 'level', level: this.det.takeLevel() });
    return true;
  }
}
registerProcessor('tap-detector', TapProcessor);
