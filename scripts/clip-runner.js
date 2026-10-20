// Runs in headless Chromium for scripts/clip-test.mjs: hand tracking + paper marker detection on
// a list of frame images. Returns only numbers to the Node script; nothing is saved.
import { HandLandmarker } from '@mediapipe/tasks-vision';
import { detectMarkers, toGrey } from '../src/markers.js';

let landmarker = null;
const conf = Number(new URLSearchParams(location.search).get('conf') || 0.5);
async function init() {
  if (landmarker) return;
  const fileset = {
    wasmLoaderPath: new URL('../vendor/mediapipe/wasm/vision_wasm_internal.js', import.meta.url).href,
    wasmBinaryPath: new URL('../vendor/mediapipe/wasm/vision_wasm_internal.wasm', import.meta.url).href,
  };
  landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('../vendor/models/hand_landmarker.task', import.meta.url).href, delegate: 'CPU' },
    runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: conf, minHandPresenceConfidence: conf, minTrackingConfidence: conf,
  });
}

const canvas = document.createElement('canvas');
let mpClock = 0; // MediaPipe needs strictly increasing timestamps across batches and clips
window.analyseFrames = async (urls, fps, markerEvery = 3) => {
  await init();
  const out = [];
  for (let i = 0; i < urls.length; i++) {
    const img = new Image();
    img.src = urls[i];
    await img.decode();
    const t = (i * 1000) / fps;
    const w = img.naturalWidth, h = img.naturalHeight;
    mpClock += 1000 / fps;
    const res = landmarker.detectForVideo(img, mpClock);
    const hands = (res.landmarks || []).map((lm, k) => ({
      points: lm.map((p) => ({ x: p.x * w, y: p.y * h, z: p.z * w })),
      world: (res.worldLandmarks && res.worldLandmarks[k] || []).map((p) => ({ x: p.x, y: p.y, z: p.z })), // metres, hand-centred 3D
    }));
    let markers = null;
    if (i % markerEvery === 0) {
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      markers = detectMarkers(toGrey(g.getImageData(0, 0, w, h).data, w, h), w, h);
    }
    out.push({ t, w, h, hands, markers });
  }
  return out;
};
window.runnerReady = true;
