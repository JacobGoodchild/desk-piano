// Desk Piano main app: wires camera → hand tracking → strikes, microphone → taps, and the
// fusion of the two → piano sound. Everything runs on this device; no audio or video is
// stored or sent anywhere.
import { Piano } from './piano.js';
import { SYNTHS, INSTRUMENTS } from './synths.js';
import { makeReverbBus } from './reverb.js';
import { MidiOut, Recorder } from './midi.js';
import { Metronome } from './metronome.js';
import { StrikeDetector } from './strike.js';
import { Fusion } from './fusion.js';
import { TapFusion } from './tap-fusion.js';
import { autoTune, alignCorrect, TUNE_GRID } from './auto-tune.js';
import { FingerTeacher } from './tap-resolver.js';
import { VelocityMapper } from './onset.js';
import { paperLayout, paperToKey, fitPaper, detectPaperSize, TIP_OFFSET_MM } from './paper.js';
import { detectMarkers, toGrey } from './markers.js';
import { applyH, invertH } from './homography.js';
import { deskKeyAt } from './desk.js';
import { loadSettings, saveSettings } from './settings.js';
import { noteName, isBlack, whiteIndex } from './notes.js';
import { HAND_CONNECTIONS } from './hand-connections.js';
import { HandIds } from './hand-ids.js';
import { TUNES, TuneFollower } from './tunes.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIM = params.has('sim'); // tests: hand frames are injected instead of coming from the camera
const settings = loadSettings();
if (params.get('debug') === '1') settings.debug = true;

const state = {
  ctx: null, piano: null, started: false,
  layout: paperLayout(settings.paperSize),
  paperH: null, paperInv: null, paperSeen: 0, markersSeen: new Set(),
  hands: [], handsT: 0,
  micLevel: 0, micHistory: [], tapMarks: [],
  spans: [], // note trail: { midi, start, end, vel }
  latencies: [], lastLatency: null, tapMsgDelays: [], frameTimes: [], trackMs: 0,
  played: [], // log for tests/debug: {midi, vel, how, t}
  active: new Map(), // midi → count of sources holding it (for the on-screen keyboard)
  pedalKey: false, pedalButton: false,
  calib: null, // plain desk calibration step: 'c4' | 'c5' | null
  kbdOctave: 0,
  video: { w: 0, h: 0 },
};

const midiOut = new MidiOut();
const recorder = new Recorder();
const strikes = new StrikeDetector();
const velocityMap = new VelocityMapper(settings.sensitivity);
const handlers = {
  keyFor: (f) => keyForPoint(f.x, f.y),
  play: (midi, vel, info) => noteOn(midi, vel, info),
  stop: (midi) => noteOff(midi),
};
// Two note engines: 'tap' (default; tap-first, tuned on real clips) and 'classic' (landing-based,
// can also play strikes without a tap).
const engines = { tap: new TapFusion(handlers), classic: new Fusion(handlers) };
let fusion = engines[settings.engine] || engines.tap;
engines.tap.resolver.templates = settings.fingerTemplates || null;
const baseResolver = { ...engines.tap.resolver.o }; // defaults, before any personal tuning

// ---------------------------------------------------------------- keys & notes
function shiftNote(m) { return m == null ? null : m + settings.transpose + settings.octave * 12; }

function keyForPoint(x, y) {
  if (settings.mode === 'desk') {
    // calibration points are in the camera picture's pixels at the time: rescale if the picture
    // size changed (e.g. another camera resolution); a rotated picture needs a new calibration
    const cal = settings.desk, vw = state.video.w, vh = state.video.h;
    if (cal && cal.w && vw && (cal.w !== vw || cal.h !== vh)) {
      if ((cal.w > cal.h) !== (vw > vh)) return null;
      x *= cal.w / vw; y *= cal.h / vh;
    }
    return shiftNote(deskKeyAt(cal, x, y));
  }
  if (!state.paperInv) return null;
  const p = applyH(state.paperInv, x, y);
  return shiftNote(paperToKey(state.layout, p.x, p.y, TIP_OFFSET_MM));
}

function pedalDown() { return settings.pedalAlways || state.pedalKey || state.pedalButton; }
function updatePedal() {
  const on = pedalDown();
  $('pedal').setAttribute('aria-pressed', String(on));
  for (const v of new Set([state.inst, state.layer, state.split].filter(Boolean))) v.setSustain(on);
  if (state.bus) state.bus.setPedal(on);
  if (on !== state.pedalWas) { midiOut.pedal(on); recorder.add('pedal', on); state.pedalWas = on; }
}

function noteOn(midi, vel, info = {}) {
  if (midi == null || midi < 21 || midi > 108) return;
  state.active.set(midi, (state.active.get(midi) || 0) + 1);
  state.lastNoteT = performance.now();
  state.spans.push({ midi, start: performance.now(), end: null, vel, how: info.how || 'keyboard' });
  if (state.spans.length > 300) state.spans.shift();
  const entry = { midi, name: noteName(midi), vel: Math.round(vel * 100) / 100, how: info.how || 'keyboard', t: performance.now() };
  state.played.push(entry);
  if (state.check && info.how && info.how.startsWith('tap')) checkNote(midi);
  if (state.tune && info.how !== 'playback') {
    const want = state.tune.next, wasDone = state.tune.done;
    state.tune.play(midi);
    if (wasDone && !state.tune.done && state.started && !state.check) startRecordingForTuning(); // started again
    if (!wasDone && state.tune.done && state.rec && !state.check) {
      const rec = state.rec; state.rec = null;
      // tuning only helps if notes were wrong or taps were missed (more taps heard than notes)
      if (state.tune.wrong > 0 || rec.taps.length > state.tune.tune.notes.length + 1) setTimeout(() => offerTuning(state.tune.tune.notes, rec, `Finished “${state.tune.tune.name}” with ${state.tune.wrong} wrong.`), 600);
    }
    $('tuneProg').textContent = state.tune.progress();
    if (want != null && midi !== want) { state.tuneWrong = midi; setTimeout(() => { if (state.tuneWrong === midi) { state.tuneWrong = null; drawPiano(); } }, 400); }
  }
  if (info.tap && !info.tap.learnt && info.tap.peak != null) { info.tap.learnt = true; velocityMap.add(info.tap.peak, info.tap.floor); }
  if (state.played.length > 500) state.played.shift();
  for (const v of voicesFor(midi)) v.noteOn(midi, vel);
  midiOut.noteOn(midi, vel);
  recorder.add('on', midi, vel);
  // tap → sound delay: time since the tap was heard + the audio output path
  if (info.t != null && state.ctx && info.how && info.how.startsWith('tap')) {
    const out = ((state.ctx.baseLatency || 0) + (state.ctx.outputLatency || 0)) * 1000;
    const lat = performance.now() - info.t + out; // info.t already allows for the input delay
    state.lastLatency = lat;
    state.latencies.push(lat);
    if (state.latencies.length > 50) state.latencies.shift();
  }
  drawPiano();
}
function noteOff(midi) {
  const n = (state.active.get(midi) || 0) - 1;
  for (let i = state.spans.length - 1; i >= 0; i--) if (state.spans[i].midi === midi && state.spans[i].end == null) { state.spans[i].end = performance.now(); break; }
  recorder.add('off', midi);
  // another finger (or a computer key) still holds this note: keep it sounding
  if (n > 0) { state.active.set(midi, n); return; }
  state.active.delete(midi);
  // release on every sound (the split/layer may have changed while the key was down)
  for (const v of new Set([state.inst, state.layer, state.split].filter(Boolean))) v.noteOff(midi);
  midiOut.noteOff(midi);
  drawPiano();
}

