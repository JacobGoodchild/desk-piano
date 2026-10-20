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
import { FingerTeacher } from './tap-resolver.js';
import { VelocityMapper } from './onset.js';
import { paperLayout, paperToKey, fitPaper, TIP_OFFSET_MM } from './paper.js';
import { detectMarkers, toGrey } from './markers.js';
import { applyH, invertH } from './homography.js';
import { deskKeyAt } from './desk.js';
import { loadSettings, saveSettings } from './settings.js';
import { noteName, isBlack, whiteIndex } from './notes.js';
import { HAND_CONNECTIONS } from './hand-connections.js';
import { HandIds } from './hand-ids.js';

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

// ---------------------------------------------------------------- keys & notes
function shiftNote(m) { return m == null ? null : m + settings.transpose + settings.octave * 12; }

function keyForPoint(x, y) {
  if (settings.mode === 'desk') return shiftNote(deskKeyAt(settings.desk, x, y));
  if (!state.paperInv) return null;
  const p = applyH(state.paperInv, x, y);
  return shiftNote(paperToKey(state.layout, p.x, p.y, TIP_OFFSET_MM));
}

function pedalDown() { return settings.pedalAlways || state.pedalKey || state.pedalButton; }
function updatePedal() {
  const on = pedalDown();
  $('pedal').setAttribute('aria-pressed', String(on));
  if (state.inst) state.inst.setSustain(on);
  if (on !== state.pedalWas) { midiOut.pedal(on); recorder.add('pedal', on); state.pedalWas = on; }
}

function noteOn(midi, vel, info = {}) {
  if (midi == null || midi < 21 || midi > 108) return;
  state.active.set(midi, (state.active.get(midi) || 0) + 1);
  state.spans.push({ midi, start: performance.now(), end: null, vel, how: info.how || 'keyboard' });
  if (state.spans.length > 300) state.spans.shift();
  const entry = { midi, name: noteName(midi), vel: Math.round(vel * 100) / 100, how: info.how || 'keyboard', t: performance.now() };
  state.played.push(entry);
  if (info.tap && !info.tap.learnt && info.tap.peak != null) { info.tap.learnt = true; velocityMap.add(info.tap.peak, info.tap.floor); }
  if (state.played.length > 500) state.played.shift();
  if (state.inst) state.inst.noteOn(midi, vel);
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
  if (n <= 0) state.active.delete(midi); else state.active.set(midi, n);
  for (let i = state.spans.length - 1; i >= 0; i--) if (state.spans[i].midi === midi && state.spans[i].end == null) { state.spans[i].end = performance.now(); break; }
  if (state.inst) state.inst.noteOff(midi);
  midiOut.noteOff(midi);
  recorder.add('off', midi);
  drawPiano();
}

// ---------------------------------------------------------------- audio
const synthCache = {};
function selectInstrument(id) {
  if (!state.ctx) return;
  const prev = state.inst;
  if (id !== 'piano' && SYNTHS[id]) state.inst = synthCache[id] || (synthCache[id] = new SYNTHS[id](state.ctx, state.bus.input));
  else state.inst = state.piano;
  if (prev && prev !== state.inst) prev.allOff();
  state.inst.setVolume(settings.volume, prev !== state.inst);
  state.inst.setSustain(pedalDown());
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

async function startMic() {
  stopMic();
  const speaker = settings.output === 'speaker';
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(settings.mic ? { deviceId: { exact: settings.mic } } : {}), echoCancellation: speaker, noiseSuppression: false, autoGainControl: false, channelCount: 1, latency: 0 },
  });
  state.micStream = stream;
  const track = stream.getAudioTracks()[0];
  const st = track.getSettings ? track.getSettings() : {};
  state.inputLatencyMs = st.latency ? st.latency * 1000 : 0;
  if (!state.workletLoaded) { await state.ctx.audioWorklet.addModule('src/tap-worklet.js'); state.workletLoaded = true; }
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
  const vel = velocity ?? (settings.dynamics === 'fixed' ? settings.fixedVelocity : velocityMap.map(peak, floor));
  state.tapMarks.push({ t, vel });
  if (state.tapMarks.length > 40) state.tapMarks.shift();
  if (state.teach) { state.teach.taps.push(t); return; } // teaching: no notes
  if (state.calib) { calibTaps.push(t); return; } // resolved against the camera in calibrationEvents
  const tap = { t, velocity: vel, peak, floor };
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
  const stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
  if (video.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
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
  engines.tap.resolver.o.afterMs = Math.max(25, Math.min(90, (settings.response === 'fast' ? 1 : 2) * frameMs + 4));
}

