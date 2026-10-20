// Background worker: finds the paper's markers in a greyscale frame, off the main thread so hand
// tracking and sound never wait for it.
import { detectMarkers } from './markers.js';

self.onmessage = (e) => {
  const { id, grey, w, h } = e.data;
  const found = detectMarkers(new Uint8Array(grey), w, h);
  self.postMessage({ id, found });
};