// ---------------------------------------------------------------- audio
const synthCache = {};
function makeInstrument(id) {
  if (id !== 'piano' && SYNTHS[id]) return synthCache[id] || (synthCache[id] = new SYNTHS[id](state.ctx, state.bus.input));
  if (id === 'bright') return synthCache.bright || (synthCache.bright = brightPiano());
  if (id === 'honky') return synthCache.honky || (synthCache.honky = honkyTonk());
  return state.piano;
}
function selectLayer(id) {
  const prev = state.layer;
  state.layer = id && id !== settings.instrument ? makeInstrument(id) : null;
  if (prev && prev !== state.layer && prev !== state.inst) prev.allOff();
  if (state.layer) { state.layer.setVolume(settings.volume * 0.6, prev !== state.layer); state.layer.setSustain(pedalDown()); }
}
const SPLIT_POINT = 60; // notes below middle C go to the split sound
function selectSplit(id) {
  const prev = state.split;
  state.split = id && id !== settings.instrument ? makeInstrument(id) : null;
  if (prev && prev !== state.split && prev !== state.inst && prev !== state.layer) prev.allOff();
  if (state.split) { state.split.setVolume(settings.volume, prev !== state.split); state.split.setSustain(pedalDown()); }
}
// which sounds play this note
function voicesFor(midi) {
  if (state.split && midi < SPLIT_POINT) return [state.split];
  return [state.inst, state.layer].filter(Boolean);
}
function selectInstrument(id) {
  if (!state.ctx) return;
  const prev = state.inst;
  state.inst = makeInstrument(id);
  if (prev && prev !== state.inst && prev !== state.layer) prev.allOff();
  state.inst.setVolume(settings.volume, prev !== state.inst);
  state.inst.setSustain(pedalDown());
  selectLayer(settings.layer);
  selectSplit(settings.split);
}

// The grand piano's own samples through a treble lift and a touch of presence: a brighter,
// more "pop" piano with no extra download.
function brightPiano() {
  const shelf = state.ctx.createBiquadFilter();
  shelf.type = 'highshelf'; shelf.frequency.value = 2500; shelf.gain.value = 7;
  const presence = state.ctx.createBiquadFilter();
  presence.type = 'peaking'; presence.frequency.value = 1200; presence.Q.value = 0.8; presence.gain.value = 3;
  shelf.connect(presence).connect(state.bus.input);
  const p = new Piano(state.ctx, shelf);
  p.buffers = state.piano.buffers; // share the already-loaded samples
  p.loaded = true;
  return p;
}

// Honky-tonk: the same recordings played as two strings tuned slightly apart, a bit brighter.
function honkyTonk() {
  const shelf = state.ctx.createBiquadFilter();
  shelf.type = 'highshelf'; shelf.frequency.value = 2000; shelf.gain.value = 4;
  shelf.connect(state.bus.input);
  const p = new Piano(state.ctx, shelf);
  p.buffers = state.piano.buffers;
  p.loaded = true;
  p.detunes = [-11, 11];
  return p;
}

async function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  state.ctx = new AC({ latencyHint: 'interactive' });
  await state.ctx.resume();
  state.bus = makeReverbBus(state.ctx);
  state.bus.setAmount(settings.reverb);
  state.piano = new Piano(state.ctx, state.bus.input);
  state.piano.setVolume(settings.volume, true);
  selectInstrument(settings.instrument);
  updatePedal();
  setStatus('Loading piano sound…');
  await state.piano.load('samples/piano/', (p) => setStatus(`Loading piano sound… ${Math.round(p * 100)}%`));
}

let micGen = 0;
async function startMic() {
  stopMic();
  const gen = ++micGen; // a newer call (quick settings changes) wins; older ones clean up
  const speaker = settings.output === 'speaker';
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(settings.mic ? { deviceId: { exact: settings.mic } } : {}), echoCancellation: speaker, noiseSuppression: false, autoGainControl: false, channelCount: 1, latency: 0 },
  });
  if (gen !== micGen) { stream.getTracks().forEach((t) => t.stop()); return; }
  state.micStream = stream;
  const track = stream.getAudioTracks()[0];
  const st = track.getSettings ? track.getSettings() : {};
  state.inputLatencyMs = st.latency ? st.latency * 1000 : 0;
  if (!state.workletLoaded) { await state.ctx.audioWorklet.addModule('src/tap-worklet.js'); state.workletLoaded = true; }
  if (gen !== micGen) return; // stream already stopped by the newer call's stopMic()
  const src = state.ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(state.ctx, 'tap-detector', { numberOfInputs: 1, numberOfOutputs: 0 });
  src.connect(node);
  node.port.postMessage({ type: 'options', options: { sensitivity: settings.sensitivity } });
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'level') { state.micLevel = d.level; state.micFloor = d.floor; state.micHistory.push(d.level); if (state.micHistory.length > 150) state.micHistory.shift(); return; }
    if (d.type === 'onset') {
      // the worklet tells us the audio clock now (d.now) and at the onset (d.time); the
      // message hop to this thread is ~1 ms, so the tap happened about this long ago:
      const t = performance.now() - (d.now - d.time) * 1000;
      // how long the tap took to reach the main thread (worklet block + message hop)
      state.tapMsgDelays.push((d.now - d.time) * 1000);
      if (state.tapMsgDelays.length > 50) state.tapMsgDelays.shift();
      // in ?sim test mode taps are injected; ignore the (fake) microphone's beeps
      if (!SIM) handleTap({ t: t - state.inputLatencyMs, peak: d.peak, floor: d.floor });
    }
  };
  state.micNode = node;
  for (const e of Object.values(engines)) e.speakerMode = speaker;
}

function stopMic() {
  if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
  if (state.micNode) { try { state.micNode.disconnect(); } catch { /* ignore */ } state.micNode.port.onmessage = null; }
  state.micStream = null; state.micNode = null;
}

function handleTap({ t, peak, floor, velocity }) {
  let vel = velocity ?? (settings.dynamics === 'fixed' ? settings.fixedVelocity : velocityMap.map(peak, floor));
  // touch curve, like a digital piano's: light lifts soft taps, heavy needs firmer taps
  if (velocity == null && settings.dynamics !== 'fixed') vel = Math.pow(vel, { light: 0.65, normal: 1, heavy: 1.5 }[settings.touch] || 1);
  state.tapMarks.push({ t, vel });
  if (state.tapMarks.length > 40) state.tapMarks.shift();
  if (state.teach) { state.teach.taps.push(t); return; } // teaching: no notes
  if (state.calib) { calibTaps.push(t); return; } // resolved against the camera in calibrationEvents
  const tap = { t, velocity: vel, peak, floor };
  if (state.rec && state.rec.taps.length < 200) state.rec.taps.push({ t, velocity: vel });
  const played = fusion.onTap(tap, strikes);
  // learn the loudness range only from taps that really were notes (not talking or knocks);
  // the tap engine decides a moment later, so it's learnt in noteOn
  if (played && peak != null) velocityMap.add(peak, floor);
}

// ---------------------------------------------------------------- camera & hands
let landmarker = null;
const handIds = new HandIds();
async function startCamera() {
  const video = $('video');
  const constraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
  if (settings.camera) constraints.deviceId = { exact: settings.camera };
  else constraints.facingMode = { ideal: 'user' }; // phone at the far side, screen facing you
  // release the old camera first: many phones can't open a second one at the same time
  if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
  const stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
  video.srcObject = stream;
  await video.play();
  state.video = { w: video.videoWidth, h: video.videoHeight };
  $('camMsg').textContent = '';
  listCameras();
  if (!SIM && !landmarker) {
    try {
      setStatus('Loading hand tracker…');
      const { HandLandmarker } = await import('@mediapipe/tasks-vision');
      const fileset = { wasmLoaderPath: new URL('../vendor/mediapipe/wasm/vision_wasm_internal.js', import.meta.url).href, wasmBinaryPath: new URL('../vendor/mediapipe/wasm/vision_wasm_internal.wasm', import.meta.url).href };
      const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: 'vendor/models/hand_landmarker.task', delegate },
        runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      const want = params.get('delegate'); // ?delegate=cpu|gpu to force one
      if (want === 'cpu') landmarker = await make('CPU');
      else { try { landmarker = await make('GPU'); state.delegate = 'GPU'; } catch { landmarker = await make('CPU'); } }
      state.delegate = state.delegate || 'CPU';
      if (!want) autoPickDelegate(make);
    } catch (err) {
      console.warn('hand tracker unavailable', err);
      setStatus('Hand tracker could not start on this device – computer-keyboard play still works.');
    }
  }
  if (state.cameraLoop) return;
  state.cameraLoop = true;
  const onFrame = (now, meta) => {
    processVideoFrame(meta && meta.captureTime ? meta.captureTime : now);
    video.requestVideoFrameCallback(onFrame);
  };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
  else { const loop = () => { processVideoFrame(performance.now()); requestAnimationFrame(loop); }; loop(); }
}