function handleHandFrame(frame) {
  state.frameTimes.push(performance.now());
  if (state.frameTimes.length > 30) state.frameTimes.shift();
  if (state.frameTimes.length % 15 === 0) adaptWait();
  state.hands = frame.hands;
  state.handsT = frame.t;
  const events = strikes.update(frame); // also drives the fingertip colours and calibration
  if (state.teach) { engines.tap.resolver.pushFrame(frame); teachStep(); return; }
  if (state.calib) { engines.tap.resolver.pushFrame(frame); calibrationEvents(events); return; }
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
  state.calib = 'c4';
  settings.desk = settings.desk || {};
  showCalib('Calibration: tap <b>middle C</b> with one finger.');
}
function recentre() {
  if (!settings.desk || !settings.desk.c5) return startCalibration();
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
  if (state.calib === 'c4') { settings.desk = { c4: p }; state.calib = 'c5'; showCalib('Now tap the <b>C above</b> middle C.'); }
  else if (state.calib === 'c5') { settings.desk.c5 = p; finishCalib('Calibrated – play away!'); }
  else if (state.calib === 'recentre') {
    const dx = p.x - settings.desk.c4.x, dy = p.y - settings.desk.c4.y;
    settings.desk = { c4: p, c5: { x: settings.desk.c5.x + dx, y: settings.desk.c5.y + dy } };
    finishCalib('Recentred.');
  }
}
function finishCalib(msg) { state.calib = null; saveSettings(settings); showCalib(msg); setTimeout(() => { if (!state.calib) $('calib').hidden = true; }, 2500); }
function showCalib(html, onCancel) {
  const el = $('calib');
  el.hidden = false;
  el.innerHTML = `${html} <button id="calibCancel">Cancel</button>`;
  $('calibCancel').onclick = () => { state.calib = null; if (onCancel) onCancel(); el.hidden = true; };
}

