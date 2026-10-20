// Desk Piano main app: wires camera → hand tracking → strikes, microphone → taps, and the
// fusion of the two → piano sound. Everything runs on this device; no audio or video is
// stored or sent anywhere.
import { Piano } from './piano.js';
import { SYNTHS, INSTRUMENTS } from './synths.js';
import { StrikeDetector } from './strike.js';
import { Fusion } from './fusion.js';
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
  latencies: [], lastLatency: null, tapMsgDelays: [],
  played: [], // log for tests/debug: {midi, vel, how, t}
  active: new Map(), // midi → count of sources holding it (for the on-screen keyboard)
  pedalKey: false, pedalButton: false,
  calib: null, // plain desk calibration step: 'c4' | 'c5' | null
  kbdOctave: 0,
  video: { w: 0, h: 0 },
};

const strikes = new StrikeDetector();
const velocityMap = new VelocityMapper(settings.sensitivity);
const fusion = new Fusion({
  keyFor: (f) => keyForPoint(f.x, f.y),
  play: (midi, vel, info) => noteOn(midi, vel, info),
  stop: (midi) => noteOff(midi),
});

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
}

function noteOn(midi, vel, info = {}) {
  if (midi == null || midi < 21 || midi > 108) return;
  state.active.set(midi, (state.active.get(midi) || 0) + 1);
  const entry = { midi, name: noteName(midi), vel: Math.round(vel * 100) / 100, how: info.how || 'keyboard', t: performance.now() };
  state.played.push(entry);
  if (state.played.length > 500) state.played.shift();
  if (state.inst) state.inst.noteOn(midi, vel);
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
  if (state.inst) state.inst.noteOff(midi);
  drawPiano();
}

// ---------------------------------------------------------------- audio
const synthCache = {};
function selectInstrument(id) {
  if (!state.ctx) return;
  const prev = state.inst;
  if (id !== 'piano' && SYNTHS[id]) state.inst = synthCache[id] || (synthCache[id] = new SYNTHS[id](state.ctx));
  else state.inst = state.piano;
  if (prev && prev !== state.inst) prev.allOff();
  state.inst.setVolume(settings.volume);
  state.inst.setSustain(pedalDown());
}

async function startAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  state.ctx = new AC({ latencyHint: 'interactive' });
  await state.ctx.resume();
  state.piano = new Piano(state.ctx);
  state.piano.setVolume(settings.volume);
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
    if (d.type === 'level') { state.micLevel = d.level; state.micHistory.push(d.level); if (state.micHistory.length > 150) state.micHistory.shift(); return; }
    if (d.type === 'onset') {
      // the worklet tells us the audio clock now (d.now) and at the onset (d.time); the
      // message hop to this thread is ~1 ms, so the tap happened about this long ago:
      const t = performance.now() - (d.now - d.time) * 1000;
      // how long the tap took to reach the main thread (worklet block + message hop)
      state.tapMsgDelays.push((d.now - d.time) * 1000);
      if (state.tapMsgDelays.length > 50) state.tapMsgDelays.shift();
      handleTap({ t: t - state.inputLatencyMs, peak: d.peak, floor: d.floor });
    }
  };
  state.micNode = node;
  fusion.speakerMode = speaker;
}

function stopMic() {
  if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
  if (state.micNode) { try { state.micNode.disconnect(); } catch { /* ignore */ } state.micNode.port.onmessage = null; }
  state.micStream = null; state.micNode = null;
}

function handleTap({ t, peak, floor, velocity }) {
  const vel = velocity ?? velocityMap.map(peak, floor);
  state.tapMarks.push({ t, vel });
  if (state.tapMarks.length > 40) state.tapMarks.shift();
  if (state.calib) return; // calibration taps are handled from the camera landing
  const played = fusion.onTap({ t, velocity: vel }, strikes);
  // learn the loudness range only from taps that really were notes (not talking or knocks)
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
      try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }
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
    try { res = landmarker.detectForVideo(video, t); } catch (err) { console.warn('hand tracking frame skipped', err); return; }
    const hands = handIds.assign((res.landmarks || []).map((lm) => ({
      points: lm.map((p) => ({ x: p.x * state.video.w, y: p.y * state.video.h })),
    })));
    handleHandFrame({ t, hands });
  }
}

function handleHandFrame(frame) {
  state.hands = frame.hands;
  state.handsT = frame.t;
  const events = strikes.update(frame);
  if (state.calib) { calibrationEvents(events); return; }
  fusion.onStrikeEvents(events, strikes);
  fusion.tick(performance.now());
}

function findPaper(video) {
  if (!video.videoWidth) return;
  const scale = Math.min(1, 960 / video.videoWidth);
  const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
  detCanvas.width = w; detCanvas.height = h;
  const c = detCanvas.getContext('2d', { willReadFrequently: true });
  c.drawImage(video, 0, 0, w, h);
  const img = c.getImageData(0, 0, w, h);
  const found = detectMarkers(toGrey(img.data, w, h), w, h);
  updatePaperFromMarkers(found, 1 / scale);
}