// Some devices (and headless browsers) have slow GPU paths: after a couple of seconds, if hand
// tracking on the GPU is slow, try the CPU version and keep it if it's faster.
function autoPickDelegate(make) {
  if (state.delegate !== 'GPU') return;
  setTimeout(async () => {
    if (state.trackMs < 45) return;
    try {
      const gpuMs = state.trackMs;
      const cpu = await make('CPU');
      const old = landmarker;
      landmarker = cpu; state.trackMs = gpuMs; lastTs += 1;
      setTimeout(() => {
        if (state.trackMs > gpuMs) { landmarker = old; cpu.close(); }
        else { state.delegate = 'CPU'; old.close(); }
      }, 2500);
    } catch (e) { console.warn('CPU hand tracker unavailable', e); }
  }, 3000);
}

let frameCount = 0, lastTs = 0;
const detCanvas = document.createElement('canvas');
function processVideoFrame(t) {
  const video = $('video');
  frameCount++;
  if (video.videoWidth && video.videoWidth !== state.video.w) state.video = { w: video.videoWidth, h: video.videoHeight }; // phone rotated
  // look for the paper often until found, then every 10th frame (it rarely moves)
  if (settings.mode === 'paper' && frameCount % (state.markersSeen.size >= 4 ? 10 : 3) === 0) findPaper(video);
  if (landmarker && !SIM) {
    // MediaPipe needs strictly increasing timestamps; camera timestamps can repeat
    t = Math.max(t, lastTs + 0.1);
    lastTs = t;
    let res;
    const t0 = performance.now();
    try { res = landmarker.detectForVideo(video, t); state.trackMs = state.trackMs * 0.9 + (performance.now() - t0) * 0.1; } catch (err) { console.warn('hand tracking frame skipped', err); return; }
    const hands = handIds.assign((res.landmarks || []).map((lm) => ({
      points: lm.map((p) => ({ x: p.x * state.video.w, y: p.y * state.video.h, z: p.z * state.video.w })),
    })));
    handleHandFrame({ t, hands });
  }
}

// How long a tap waits for camera frames after it: two frames ("accurate") or one ("fast"). Tuned
// at 30 frames/s (70 ms vs 35 ms); a 60 frames/s camera halves the wait.
function adaptWait() {
  const f = fps();
  const frameMs = f > 5 ? 1000 / f : 33;
  // how long to wait after a tap for camera frames. Fast cameras: 2 frames. Slow trackers (measured by
  // dropping frames from the real clips): 15 fps scored best at 70 ms, 10 fps at 140 ms (45.6% vs
  // 40.4% at 70 ms) → max(70, 2.1 frames − 70 ms).
  const accurate = frameMs <= 34 ? 2 * frameMs + 4 : Math.max(70, 2.1 * frameMs - 70);
  engines.tap.resolver.o.afterMs = Math.max(25, Math.min(210, settings.response === 'fast' ? frameMs + 4 : accurate));
  // a frame for time t only arrives after it has been tracked: on slow devices allow for that
  // before giving up on a tap
  engines.tap.o.maxWaitMs = Math.max(250, engines.tap.resolver.o.afterMs + frameMs + (state.trackMs || 0) + 50);
  // in accurate mode, clear-cut notes (one finger well ahead) still play after one frame
  engines.tap.o.earlyMs = settings.response === 'fast' ? 0 : Math.max(20, frameMs + 4);
}

function handleHandFrame(frame) {
  state.frameTimes.push(performance.now());
  if (state.frameTimes.length > 30) state.frameTimes.shift();
  if (state.frameTimes.length % 15 === 0) adaptWait();
  state.hands = frame.hands;
  state.handsT = frame.t;
  const events = strikes.update(frame); // also drives the fingertip colours and calibration
  updateHover(frame.hands);
  if (state.teach) { engines.tap.resolver.pushFrame(frame); teachStep(); return; }
  if (state.calib) { engines.tap.resolver.pushFrame(frame); calibrationEvents(events); return; }
  if (state.rec && state.rec.frames.length < 6000) state.rec.frames.push(frame);
  if (fusion === engines.tap) fusion.onFrame(frame);
  else fusion.onStrikeEvents(events, strikes);
  fusion.tick(performance.now());
}

let markerWorker = null, markerBusy = false, markerScale = 1;
try { markerWorker = new Worker(new URL('./marker-worker.js', import.meta.url), { type: 'module' }); } catch { markerWorker = null; }
if (markerWorker) {
  markerWorker.onmessage = (e) => { markerBusy = false; updatePaperFromMarkers(e.data.found, markerScale); };
  markerWorker.onerror = () => { markerWorker = null; markerBusy = false; }; // fall back to the main thread
}
function findPaper(video) {
  if (!video.videoWidth || markerBusy) return;
  const scale = Math.min(1, 960 / video.videoWidth);
  const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
  detCanvas.width = w; detCanvas.height = h;
  const c = detCanvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(video, 0, 0, w, h);
  const grey = toGrey(c.getImageData(0, 0, w, h).data, w, h);
  if (markerWorker) {
    markerBusy = true;
    markerScale = 1 / scale;
    markerWorker.postMessage({ grey: grey.buffer, w, h }, [grey.buffer]);
  } else {
    updatePaperFromMarkers(detectMarkers(grey, w, h), 1 / scale);
  }
}

function updatePaperFromMarkers(found, scale = 1) {
  // many webcams already send a mirror image: notice it from the markers so the picture can be
  // shown the right way round
  if (found.length >= 2) {
    const mir = found.filter((m) => m.mirrored).length > found.length / 2;
    if (mir !== state.cameraMirrored) { state.cameraMirrored = mir; applyMirror(); }
  }
  // printed the other paper size than the one chosen in Settings? Switch after 5 agreeing looks.
  const size = detectPaperSize(found, scale);
  if (size && size !== settings.paperSize) {
    state.sizeVotes = (state.sizeVotes || 0) + 1;
    if (state.sizeVotes >= 5) {
      state.sizeVotes = 0;
      settings.paperSize = size;
      $('settings').querySelector('form').elements.paperSize.value = size;
      applySettings();
      setStatus(`Found the ${size === 'compact' ? '2-octave (C4–C6)' : 'full (C3–C6)'} paper keyboard – switched to it.`);
    }
  } else if (size) state.sizeVotes = 0;
  const res = fitPaper(state.layout, found, scale);
  state.markersSeen = res ? res.used : new Set();
  // two markers alone (e.g. both at the back) pin down the front of the keys poorly: only use
  // them if there's nothing better
  if (res && (res.used.size >= 3 || !state.paperH)) {
    state.paperH = res.H; state.paperInv = invertH(res.H); state.paperSeen = performance.now();
  }
  return state.markersSeen.size;
}