// ---------------------------------------------------------------- teaching the app your fingers
const FINGER_NAMES = { 4: 'THUMB', 8: 'INDEX finger', 12: 'MIDDLE finger', 16: 'RING finger', 20: 'LITTLE finger' };
const TEACH_TAPS = 3;
function startTeaching() {
  if (!state.started) { setStatus('Press Start first, then teach your fingers.'); return; }
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
  for (let m = low; m <= high; m++) {
    if (isBlack(m)) continue;
    const x = (whiteIndex(m) - w0) * kw;
    const on = state.active.has(m);
    g.fillStyle = on ? '#4fa3ff' : '#f4f4f0';
    g.fillRect(x + 1, 0, kw - 2, H - 2);
    g.fillStyle = on ? '#fff' : m === 60 ? '#c00' : '#888';
    g.font = `${m === 60 ? 'bold ' : ''}${Math.max(9, Math.min(13, kw * 0.38))}px system-ui`;
    g.textAlign = 'center';
    g.fillText(noteName(m), x + kw / 2, H - 8);
  }
  for (let m = low; m <= high; m++) {
    if (!isBlack(m)) continue;
    const x = (whiteIndex(m) - w0 + 1) * kw - kw * 0.3;
    g.fillStyle = state.active.has(m) ? '#4fa3ff' : '#111';
    g.fillRect(x, 0, kw * 0.6, H * 0.6);
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
  if (settings.mode === 'desk' && settings.desk && settings.desk.c4) {
    g.fillStyle = '#ffcc33';
    for (const p of [settings.desk.c4, settings.desk.c5].filter(Boolean)) { g.beginPath(); g.arc(X(p.x), p.y, 8, 0, 7); g.fill(); }
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
    `engine ${settings.engine}: taps ${fusion.stats.taps}, rejected (no finger) ${fusion.stats.tapsRejected}, notes ${fusion.stats.notes}`,
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
  // hands busy for a while but no taps heard → the mic is probably too far away or too insensitive
  const now = performance.now();
  if (state.hands.length) { if (!state.handsSince) state.handsSince = now; } else state.handsSince = 0;
  if (state.micNode && state.handsSince && now - state.handsSince > 10000 && (lastTap == null || lastTap > 10)) {
    rows.push('<span class="no">!</span><span>I can see your hands but can’t hear any taps. Tap more firmly, move the microphone closer to the paper (or pick another one in Settings → Devices), or raise Tap sensitivity.</span>');
  }
  if (settings.mode === 'paper') tick(state.markersSeen.size === state.layout.markers.length, `Paper markers: ${state.markersSeen.size} of ${state.layout.markers.length}`);
  else tick(!!(settings.desk && settings.desk.c5), 'Desk calibrated <button id="calibBtn">Calibrate</button> <button id="recentreBtn">Recentre</button>');
  const html = rows.join('');
  if (el.dataset.html !== html) {
    el.innerHTML = html; el.dataset.html = html;
    if ($('calibBtn')) $('calibBtn').onclick = startCalibration;
    if ($('recentreBtn')) $('recentreBtn').onclick = recentre;
  }
}

function loop() {
  fusion.tick(performance.now());
  if (state.paperH && performance.now() - state.paperSeen > 20000) { state.paperH = null; state.paperInv = null; }
  drawOverlay();
  if (settings.debug) drawDebug();
  updateChecks();
  drawRoll();
  // mic level bar: dB relative to the background noise, so quiet far-away mics still show taps
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
  const nextEngine = engines[settings.engine] || engines.tap;
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

function bindSettings() {
  const form = $('settings').querySelector('form');
  for (const [id, label] of Object.entries(INSTRUMENTS)) form.elements.instrument.add(new Option(label, id));
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name]; else el.value = settings[el.name];
    el.addEventListener('change', () => {
      const prevOutput = settings.output, prevCam = settings.camera, prevMic = settings.mic;
      settings[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
      applySettings();
      if (el.name === 'mode' && settings.mode === 'desk' && !(settings.desk && settings.desk.c5)) startCalibration();
      if ((settings.output !== prevOutput || settings.mic !== prevMic) && state.micNode) startMic().catch((e) => setStatus(`Microphone: ${e.message}`));
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
    saveSettings(settings);
  });
  $('setupBtn').onclick = () => setSetup(true);
  $('setupDone').onclick = () => setSetup(false);
  $('teachBtn').onclick = startTeaching;
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
  $('forgetBtn').onclick = () => { settings.fingerTemplates = null; engines.tap.resolver.templates = null; saveSettings(settings); setStatus('Taught finger patterns forgotten.'); };
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
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) { state.pedalKey = true; updatePedal(); } return; }
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.repeat) { state.kbdOctave = Math.max(-3, state.kbdOctave - 1); drawPiano(); return; }
    if (k === 'r' && !e.repeat && settings.mode === 'desk') { recentre(); return; }
    if (k === 'x' && !e.repeat) { state.kbdOctave = Math.min(3, state.kbdOctave + 1); drawPiano(); return; }
    if (!(k in KEYMAP) || e.repeat || kbdDown.has(k)) return;
    ensureAudio();
    const midi = 60 + state.kbdOctave * 12 + KEYMAP[k] + settings.transpose;
    const vel = e.shiftKey ? 0.95 : e.ctrlKey ? 0.25 : 0.6;
    kbdDown.set(k, midi);
    noteOn(midi, vel, { how: 'keyboard' });
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { state.pedalKey = false; updatePedal(); return; }
    const k = e.key.toLowerCase();
    if (kbdDown.has(k)) { noteOff(kbdDown.get(k)); kbdDown.delete(k); }
  });
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
  try { await startMic(); } catch (e) { problems.push('microphone'); console.warn('mic', e); }
  try { await startCamera(); } catch (e) { problems.push('camera'); console.warn('camera', e); $('camMsg').textContent = 'No camera'; }
  state.started = true;
  $('start').textContent = 'Running';
  keepAwake();
  applySettings();
  setStatus(problems.length ? `Could not start the ${problems.join(' and ')}. You can still play with the computer keyboard.` : 'Ready – tap your fingers on the paper keys. Nothing is recorded or uploaded.');
  if (settings.mode === 'desk' && !(settings.desk && settings.desk.c5)) startCalibration();
}

// keep the phone screen on while playing
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.started) keepAwake(); });

// offline support (not in ?sim test mode)
if ('serviceWorker' in navigator && !SIM && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* fine without it */ });
}

$('start').onclick = start;
if (!loadSettings().seenSetup && !SIM) { settings.seenSetup = true; saveSettings(settings); setSetup(true, false); }
bindSettings();
bindKeys();
applySettings();
requestAnimationFrame(loop);

// Test/debug hooks (synthetic data only).
window.deskPiano = {
  state, settings, get fusion() { return fusion; }, engines, strikes,
  ensureAudio,
  injectHandFrame: (frame) => handleHandFrame(frame),
  injectTap: (tap) => handleTap(tap),
  injectMarkers: (found) => updatePaperFromMarkers(found, 1),
  setVideoSize: (w, h) => { state.video = { w, h }; },
  keyForPoint,
  startCalibration, recentre, startTeaching,
  applySettings,
};