function updatePaperFromMarkers(found, scale = 1) {
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
function calibrationEvents(events) {
  const land = events.find((e) => e.type === 'land');
  if (!land) return;
  const p = { x: land.x, y: land.y };
  if (state.calib === 'c4') { settings.desk = { c4: p }; state.calib = 'c5'; showCalib('Now tap the <b>C above</b> middle C.'); }
  else if (state.calib === 'c5') { settings.desk.c5 = p; finishCalib('Calibrated – play away!'); }
  else if (state.calib === 'recentre') {
    const dx = p.x - settings.desk.c4.x, dy = p.y - settings.desk.c4.y;
    settings.desk = { c4: p, c5: { x: settings.desk.c5.x + dx, y: settings.desk.c5.y + dy } };
    finishCalib('Recentred.');
  }
}
function finishCalib(msg) { state.calib = null; saveSettings(settings); showCalib(msg); setTimeout(() => { if (!state.calib) $('calib').hidden = true; }, 2500); }
function showCalib(html) {
  const el = $('calib');
  el.hidden = false;
  el.innerHTML = `${html} <button id="calibCancel">Cancel</button>`;
  $('calibCancel').onclick = () => { state.calib = null; el.hidden = true; };
}

// ---------------------------------------------------------------- drawing
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
  const X = (x) => (settings.mirror ? vw - x : x);
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
      const f = strikes.fingers.get(`${hand.label}-${tip}`);
      const p = pts[tip];
      g.fillStyle = f && f.down ? '#ff5050' : f && f.descending ? '#ffcc33' : '#ffffff';
      g.beginPath(); g.arc(X(p.x), p.y, f && f.down ? 9 : 6, 0, 7); g.fill();
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
    `audio out: base ${fmt(state.ctx && state.ctx.baseLatency * 1000)} ms, output ${fmt(state.ctx && state.ctx.outputLatency * 1000)} ms, input ${fmt(state.inputLatencyMs)} ms`,
    `tap→sound: last ${fmt(state.lastLatency)} ms, average ${fmt(avg)} ms (${lat.length} taps)`,
    `taps ${fusion.stats.taps}, rejected (no finger) ${fusion.stats.tapsRejected}, camera-only ${fusion.stats.cameraOnly}, notes ${fusion.stats.notes}`,
    `paper markers: ${[...state.markersSeen].join(',') || 'none'}`,
    `fingers: ${fingers.join('  ')}`,
    `last notes: ${state.played.slice(-8).map((p) => `${p.name}(${p.vel},${p.how})`).join(' ')}`,
  ].join('\n');
}
const fmt = (v) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(1));

function updateChecks() {
  const el = $('checks');
  const rows = [];
  const tick = (ok, label) => rows.push(`<span class="${ok ? 'ok' : 'no'}">${ok ? '✔' : '✘'}</span><span>${label}</span>`);
  tick(state.piano && state.piano.loaded, 'Piano sound loaded');
  tick(!!state.micNode, 'Microphone listening');
  tick(state.video.w > 0, 'Camera on');
  tick(state.hands.length >= 2, `Hands found: ${state.hands.length} of 2`);
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
  if (state.paperH && performance.now() - state.paperSeen > 4000) { state.paperH = null; state.paperInv = null; }
  drawOverlay();
  if (settings.debug) drawDebug();
  updateChecks();
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
  $('camWrap').classList.toggle('mirror', !!settings.mirror);
  $('hint').hidden = settings.output !== 'speaker' && state.started;
  fusion.speakerMode = settings.output === 'speaker';
  velocityMap.sensitivity = settings.sensitivity;
  if (state.micNode) state.micNode.port.postMessage({ type: 'options', options: { sensitivity: settings.sensitivity } });
  updatePedal();
  drawPiano();
  saveSettings(settings);
}

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
      if ((settings.output !== prevOutput || settings.mic !== prevMic) && state.started) startMic().catch((e) => setStatus(`Microphone: ${e.message}`));
      if (settings.camera !== prevCam && state.started) startCamera().catch((e) => setStatus(`Camera: ${e.message}`));
    });
  }
  $('settingsBtn').onclick = () => $('settings').showModal();
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

$('start').onclick = start;
if (!loadSettings().seenSetup && !SIM) { settings.seenSetup = true; saveSettings(settings); setSetup(true, false); }
bindSettings();
bindKeys();
applySettings();
requestAnimationFrame(loop);

// Test/debug hooks (synthetic data only).
window.deskPiano = {
  state, settings, fusion, strikes,
  ensureAudio,
  injectHandFrame: (frame) => handleHandFrame(frame),
  injectTap: (tap) => handleTap(tap),
  injectMarkers: (found) => updatePaperFromMarkers(found, 1),
  setVideoSize: (w, h) => { state.video = { w, h }; },
  keyForPoint,
  startCalibration, recentre,
  applySettings,
};