// ---------------------------------------------------------------- plain desk calibration
function startCalibration() {
  fusion.allOff(); // camera frames stop going to the note engine while calibrating
  state.calib = 'c4';
  settings.desk = settings.desk || {};
  showCalib('Calibration: tap <b>middle C</b> with one finger.');
}
function recentre() {
  if (!settings.desk || !settings.desk.c5) return startCalibration();
  fusion.allOff();
  state.calib = 'recentre';
  showCalib('Recentre: tap <b>middle C</b> again.');
}
// Calibration points come from a heard tap + the finger that pressed (tap-first, like playing),
// or, if there's no microphone, from a clear finger landing.
const calibTaps = [];
function calibrationEvents(events) {
  let p = null;
  const r = engines.tap.resolver;
  while (calibTaps.length && r.ready(calibTaps[0])) {
    const picks = r.resolve(calibTaps.shift());
    if (picks.length) { const best = picks.reduce((a, b) => (b.lead > a.lead ? b : a)); p = { x: best.x, y: best.y }; }
  }
  if (!p && (!state.micNode || SIM)) { // no microphone: fall back to a clear finger landing
    const land = events.find((e) => e.type === 'land');
    if (land) p = { x: land.x, y: land.y };
  }
  if (!p) return;
  calibrationPoint(p);
}
function calibrationPoint(p) {
  // new points go into a draft, so cancelling half-way keeps the old (working) calibration
  if (state.calib === 'c4') { state.calibDraft = { c4: p }; state.calib = 'c5'; showCalib('Now tap the <b>C above</b> middle C.'); }
  else if (state.calib === 'c5') {
    state.calibDraft.c5 = p; state.calib = 'c6';
    showCalib('Optional, for better accuracy at the ends: tap the <b>C above that</b> (two octaves above middle C). <button id="calibSkip">Skip</button>');
    $('calibSkip').onclick = () => finishCalib('Calibrated – play away!');
  }
  else if (state.calib === 'c6') { state.calibDraft.c6 = p; finishCalib('Calibrated – play away!'); }
  else if (state.calib === 'recentre') {
    const cal = settings.desk, vw = state.video.w, vh = state.video.h;
    if (cal.w && vw && (cal.w !== vw || cal.h !== vh)) p = { x: p.x * cal.w / vw, y: p.y * cal.h / vh }; // into calibration pixels
    const dx = p.x - settings.desk.c4.x, dy = p.y - settings.desk.c4.y;
    const c6 = settings.desk.c6;
    settings.desk = { c4: p, c5: { x: settings.desk.c5.x + dx, y: settings.desk.c5.y + dy }, ...(c6 ? { c6: { x: c6.x + dx, y: c6.y + dy } } : {}), w: settings.desk.w, h: settings.desk.h };
    finishCalib('Recentred.');
  }
}
function finishCalib(msg) {
  if (state.calibDraft) { settings.desk = { ...state.calibDraft, w: state.video.w, h: state.video.h }; state.calibDraft = null; }
  state.calib = null; saveSettings(settings); showCalib(msg); setTimeout(() => { if (!state.calib) $('calib').hidden = true; }, 2500); }
function showCalib(html, onCancel) {
  const el = $('calib');
  el.hidden = false;
  el.innerHTML = `${html} <button id="calibCancel">Cancel</button>`;
  $('calibCancel').onclick = () => { state.calib = null; state.calibDraft = null; if (onCancel) onCancel(); el.hidden = true; };
}

// ---------------------------------------------------------------- teaching the app your fingers
const FINGER_NAMES = { 4: 'THUMB', 8: 'INDEX finger', 12: 'MIDDLE finger', 16: 'RING finger', 20: 'LITTLE finger' };
const TEACH_TAPS = 3;
function startTeaching() {
  if (!state.started) { setStatus('Press Start first, then teach your fingers.'); return; }
  fusion.allOff();
  state.teach = { order: [4, 8, 12, 16, 20], idx: 0, count: 0, taps: [], teacher: new FingerTeacher() };
  showTeach();
}
function showTeach(extra = '') {
  const tch = state.teach;
  const tip = tch.order[tch.idx];
  const dots = '●'.repeat(tch.count) + '○'.repeat(TEACH_TAPS - tch.count);
  showCalib(`Teaching (${tch.idx + 1}/5): tap ${TEACH_TAPS} times with your <b>${FINGER_NAMES[tip]}</b> <span class="dots">${dots}</span> ${extra}`, () => { state.teach = null; });
}
function teachStep() {
  const tch = state.teach;
  const r = engines.tap.resolver;
  while (tch.taps.length && r.ready(tch.taps[0])) {
    const vec = r.pattern(tch.taps.shift());
    if (!vec || !tch.teacher.add(tch.order[tch.idx], vec)) { showTeach('(no finger movement seen – try again)'); continue; }
    tch.count++;
    if (tch.count >= TEACH_TAPS) { tch.idx++; tch.count = 0; }
    if (tch.idx >= tch.order.length) {
      settings.fingerTemplates = tch.teacher.templates();
      r.templates = settings.fingerTemplates;
      saveSettings(settings);
      state.teach = null;
      finishCalib('Thanks – your fingers are learnt. Play away!');
      return;
    }
    showTeach();
  }
}

// ---------------------------------------------------------------- accuracy check
// Play a short known exercise; the app compares what it heard with what was asked.
const CHECK_NOTES = [60, 62, 64, 65, 67, 65, 64, 62, 60];
function startCheck() {
  if (!state.started) { setStatus('Press Start first.'); return; }
  state.check = { got: [], t0: performance.now() };
  startRecordingForTuning();
  showCalib(`Accuracy check: play <b>${CHECK_NOTES.map(noteName).join(' ')}</b> slowly, one finger per note (thumb on middle C).`, () => { state.check = null; });
}
function checkNote(midi) {
  const c = state.check;
  c.got.push(midi);
  if (c.got.length >= CHECK_NOTES.length + 3) finishCheck();
}
function finishCheck() {
  const c = state.check; state.check = null;
  const rec = state.rec; state.rec = null;
  const correct = alignCorrect(CHECK_NOTES, c.got);
  const extra = Math.max(0, c.got.length - correct);
  const msg = `Accuracy check: <b>${correct} of ${CHECK_NOTES.length}</b> notes right${extra ? `, ${extra} wrong or extra` : ''}. Heard: ${c.got.map(noteName).join(' ') || 'nothing'}.`;
  const tips = correct >= 8 ? 'Great!' : 'Tips: tap firmly so the mic hears it, keep the other fingers still, try “Teach my fingers”.';
  if (correct >= CHECK_NOTES.length) { showCalib(`${msg} ${tips}`); return; }
  offerTuning(CHECK_NOTES, rec, msg, tips);
}

// Personal auto-tuning (see auto-tune.js): the hand frames and taps of a known exercise or tune are
// kept in memory only (state.rec) and replayed with variations of the detection settings.
function startRecordingForTuning() { state.rec = { frames: [], taps: [] }; }
function offerTuning(expected, rec, msg, tips = '') {
  if (!rec || fusion !== engines.tap || rec.taps.length < 5) { if (msg) showCalib(`${msg} ${tips}`); return; }
  showCalib(`${msg} Tuning the note detection to your playing…`);
  // let the message show before the (short) number crunching
  setTimeout(() => {
    const r = autoTune({
      frames: rec.frames, taps: rec.taps, expected, keyFor: (p) => keyForPoint(p.x, p.y),
      base: { ...engines.tap.resolver.o }, fusionOpts: { ...engines.tap.o }, templates: engines.tap.resolver.templates, syncOffset: engines.tap.syncOffset,
    });
    if (!r.params) { showCalib(`${msg} ${tips}`); return; }
    showCalib(`${msg} <b>Tuned to your playing:</b> replaying what you just played with adjusted detection gets <b>${r.after} of ${expected.length}</b> notes right (was ${r.before}). <button id="tuneKeep" class="primary">Keep it</button> <button id="tuneNo">No thanks</button>`);
    $('tuneKeep').onclick = () => { settings.tuned = { ...(settings.tuned || {}), ...r.params }; applySettings(); finishCalib('Tuned to your playing – Settings are unchanged; “Forget” on the set-up screen undoes it.'); };
    $('tuneNo').onclick = () => { $('calib').hidden = true; };
  }, 30);
}

// ---------------------------------------------------------------- drawing
// Note trail: the last few seconds of notes rise up from the keyboard (brighter = louder).
const ROLL_MS = 3000;
function drawRoll() {
  const cv = $('roll');
  if (!settings.showRoll || !state.pianoGeom) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0b0e14'; g.fillRect(0, 0, W, H);
  const { low, high, w0, kw } = state.pianoGeom;
  const now = performance.now();
  for (const sp of state.spans) {
    if (sp.midi < low || sp.midi > high) continue;
    const end = sp.end ?? now;
    if (now - end > ROLL_MS) continue;
    const y0 = H - ((now - sp.start) / ROLL_MS) * H, y1 = H - ((now - end) / ROLL_MS) * H;
    const black = isBlack(sp.midi);
    const x = black ? (whiteIndex(sp.midi) - w0 + 1) * kw - kw * 0.3 : (whiteIndex(sp.midi) - w0) * kw + 2;
    const w = black ? kw * 0.6 : kw - 4;
    const light = 45 + Math.round(35 * sp.vel);
    g.fillStyle = sp.how === 'playback' ? `hsl(280 70% ${light}%)` : `hsl(210 90% ${light}%)`;
    g.fillRect(x, Math.max(0, y0), w, Math.max(2, y1 - Math.max(0, y0)));
  }
}

// Which key is under each tracked fingertip: shown as dots on the on-screen keyboard so you can
// see where the app thinks your fingers are before you play.
function updateHover(hands) {
  const keys = [];
  for (const h of hands || []) for (const tip of [4, 8, 12, 16, 20]) {
    const p = h.points[tip];
    const m = p && keyForPoint(p.x, p.y);
    if (m != null) keys.push(m);
  }
  const sig = keys.sort((a, b) => a - b).join(',');
  if (sig !== state.hoverSig) { state.hoverSig = sig; state.hover = keys; drawPiano(); }
}

function drawPiano() {
  const cv = $('piano');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0b0e14'; g.fillRect(0, 0, W, H);
  const { low, high } = visibleRange();
  const w0 = whiteIndex(low), nW = whiteIndex(high) - w0 + 1;
  const kw = W / nW;
  state.pianoGeom = { low, high, w0, kw, H };
  const nextKey = state.tune ? state.tune.next : null; // "Follow a tune": the key to play next
  for (let m = low; m <= high; m++) {
    if (isBlack(m)) continue;
    const x = (whiteIndex(m) - w0) * kw;
    const on = state.active.has(m);
    g.fillStyle = m === state.tuneWrong && on ? '#ff6b6b' : on ? '#4fa3ff' : m === nextKey ? '#9be7b0' : '#f4f4f0';
    g.fillRect(x + 1, 0, kw - 2, H - 2);
    g.fillStyle = on ? '#fff' : m === 60 ? '#c00' : '#888';
    g.font = `${m === 60 ? 'bold ' : ''}${Math.max(9, Math.min(13, kw * 0.38))}px system-ui`;
    g.textAlign = 'center';
    g.fillText(noteName(m), x + kw / 2, H - 8);
  }
  for (let m = low; m <= high; m++) {
    if (!isBlack(m)) continue;
    const x = (whiteIndex(m) - w0 + 1) * kw - kw * 0.3;
    g.fillStyle = m === state.tuneWrong && state.active.has(m) ? '#ff6b6b' : state.active.has(m) ? '#4fa3ff' : m === nextKey ? '#2fa35a' : '#111';
    g.fillRect(x, 0, kw * 0.6, H * 0.6);
  }
  // fingertip dots
  g.fillStyle = '#ff9f1a';
  for (const m of state.hover || []) {
    if (m < low || m > high) continue;
    const black = isBlack(m);
    const x = black ? (whiteIndex(m) - w0 + 1) * kw : (whiteIndex(m) - w0 + 0.5) * kw;
    g.beginPath(); g.arc(x, black ? H * 0.45 : H * 0.72, Math.max(3, Math.min(7, kw * 0.18)), 0, Math.PI * 2); g.fill();
  }
}
function visibleRange() {
  const v = state.layout.variant;
  const sh = settings.octave * 12;
  return { low: Math.max(21, Math.min(v.low + sh, 60 + state.kbdOctave * 12)), high: Math.min(108, Math.max(v.high + sh, 76 + state.kbdOctave * 12)) };
}

function drawOverlay() {
  const cv = $('overlay');
  const vw = state.video.w || 1280, vh = state.video.h || 720;
  if (cv.width !== vw) { cv.width = vw; cv.height = vh; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, vw, vh);
  const dbg = settings.debug;
  // the picture is shown mirrored (like a mirror, so it matches your view); mirror our drawing too
  const X = (x) => (showMirrored() ? vw - x : x);
  // where the paper should go (guide frame) when it isn't found
  if (!state.paperH && settings.mode === 'paper') {
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.setLineDash([12, 8]); g.lineWidth = 3;
    g.strokeRect(vw * 0.06, vh * 0.25, vw * 0.88, vh * 0.6);
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,.8)'; g.font = `${Math.round(vh / 24)}px system-ui`; g.textAlign = 'center';
    g.fillText('Fit the paper keyboard inside this frame', vw / 2, vh * 0.22);
  }
  if (state.paperH && settings.mode === 'paper') {
    const L = state.layout;
    const P = (x, y) => applyH(state.paperH, x, y);
    g.strokeStyle = '#3ecf7a'; g.lineWidth = 3;
    g.beginPath();
    [[0, 0], [L.width, 0], [L.width, L.height], [0, L.height]].forEach(([x, y], i) => { const p = P(x, y); i ? g.lineTo(X(p.x), p.y) : g.moveTo(X(p.x), p.y); });
    g.closePath(); g.stroke();
    // every marker: green if the camera sees it, red if not (helps aim the camera)
    for (const mk of L.markers) {
      const seen = state.markersSeen.has(mk.id);
      g.strokeStyle = seen ? '#3ecf7a' : '#ff4040'; g.lineWidth = seen ? 2 : 4;
      g.beginPath();
      [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => { const p = P(mk.x + u * mk.size, mk.y + v * mk.size); i ? g.lineTo(X(p.x), p.y) : g.moveTo(X(p.x), p.y); });
      g.closePath(); g.stroke();
    }
    // keys just played light up on the paper for a moment
    const now = performance.now();
    for (const sp of state.spans) {
      if (now - sp.start > 400 || sp.how === 'keyboard' || sp.how === 'screen' || sp.how === 'playback') continue;
      const k = L.kb.keyRect(sp.midi - settings.transpose - settings.octave * 12);
      if (!k || k.midi < L.kb.lowMidi || k.midi > L.kb.highMidi) continue;
      const y1 = k.black ? L.kb.blackLen : L.kb.whiteLen;
      g.fillStyle = `rgba(79,163,255,${0.55 * (1 - (now - sp.start) / 400)})`;
      g.beginPath();
      [[k.x0, 0], [k.x1, 0], [k.x1, y1], [k.x0, y1]].forEach(([x, y], i) => { const p = P(L.keysX + x, L.keysY + y); i ? g.lineTo(X(p.x), p.y) : g.moveTo(X(p.x), p.y); });
      g.closePath(); g.fill();
    }
    if (dbg) {
      g.lineWidth = 1; g.strokeStyle = 'rgba(62,207,122,.6)';
      for (const k of L.kb.keys) {
        const y1 = L.keysY + (k.black ? L.kb.blackLen : L.kb.whiteLen);
        const a = P(L.keysX + k.x0, L.keysY), b = P(L.keysX + k.x0, y1);
        g.beginPath(); g.moveTo(X(a.x), a.y); g.lineTo(X(b.x), b.y); g.stroke();
      }
    }
  }
  const deskPts = state.calibDraft || settings.desk; // show the new points while calibrating
  if (settings.mode === 'desk' && deskPts && deskPts.c4) {
    g.fillStyle = '#ffcc33';
    for (const p of [deskPts.c4, deskPts.c5, deskPts.c6].filter(Boolean)) { g.beginPath(); g.arc(X(p.x), p.y, 8, 0, 7); g.fill(); }
  }
  for (const hand of state.hands) {
    const pts = hand.points;
    if (dbg) {
      g.strokeStyle = 'rgba(79,163,255,.8)'; g.lineWidth = 2;
      for (const [a, b] of HAND_CONNECTIONS) { g.beginPath(); g.moveTo(X(pts[a].x), pts[a].y); g.lineTo(X(pts[b].x), pts[b].y); g.stroke(); }
    }
    for (const tip of [4, 8, 12, 16, 20]) {
      const id = `${hand.label}-${tip}`;
      const f = strikes.fingers.get(id);
      const p = pts[tip];
      // red = this finger is sounding a note (yellow = coming down, classic engine only)
      const on = fusion === engines.tap ? engines.tap.sounding.has(id) : f && f.down;
      g.fillStyle = on ? '#ff5050' : fusion !== engines.tap && f && f.descending ? '#ffcc33' : '#ffffff';
      g.beginPath(); g.arc(X(p.x), p.y, on ? 9 : 6, 0, 7); g.fill();
      if (dbg) {
        const k = keyForPoint(p.x, p.y);
        if (k != null) { g.fillStyle = '#fff'; g.font = '16px system-ui'; g.textAlign = 'center'; g.fillText(noteName(k), X(p.x), p.y - 12); }
      }
    }
  }
}

function drawDebug() {
  const cv = $('meter');
  const g = cv.getContext('2d');
  g.fillStyle = '#0c0f15'; g.fillRect(0, 0, cv.width, cv.height);
  const hist = state.micHistory;
  g.fillStyle = '#4fa3ff';
  hist.forEach((l, i) => { const db = 20 * Math.log10(Math.max(l, 1e-5)); const h = Math.max(0, (db + 80) / 80) * cv.height; g.fillRect(i * 2, cv.height - h, 2, h); });
  const now = performance.now();
  g.fillStyle = '#ff5050';
  for (const m of state.tapMarks) {
    const age = now - m.t; if (age > 4000) continue;
    g.fillRect(cv.width - (age / 4000) * cv.width, 0, 2, cv.height * m.vel);
  }
  const lat = state.latencies;
  const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null;
  const fingers = [...strikes.fingers.values()].map((f) => `${f.id}${f.down ? '↓' : f.descending ? '↘' : ''}→${(k => k == null ? '-' : noteName(k))(keyForPoint(f.x, f.y))}`);
  $('debugText').textContent = [
    `camera: ${fps().toFixed(0)} frames/s tracked, hand tracking ${state.trackMs.toFixed(0)} ms per frame (${state.delegate || '–'})`,
    `audio out: base ${fmt(state.ctx && state.ctx.baseLatency * 1000)} ms, output ${fmt(state.ctx && state.ctx.outputLatency * 1000)} ms, input ${fmt(state.inputLatencyMs)} ms`,
    `tap→sound: last ${fmt(state.lastLatency)} ms, average ${fmt(avg)} ms (${lat.length} taps)`,
    `sound/picture sync correction: ${engines.tap.syncOffset.toFixed(0)} ms`,
    `engine ${fusion === engines.classic ? "classic" : "tap"}${state.micFailed ? " (no microphone)" : ""}: taps ${fusion.stats.taps}, rejected (no finger) ${fusion.stats.tapsRejected}, notes ${fusion.stats.notes}`,
    `last tap not played: ${fusion.stats.lastWhy || '—'}`,
    `paper markers: ${[...state.markersSeen].join(',') || 'none'}`,
    `last tap, finger scores (thumb→little): ${(() => { const ls = engines.tap.resolver.lastScores; return ls ? ls.fingers.map((f) => f.score).join(' ') : '–'; })()}`,
    `fingers: ${fingers.join('  ')}`,
    `last notes: ${state.played.slice(-8).map((p) => `${p.name}(${p.vel},${p.how})`).join(' ')}`,
  ].join('\n');
}
function fps() { const f = state.frameTimes; return f.length > 1 ? (1000 * (f.length - 1)) / (f[f.length - 1] - f[0]) : 0; }
const fmt = (v) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(1));

function updateChecks() {
  const el = $('checks');
  const rows = [];
  const tick = (ok, label) => rows.push(`<span class="${ok ? 'ok' : 'no'}">${ok ? '✔' : '✘'}</span><span>${label}</span>`);
  tick(state.piano && state.piano.loaded, 'Piano sound loaded');
  const lastTap = state.tapMarks.length ? (performance.now() - state.tapMarks[state.tapMarks.length - 1].t) / 1000 : null;
  tick(!!state.micNode && lastTap != null && lastTap < 20, !state.micNode ? 'Microphone listening' : lastTap == null ? 'Microphone: tap the desk – no taps heard yet' : `Microphone hears taps (last ${lastTap < 1 ? 'just now' : `${Math.round(lastTap)} s ago`})`);
  tick(state.video.w > 0, 'Camera on');
  if (state.video.w > 0 && !SIM && landmarker) {
    const f = fps();
    tick(f >= 15, f >= 15 ? `Hand tracking ${Math.round(f)} frames/s` : `Hand tracking slow (${Math.round(f)} frames/s) – close other apps or use a faster device`);
  }
  tick(state.hands.length >= 2, `Hands found: ${state.hands.length} of 2`);
  if (state.latencies.length >= 3) {
    const l = [...state.latencies].sort((a, b) => a - b)[state.latencies.length >> 1];
    tick(l < 180, `Delay from tap to sound: about ${Math.round(l / 10) * 10} ms${l >= 180 ? ' – try Settings → Response: Faster, or a faster device' : ''}`);
  }
  // hands busy for a while but no taps heard → the mic is probably too far away or too insensitive
  const now = performance.now();
  if (state.hands.length) { if (!state.handsSince) state.handsSince = now; } else state.handsSince = 0;
  if (state.micNode && state.handsSince && now - state.handsSince > 10000 && (lastTap == null || lastTap > 10)) {
    rows.push('<span class="no">!</span><span>I can see your hands but can’t hear any taps. Tap more firmly, move the microphone closer to the paper (or pick another one in Settings → Devices), or raise Tap sensitivity.</span>');
  }
  if (settings.mode === 'paper') tick(state.markersSeen.size === state.layout.markers.length, `Paper markers: ${state.markersSeen.size} of ${state.layout.markers.length}`);
  else {
    const d = settings.desk, vw = state.video.w, vh = state.video.h;
    const turned = d && d.w && vw && (d.w > d.h) !== (vw > vh);
    tick(!!(d && d.c5) && !turned, `${turned ? 'Desk calibration was made with the camera the other way round –' : 'Desk calibrated'} <button id="calibBtn">Calibrate</button> <button id="recentreBtn">Recentre</button>`);
  }
  if (settings.engine !== 'classic' && !state.teach) {
    const taught = !!(settings.fingerTemplates && [4, 8, 12, 16, 20].every((t) => settings.fingerTemplates[t]));
    tick(taught, taught ? 'Fingers taught' : 'Fingers not taught yet – <button id="teachCheckBtn">Teach my fingers</button> (30 s, helps it pick the right finger)');
  }
  // set-up steps tick themselves off as they're done
  const paperOk = settings.mode === 'paper' && state.markersSeen.size >= 4;
  const stepDone = {
    paper: paperOk, camera: paperOk || (settings.mode === 'desk' && state.video.w > 0),
    markers: settings.mode === 'paper' && state.markersSeen.size === state.layout.markers.length,
    mic: !!state.micNode && lastTap != null && lastTap < 60,
    hands: state.hands.length >= 2,
  };
  for (const li of document.querySelectorAll('#setupPanel li[data-step]')) li.classList.toggle('done', !!stepDone[li.dataset.step]);
  const html = rows.join('');
  if (el.dataset.html !== html) {
    el.innerHTML = html; el.dataset.html = html;
    if ($('calibBtn')) $('calibBtn').onclick = startCalibration;
    if ($('recentreBtn')) $('recentreBtn').onclick = recentre;
    if ($('teachCheckBtn')) $('teachCheckBtn').onclick = startTeaching;
  }
}

function loop() {
  fusion.tick(performance.now());
  // the accuracy check ends after 4 s without a new note
  if (state.check && state.check.got.length && performance.now() - state.lastNoteT > 4000) finishCheck();
  if (state.paperH && performance.now() - state.paperSeen > 20000) { state.paperH = null; state.paperInv = null; }
  drawOverlay();
  if (settings.debug) drawDebug();
  updateChecks();
  drawRoll();
  // mic level bar: dB relative to the background noise, so quiet far-away mics still show taps
  // flash: green = a tap became a note, orange = a tap was heard but no finger was seen pressing
  const rej = fusion.stats.tapsRejected, notes = fusion.stats.notes;
  if (rej !== state.lastRej) { state.lastRej = rej; state.flash = { c: '#ffaa33', until: performance.now() + 350 }; }
  if (notes !== state.lastNotes) { state.lastNotes = notes; state.flash = { c: '#3ecf7a', until: performance.now() + 350 }; }
  $('micLevel').parentElement.style.boxShadow = state.flash && performance.now() < state.flash.until ? `0 0 0 2px ${state.flash.c}` : 'none';
  const lv = state.micLevel || 0, fl = state.micFloor || 1e-4;
  $('micLevel').style.width = `${Math.max(0, Math.min(100, (20 * Math.log10(Math.max(lv, 1e-9) / fl)) * 3))}%`;
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- UI
function setStatus(s) { $('status').textContent = s; }

function applySettings() {
  state.layout = paperLayout(settings.paperSize);
  $('debug').hidden = !settings.debug;
  selectInstrument(settings.instrument);
  $('modePaper').setAttribute('aria-pressed', String(settings.mode === 'paper'));
  $('modeDesk').setAttribute('aria-pressed', String(settings.mode === 'desk'));
  $('camWrap').classList.toggle('hidden', !settings.showCamera);
  applyMirror();
  $('roll').classList.toggle('hidden', !settings.showRoll);
  $('hint').hidden = settings.output !== 'speaker' && state.started;
  $('cameraOnlyRow').hidden = settings.engine !== 'classic'; // only applies to the classic engine
  for (const k of Object.keys(TUNE_GRID)) engines.tap.resolver.o[k] = settings.tuned && k in settings.tuned ? settings.tuned[k] : baseResolver[k]; // personal tuning
  $('fixedRow').hidden = settings.dynamics !== 'fixed';
  $('touchRow').hidden = settings.dynamics === 'fixed';
  // Without a microphone the tap engine can never play, so fall back to the classic engine playing
  // clear finger strikes on their own (quieter, a little later, and hovering hands may trigger notes).
  const noMic = !!state.micFailed;
  engines.classic.o.cameraOnly = settings.cameraOnly || noMic;
  const nextEngine = noMic ? engines.classic : engines[settings.engine] || engines.tap;
  if (nextEngine !== fusion) { fusion.allOff(); fusion = nextEngine; }
  for (const e of Object.values(engines)) e.speakerMode = settings.output === 'speaker';
  adaptWait();
  engines.tap.resolver.o.chordRatio = settings.chords ? 0.9 : 1.01;
  velocityMap.sensitivity = settings.sensitivity;
  if (state.bus) state.bus.setAmount(settings.reverb);
  if (state.metro) { state.metro.bpm = settings.bpm; state.metro.beats = settings.beatsPerBar; }
  if (state.micNode) state.micNode.port.postMessage({ type: 'options', options: { sensitivity: settings.sensitivity } });
  updatePedal();
  drawPiano();
  saveSettings(settings);
}

// The picture is shown like a mirror (matches your view across the desk). If the camera itself
// already mirrors, don't flip it again.
function showMirrored() { return !!settings.mirror !== !!state.cameraMirrored; }
function applyMirror() { $('camWrap').classList.toggle('mirror', showMirrored()); }

function setSetup(on, autoStart = true) {
  document.body.classList.toggle('setup', on);
  $('setupPanel').hidden = !on;
  $('setupBtn').setAttribute('aria-pressed', String(on));
  if (on && autoStart && !state.started) start();
  requestAnimationFrame(drawPiano);
}

function bindTunes() {
  const sel = $('tuneSel');
  sel.innerHTML = '<option value="">—</option>' + TUNES.map((t, i) => `<option value="${i}">${t.name}</option>`).join('');
  sel.onchange = () => {
    state.tune = sel.value === '' ? null : new TuneFollower(TUNES[Number(sel.value)]);
    if (state.tune && state.started && !state.check) startRecordingForTuning(); else if (!state.check) state.rec = null;
    $('tuneProg').textContent = state.tune ? `${state.tune.progress()} — play the green key` : '';
    sel.blur(); // keep the computer keys for playing
    drawPiano();
  };
}

function bindSettings() {
  const form = $('settings').querySelector('form');
  for (const [id, label] of Object.entries(INSTRUMENTS)) { form.elements.instrument.add(new Option(label, id)); form.elements.layer.add(new Option(label, id)); form.elements.split.add(new Option(label, id)); }
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name]; else el.value = settings[el.name];
    el.addEventListener('change', () => {
      const prevOutput = settings.output, prevCam = settings.camera, prevMic = settings.mic;
      settings[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
      applySettings();
      if (el.name === 'mode' && settings.mode === 'desk' && !(settings.desk && settings.desk.c5)) startCalibration();
      if ((settings.output !== prevOutput || settings.mic !== prevMic) && (state.micNode || state.micFailed)) startMic().then(() => { state.micFailed = false; applySettings(); }).catch((e) => { state.micFailed = true; applySettings(); setStatus(`Microphone: ${e.message}`); });
      if (settings.camera !== prevCam && $('video').srcObject) startCamera().catch((e) => setStatus(`Camera: ${e.message}`));
    });
  }
  $('settingsBtn').onclick = () => $('settings').showModal();
  // MIDI output: asking for MIDI access only when the player chooses to
  const fillMidi = (outs) => {
    const sel = form.elements.midiOut;
    while (sel.options.length > 1) sel.remove(1);
    outs.forEach((o) => sel.add(new Option(o.name, o.id)));
    sel.value = outs.some((o) => o.id === settings.midiOut) ? settings.midiOut : '';
    midiOut.select(sel.value);
  };
  $('midiEnable').onclick = async () => {
    try { fillMidi(await midiOut.enable()); } catch (e) { $('midiEnable').textContent = 'MIDI not available'; console.warn(e); }
  };
  form.elements.midiOut.addEventListener('change', () => midiOut.select(settings.midiOut));
  // recording
  $('recBtn').onclick = () => {
    if (!recorder.recording) { recorder.start(); $('recBtn').textContent = '■ Stop'; $('recBtn').setAttribute('aria-pressed', 'true'); }
    else {
      const ev = recorder.stop();
      $('recBtn').textContent = '● Rec'; $('recBtn').setAttribute('aria-pressed', 'false');
      $('playBtn').hidden = $('saveBtn').hidden = !ev.some((e) => e.type === 'on');
    }
  };
  $('playBtn').onclick = () => {
    ensureAudio();
    const ev = recorder.last || [];
    for (const e of ev) {
      setTimeout(() => {
        if (e.type === 'on') noteOn(e.a, e.b, { how: 'playback' });
        else if (e.type === 'off') noteOff(e.a);
        else if (e.type === 'pedal') { state.pedalButton = e.a; updatePedal(); }
      }, e.t + 50);
    }
  };
  $('saveBtn').onclick = () => {
    const blob = new Blob([recorder.toMidiFile()], { type: 'audio/midi' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `desk-piano-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mid`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // quick controls on the main screen
  const setMode = (m) => {
    settings.mode = m;
    form.elements.mode.value = m;
    applySettings();
    if (m === 'desk' && !(settings.desk && settings.desk.c5)) startCalibration();
  };
  $('modePaper').onclick = () => setMode('paper');
  $('modeDesk').onclick = () => setMode('desk');
  $('volume').value = settings.volume;
  $('volume').addEventListener('input', () => {
    settings.volume = Number($('volume').value);
    if (state.inst) state.inst.setVolume(settings.volume);
    if (state.layer) state.layer.setVolume(settings.volume * 0.6);
    if (state.split) state.split.setVolume(settings.volume);
    saveSettings(settings);
  });
  $('setupBtn').onclick = () => setSetup(true);
  $('setupDone').onclick = () => setSetup(false);
  $('teachBtn').onclick = startTeaching;
  $('copyDiag').onclick = async () => {
    const { desk, fingerTemplates, camera, mic, midiOut, ...rest } = settings; // no device ids or positions
    const diag = {
      when: new Date().toISOString(), userAgent: navigator.userAgent,
      fps: +fps().toFixed(1), trackMs: +state.trackMs.toFixed(1), delegate: state.delegate,
      video: state.video, markers: state.markersSeen.size, cameraMirrored: !!state.cameraMirrored,
      audio: state.ctx && { base: state.ctx.baseLatency, output: state.ctx.outputLatency, sampleRate: state.ctx.sampleRate }, inputLatencyMs: state.inputLatencyMs,
      tapToSoundMs: state.latencies.map((v) => Math.round(v)), syncOffsetMs: engines.tap.syncOffset, stats: fusion.stats,
      afterMs: engines.tap.resolver.o.afterMs, taught: !!fingerTemplates, settings: rest,
    };
    try { await navigator.clipboard.writeText(JSON.stringify(diag, null, 1)); $('copyDiag').textContent = 'Copied ✓'; }
    catch { $('copyDiag').textContent = 'Copy failed'; }
    setTimeout(() => { $('copyDiag').textContent = 'Copy diagnostics'; }, 2000);
  };
  $('checkBtn').onclick = startCheck;
  $('metroBtn').onclick = async () => {
    await ensureAudio();
    if (!state.metro) {
      state.metro = new Metronome(state.ctx, state.ctx.destination, (b) => {
        // a click is the app's own sound: through speakers the mic hears it (echo protection)
        for (const e of Object.values(engines)) e.lastPlayT = performance.now();
        const el = $('metroBtn');
        el.classList.add(b === 0 ? 'accent' : 'beat');
        setTimeout(() => el.classList.remove('accent', 'beat'), 100);
      });
    }
    state.metro.bpm = settings.bpm; state.metro.beats = settings.beatsPerBar;
    if (state.metro.running) state.metro.stop(); else state.metro.start();
    $('metroBtn').setAttribute('aria-pressed', String(state.metro.running));
  };
  $('fullBtn').onclick = async () => {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(() => {});
    } catch { /* not supported */ }
  };
  if (!document.documentElement.requestFullscreen) $('fullBtn').hidden = true;
  $('forgetBtn').onclick = () => { settings.fingerTemplates = null; settings.tuned = null; engines.tap.resolver.templates = null; applySettings(); setStatus('Taught finger patterns and personal tuning forgotten.'); };
}

async function listCameras() {
  try {
    const msel = $('settings').querySelector('select[name=mic]');
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    while (msel.options.length > 1) msel.remove(1);
    mics.forEach((d, i) => msel.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
    msel.value = settings.mic;
  } catch { /* ignore */ }
  try {
    const sel = $('settings').querySelector('select[name=camera]');
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    while (sel.options.length > 1) sel.remove(1);
    devs.forEach((d, i) => sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
    sel.value = settings.camera;
  } catch { /* ignore */ }
}

// Computer keyboard: A row = white keys from C, W/E/T/Y/U/O/P = black keys.
const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
const kbdDown = new Map();
function releaseComputerKeys() {
  for (const midi of kbdDown.values()) noteOff(midi);
  kbdDown.clear();
  if (state.pedalKey) { state.pedalKey = false; updatePedal(); }
}

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) { state.pedalKey = true; updatePedal(); } return; }
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.repeat) { state.kbdOctave = Math.max(-3, state.kbdOctave - 1); drawPiano(); return; }
    if (k === 'r' && !e.repeat && settings.mode === 'desk') { recentre(); return; }
    if (k === 'x' && !e.repeat) { state.kbdOctave = Math.min(3, state.kbdOctave + 1); drawPiano(); return; }
    // held keys are tracked by physical key (e.code): with Shift, ';' comes back up as ':'
    if (!(k in KEYMAP) || e.repeat || kbdDown.has(e.code)) return;
    ensureAudio();
    const midi = 60 + state.kbdOctave * 12 + KEYMAP[k] + settings.transpose;
    const vel = e.shiftKey ? 0.95 : e.ctrlKey ? 0.25 : 0.6;
    kbdDown.set(e.code, midi);
    noteOn(midi, vel, { how: 'keyboard' });
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { state.pedalKey = false; updatePedal(); return; }
    if (kbdDown.has(e.code)) { noteOff(kbdDown.get(e.code)); kbdDown.delete(e.code); }
  });
  // switching to another window while holding keys: their key-ups never arrive
  window.addEventListener('blur', releaseComputerKeys);
  // on-screen keyboard: touch/click to play
  const cv = $('piano');
  const pointerNotes = new Map();
  cv.addEventListener('pointerdown', (e) => {
    const g = state.pianoGeom; if (!g) return;
    ensureAudio();
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let midi = null;
    if (y < g.H * 0.6) for (let m = g.low; m <= g.high; m++) if (isBlack(m)) { const bx = (whiteIndex(m) - g.w0 + 1) * g.kw - g.kw * 0.3; if (x >= bx && x < bx + g.kw * 0.6) midi = m; }
    if (midi == null) { const wi = g.w0 + Math.floor(x / g.kw); for (let m = g.low; m <= g.high; m++) if (!isBlack(m) && whiteIndex(m) === wi) midi = m; }
    if (midi == null) return;
    pointerNotes.set(e.pointerId, midi);
    noteOn(midi, 0.6, { how: 'screen' });
  });
  const up = (e) => { if (pointerNotes.has(e.pointerId)) { noteOff(pointerNotes.get(e.pointerId)); pointerNotes.delete(e.pointerId); } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up); cv.addEventListener('pointerleave', up);
  $('pedal').onclick = () => { state.pedalButton = !state.pedalButton; updatePedal(); };
  window.addEventListener('resize', drawPiano);
}

let audioPromise = null;
function ensureAudio() {
  if (!audioPromise) audioPromise = startAudio().then(() => setStatus('Piano ready. Press Start to use the camera and microphone.')).catch((e) => setStatus(`Sound failed: ${e.message}`));
  return audioPromise;
}

async function start() {
  if ($('start').disabled) return;
  $('start').disabled = true;
  await ensureAudio();
  const problems = [];
  try { await startMic(); state.micFailed = false; } catch (e) { state.micFailed = true; problems.push('microphone'); console.warn('mic', e); }
  try { await startCamera(); } catch (e) { problems.push('camera'); console.warn('camera', e); $('camMsg').textContent = 'No camera'; }
  state.started = true;
  $('start').textContent = 'Running';
  keepAwake();
  applySettings();
  setStatus(problems.length ? `Could not start the ${problems.join(' and ')}. ${state.micFailed && !problems.includes('camera') ? 'Playing from the camera alone (less reliable: allow the microphone for best results).' : 'You can still play with the computer keyboard.'}` : 'Ready – tap your fingers on the paper keys. Nothing is recorded or uploaded.');
  if (settings.mode === 'desk' && !(settings.desk && settings.desk.c5)) startCalibration();
}

// keep the phone screen on while playing
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.started) keepAwake();
  // in the background the camera stops, so fingers can't be seen lifting: let go of everything
  if (document.visibilityState === 'hidden') { fusion.allOff(); releaseComputerKeys(); }
});

// offline support (not in ?sim test mode)
if ('serviceWorker' in navigator && !SIM && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* fine without it */ });
}

$('start').onclick = start;
// one-time "what's new" note (not in tests)
if (!SIM && (settings.seenNews || 0) < 2) {
  $('news').hidden = false;
  $('newsOk').onclick = () => { settings.seenNews = 2; saveSettings(settings); $('news').hidden = true; };
}
if (!loadSettings().seenSetup && !SIM) { settings.seenSetup = true; saveSettings(settings); setSetup(true, false); }
bindSettings();
bindTunes();
bindKeys();
applySettings();
requestAnimationFrame(loop);

// Test/debug hooks (synthetic data only).
window.deskPiano = {
  state, settings, get fusion() { return fusion; }, engines, strikes,
  ensureAudio,
  injectHandFrame: (frame) => handleHandFrame(frame),
  noteOn, noteOff,
  injectTap: (tap) => handleTap(tap),
  injectMarkers: (found) => updatePaperFromMarkers(found, 1),
  setVideoSize: (w, h) => { state.video = { w, h }; },
  keyForPoint,
  startCalibration, recentre, startTeaching, startCheck, finishCheck,
  applySettings,
};
