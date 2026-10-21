// End-to-end tests in headless Chromium with a FAKE camera and FAKE microphone.
// Synthetic hand movements and taps are injected through window.deskPiano.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';
import { paperLayout, markerCorners } from '../src/paper.js';
import { fitHomography, applyH } from '../src/homography.js';
import { sceneHomography } from './synth.mjs';
import { makeFakeCameraY4M } from './fake-camera.mjs';
import { rmSync } from 'node:fs';

const { url, close } = await startServer();
const browser = await chromium.launch({
  args: ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
let failures = 0;
async function check(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  // MediaPipe prints harmless 'INFO:' lines through console.error
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await fn(page);
    assert.deepEqual(errors, [], 'no console errors');
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`not ok - ${name}\n  ${String(e.message).split('\n').join('\n  ')}`);
  }
  await ctx.close();
}

async function startApp(page, query = '') {
  await page.goto(url + 'index.html' + query);
  await page.click('#start');
  await page.waitForFunction(() => window.deskPiano.state.piano && window.deskPiano.state.piano.loaded, null, { timeout: 30000 });
  await page.waitForFunction(() => window.deskPiano.state.video.w > 0, null, { timeout: 30000 });
}

await check('page loads, starts with fake camera + mic, set-up and settings work', async (page) => {
  await startApp(page);
  const checks = await page.textContent('#checks');
  assert.match(checks, /Piano sound loaded/);
  assert.match(checks, /Microphone/);
  await page.click('#setupBtn');
  assert.ok(await page.isVisible('#setupPanel'));
  await page.click('#setupDone');
  assert.ok(!(await page.isVisible('#setupPanel')));
  await page.click('#settingsBtn');
  await page.selectOption('select[name=output]', 'speaker');
  await page.check('input[name=debug]');
  await page.click('#settings button[value=close]');
  assert.equal(await page.evaluate(() => window.deskPiano.settings.output), 'speaker');
  // the microphone restarts with echo cancellation on, without a reload
  await page.waitForFunction(() => window.deskPiano.state.micNode && window.deskPiano.state.micStream.getAudioTracks()[0].getSettings().echoCancellation === true, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.deskPiano.fusion.speakerMode), true);
  assert.ok(await page.isVisible('#debug'));
});

await check('works offline after the first visit (service worker)', async (page) => {
  await page.goto(url + 'index.html');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the service worker
  await page.keyboard.press('KeyA'); // loads the piano samples through the cache
  await page.waitForFunction(() => window.deskPiano.state.piano && window.deskPiano.state.piano.loaded, null, { timeout: 30000 });
  await page.context().setOffline(true);
  await page.reload();
  assert.equal(await page.title(), 'Desk Piano');
  await page.keyboard.press('KeyA');
  await page.waitForFunction(() => window.deskPiano.state.piano && window.deskPiano.state.piano.loaded, null, { timeout: 30000 });
  await page.context().setOffline(false);
});

await check('every sound renders: audible, no clipping spike, no broken samples', async (page) => {
  await page.goto(url + 'index.html?sim=1');
  const res = await page.evaluate(async () => {
    const { Piano } = await import('./src/piano.js');
    const { SYNTHS } = await import('./src/synths.js');
    const out = {};
    for (const id of ['piano', 'honky', ...Object.keys(SYNTHS)]) {
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const inst = id === 'piano' || id === 'honky' ? new Piano(ctx, ctx.destination) : new SYNTHS[id](ctx, ctx.destination);
      if (id === 'honky') inst.detunes = [-11, 11];
      if (!SYNTHS[id]) await inst.load('samples/piano/');
      inst.noteOn(60, 0.6);
      const d = (await ctx.startRendering()).getChannelData(0);
      let peak = 0, sum = 0, bad = 0;
      for (const v of d) { if (!Number.isFinite(v)) bad++; peak = Math.max(peak, Math.abs(v)); sum += v * v; }
      out[id] = { peak, rmsDb: 10 * Math.log10(sum / d.length), bad };
    }
    // polyphony limit: 100 notes with the pedal down leave at most 48 sounding
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const p = new Piano(ctx, ctx.destination);
    await p.load('samples/piano/');
    p.setSustain(true);
    for (let i = 0; i < 100; i++) { p.noteOn(40 + (i % 50), 0.5, i * 0.005); p.noteOff(40 + (i % 50)); }
    let live = 0;
    for (const list of p.voices.values()) for (const v of list) if (!v.released) live++;
    out.live = live;
    return out;
  });
  assert.equal(res.live, 48, 'polyphony limit');
  assert.ok(Math.abs(res.honky.rmsDb - res.piano.rmsDb) < 2, `honky-tonk level ${res.honky.rmsDb.toFixed(1)} vs piano ${res.piano.rmsDb.toFixed(1)} dB`);
  delete res.live;
  for (const [id, r] of Object.entries(res)) {
    assert.equal(r.bad, 0, `${id}: broken samples`);
    assert.ok(r.rmsDb > -50 && r.rmsDb < -15, `${id}: level ${r.rmsDb.toFixed(1)} dB`);
    assert.ok(r.peak < 0.8, `${id}: peak ${r.peak.toFixed(2)}`);
  }
});

await check('print page renders sheets with markers', async (page) => {
  await page.goto(url + 'print.html');
  assert.equal(await page.locator('.sheet').count(), paperLayout('full').pages.length);
  await page.goto(url + 'print.html?size=compact');
  assert.equal(await page.locator('.sheet').count(), paperLayout('compact').pages.length);
});

await check('computer keyboard plays notes with the pedal', async (page) => {
  await page.goto(url + 'index.html');
  await page.keyboard.down('a');
  await page.waitForFunction(() => window.deskPiano.state.played.length > 0, null, { timeout: 20000 });
  await page.keyboard.up('a');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Shift');
  await page.keyboard.down('Space');
  assert.equal(await page.getAttribute('#pedal', 'aria-pressed'), 'true');
  await page.keyboard.up('Space');
  const played = await page.evaluate(() => window.deskPiano.state.played.map((p) => [p.name, p.vel]));
  assert.equal(played[0][0], 'C4');
  assert.equal(played[1][0], 'C5');
  assert.ok(played[1][1] > played[0][1], 'shift = louder');
  // every sound plays without errors
  const ids = await page.evaluate(() => [...document.querySelector('select[name=instrument]').options].map((o) => o.value));
  assert.ok(ids.length >= 7, ids.join());
  for (const id of ids) {
    await page.evaluate((v) => { const s = document.querySelector('select[name=instrument]'); s.value = v; s.dispatchEvent(new Event('change')); }, id);
    await page.keyboard.down('KeyG'); await page.waitForTimeout(120); await page.keyboard.up('KeyG');
  }
  await page.evaluate(() => { const s = document.querySelector('select[name=instrument]'); s.value = 'piano'; s.dispatchEvent(new Event('change')); });
  // layering piano + strings
  await page.evaluate(() => { const s = document.querySelector('select[name=layer]'); s.value = 'strings'; s.dispatchEvent(new Event('change')); });
  await page.keyboard.down('KeyH'); await page.waitForTimeout(120); await page.keyboard.up('KeyH');
  assert.ok(await page.evaluate(() => !!window.deskPiano.state.layer));
  await page.evaluate(() => { const s = document.querySelector('select[name=layer]'); s.value = ''; s.dispatchEvent(new Event('change')); });
  // split: bass below middle C
  await page.evaluate(() => { const s = document.querySelector('select[name=split]'); s.value = 'bass'; s.dispatchEvent(new Event('change')); });
  await page.keyboard.press('KeyZ'); // octave down → C3..
  await page.keyboard.down('KeyA'); await page.waitForTimeout(120); await page.keyboard.up('KeyA');
  await page.keyboard.press('KeyX');
  assert.ok(await page.evaluate(() => !!window.deskPiano.state.split));
  await page.evaluate(() => { const s = document.querySelector('select[name=split]'); s.value = ''; s.dispatchEvent(new Event('change')); });
  // metronome on and off
  await page.click('#metroBtn');
  await page.waitForFunction(() => document.getElementById('metroBtn').getAttribute('aria-pressed') === 'true');
  await page.waitForTimeout(800);
  await page.click('#metroBtn');
  assert.equal(await page.getAttribute('#metroBtn', 'aria-pressed'), 'false');
  // record → play back → save
  await page.click('#recBtn');
  await page.keyboard.press('KeyD');
  await page.waitForTimeout(150);
  await page.click('#recBtn');
  assert.ok(await page.isVisible('#playBtn'));
  const n0 = await page.evaluate(() => window.deskPiano.state.played.length);
  await page.click('#playBtn');
  await page.waitForFunction((n) => window.deskPiano.state.played.length > n, n0, { timeout: 5000 });
  const last = await page.evaluate(() => window.deskPiano.state.played.slice(-1)[0]);
  assert.equal(last.name, 'E4');
  assert.equal(last.how, 'playback');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#saveBtn')]);
  assert.match(download.suggestedFilename(), /\.mid$/);
});

// Synthetic paper + hands: build a camera view of the paper, inject the markers the camera
// "sees", then move fake fingertips onto chosen keys and tap.
const L = paperLayout('full');
const W = 1280, H = 720;
const sc = sceneHomography(L, W, H, { tilt: 0.35, rotate: 0.05 });
const Hp = fitHomography(sc.src, sc.dst);
const known = markerCorners(L);
const markers = L.markers.map((m) => ({ id: m.id, corners: known[m.id].map((p) => applyH(Hp, p.x, p.y)) }));
const Lc = paperLayout('compact');
const scC = sceneHomography(Lc, W, H, { tilt: 0.35, rotate: 0.05 });
const HpC = fitHomography(scC.src, scC.dst);
const knownC = markerCorners(Lc);
const compactMarkers = Lc.markers.map((m) => ({ id: m.id, corners: knownC[m.id].map((p) => applyH(HpC, p.x, p.y)) }));
const keyPoint = (midi) => {
  const r = L.kb.keyRect(midi);
  return applyH(Hp, L.keysX + (r.x0 + r.x1) / 2, L.keysY + (r.black ? 60 : 125));
};

await check('a note held by two sources lasts until both let go; cancelling a re-calibration keeps the old one', async (page) => {
  await startApp(page, '?sim=1');
  const r = await page.evaluate(() => {
    const dp = window.deskPiano;
    dp.noteOn(64, 0.5, { how: 'tap' }); dp.noteOn(64, 0.5, { how: 'keyboard' });
    dp.noteOff(64);
    const still = dp.state.active.has(64) && [...dp.state.inst.voices.get(64) || []].some((v) => !v.released);
    dp.noteOff(64);
    const gone = !dp.state.active.has(64);
    dp.settings.desk = { c4: { x: 100, y: 300 }, c5: { x: 300, y: 300 } };
    dp.startCalibration();
    document.getElementById('calibCancel').click();
    return { still, gone, desk: JSON.stringify(dp.settings.desk) };
  });
  assert.ok(r.still, 'still sounding while one source holds it');
  assert.ok(r.gone);
  assert.equal(r.desk, JSON.stringify({ c4: { x: 100, y: 300 }, c5: { x: 300, y: 300 } }));
});

await check('personal tuning: applied to the engine, forgotten by Forget; a check with no data just reports', async (page) => {
  await startApp(page, '?sim=1');
  const r = await page.evaluate(async () => {
    const dp = window.deskPiano;
    const o = dp.engines.tap.resolver.o;
    const before = o.minLate;
    dp.settings.tuned = { minLate: 0.02 };
    dp.applySettings();
    const tuned = o.minLate;
    document.getElementById('forgetBtn').click();
    const after = o.minLate;
    // an accuracy check where taps were heard but nothing useful was seen
    dp.startCheck();
    for (let i = 0; i < 6; i++) dp.state.check.rec.taps.push({ t: performance.now() - 1000 + i * 100, velocity: 0.5 });
    dp.state.check.got.push(62, 64);
    dp.finishCheck();
    await new Promise((res) => setTimeout(res, 300));
    return { before, tuned, after, saved: dp.settings.tuned, msg: document.getElementById('calib').textContent };
  });
  assert.deepEqual([r.tuned, r.after, r.saved], [0.02, r.before, null], JSON.stringify(r));
  assert.match(r.msg, /Accuracy check: 2 of 9/);
});

await check('follow a tune: the next key lights up and advances on the right note', async (page) => {
  await startApp(page, '?sim=1');
  await page.selectOption('#tuneSel', { label: 'Mary had a little lamb' });
  assert.match(await page.textContent('#tuneProg'), /^0 \/ 26/);
  for (const k of ['KeyD', 'KeyS', 'KeyA', 'KeyG']) { await page.keyboard.press(k); await page.waitForTimeout(60); } // E D C, then a wrong F
  assert.match(await page.textContent('#tuneProg'), /^3 \/ 26 · 1 wrong/);
  assert.equal(await page.evaluate(() => window.deskPiano.state.tune.next), 62);
});

await check('taps + finger strikes on the paper play the right notes, chords and loudness', async (page) => {
  await startApp(page, '?sim=1');
  const result = await page.evaluate(async ({ markers, plan, W, H }) => {
    const dp = window.deskPiano;
    dp.settings.chords = true; // the plan includes a chord
    dp.applySettings();
    dp.setVideoSize(W, H);
    dp.injectMarkers(markers);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // hand: 21 points; we place fingertips explicitly, other points near the knuckles
    // knuckles stay put above each finger's resting key; only the tips move
    const MCP = { 4: 2, 8: 5, 12: 9, 16: 13, 20: 17 };
    const hand = (label, tips, base) => {
      const pts = Array.from({ length: 21 }, () => ({ x: base[12].x, y: base[12].y - 120 }));
      pts[0] = { x: base[12].x, y: base[12].y - 190 };
      for (const k of [4, 8, 12, 16, 20]) { pts[k] = tips[k]; pts[MCP[k]] = { x: base[k].x, y: base[k].y - 120 }; }
      return { label, points: pts };
    };
    for (const step of plan) {
      // fingers rest 40 px up the picture, the pressing ones come down over ~100 ms
      const t0 = performance.now();
      for (let f = 0; f <= 8; f++) {
        const t = t0 + f * 33;
        const tips = {};
        for (const [k, p] of Object.entries(step.base)) {
          const pressing = step.press.includes(Number(k));
          const lift = pressing ? Math.max(0, 40 - f * 10) : 40;
          tips[k] = { x: p.x, y: p.y - lift };
        }
        // the tap is heard as the fingers reach the paper
        if (f === 4 && step.tapPeak) dp.injectTap({ t: performance.now(), peak: step.tapPeak });
        dp.injectHandFrame({ t: performance.now(), hands: [hand('Right', tips, step.base)] });
        await sleep(33);
      }
      // lift all
      for (let f = 0; f < 3; f++) {
        const tips = {};
        for (const [k, p] of Object.entries(step.base)) tips[k] = { x: p.x, y: p.y - (step.press.includes(Number(k)) ? 40 * (f + 1) / 3 : 40) };
        dp.injectHandFrame({ t: performance.now(), hands: [hand('Right', tips, step.base)] });
        await sleep(33);
      }
      await sleep(250);
    }
    return dp.state.played.map((p) => ({ name: p.name, vel: p.vel, how: p.how, t: Math.round(p.t), f: dp.fusion.log.find((l) => Math.abs(l.t - p.t) < 1)?.fingerId }));
  }, {
    markers, W, H,
    plan: [
      // single notes: C4 soft then E4 loud
      { base: { 4: keyPoint(60), 8: keyPoint(62), 12: keyPoint(64), 16: keyPoint(65), 20: keyPoint(67) }, press: [4], tapPeak: 0.01 },
      { base: { 4: keyPoint(60), 8: keyPoint(62), 12: keyPoint(64), 16: keyPoint(65), 20: keyPoint(67) }, press: [12], tapPeak: 0.4 },
      // chord C-E-G
      { base: { 4: keyPoint(60), 8: keyPoint(62), 12: keyPoint(64), 16: keyPoint(65), 20: keyPoint(67) }, press: [4, 12, 20], tapPeak: 0.1 },
      // black key F#4
      { base: { 4: keyPoint(60), 8: keyPoint(66), 12: keyPoint(64), 16: keyPoint(65), 20: keyPoint(67) }, press: [8], tapPeak: 0.1 },
      // a tap with nothing moving → nothing
      { base: { 4: keyPoint(60), 8: keyPoint(66), 12: keyPoint(64), 16: keyPoint(65), 20: keyPoint(67) }, press: [], tapPeak: 0.3 },
    ],
  });
  const names = result.map((r) => r.name);
  assert.deepEqual(names.slice(0, 2), ['C4', 'E4'], JSON.stringify(result));
  assert.deepEqual(names.slice(2, 5).sort(), ['C4', 'E4', 'G4'], JSON.stringify(result));
  // the accuracy check counts tap-played notes in order
  const check = await page.evaluate(async () => {
    const dp = window.deskPiano;
    dp.startCheck();
    return !!dp.state.check;
  });
  assert.ok(check);
  assert.equal(names[5], 'F#4', JSON.stringify(result));
  assert.equal(names.length, 6, 'the tap with no finger movement added nothing: ' + JSON.stringify(result));
  assert.ok(result[1].vel > result[0].vel, 'louder tap → louder note');
  assert.ok(result.every((r) => r.how.startsWith('tap') || r.how.startsWith('land')), JSON.stringify(result));
});

await check('switches to the 2-octave paper when the camera sees it', async (page) => {
  await startApp(page, '?sim=1');
  const r = await page.evaluate((markers) => {
    const dp = window.deskPiano;
    dp.setVideoSize(1280, 720);
    for (let i = 0; i < 6; i++) dp.injectMarkers(markers);
    return { size: dp.settings.paperSize, form: document.querySelector('select[name=paperSize]').value, status: document.getElementById('status').textContent };
  }, compactMarkers);
  assert.deepEqual([r.size, r.form], ['compact', 'compact'], JSON.stringify(r));
  assert.match(r.status, /2-octave/);
});

await check('no microphone: falls back to playing clear finger strikes from the camera', async (page) => {
  // the microphone is refused; the camera still works
  await page.addInitScript(() => {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => (c && c.audio ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : gum(c));
  });
  await startApp(page, '?sim=1');
  assert.match(await page.textContent('#status'), /camera alone/);
  const result = await page.evaluate(async ({ markers, W, H, base }) => {
    const dp = window.deskPiano;
    dp.setVideoSize(W, H);
    dp.injectMarkers(markers);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const MCP = { 4: 2, 8: 5, 12: 9, 16: 13, 20: 17 };
    const hand = (tips) => {
      const pts = Array.from({ length: 21 }, () => ({ x: base[12].x, y: base[12].y - 120 }));
      pts[0] = { x: base[12].x, y: base[12].y - 190 };
      for (const k of [4, 8, 12, 16, 20]) { pts[k] = tips[k]; pts[MCP[k]] = { x: base[k].x, y: base[k].y - 120 }; }
      return { label: 'Right', points: pts };
    };
    for (const press of [4, 12]) {
      for (let f = 0; f <= 10; f++) {
        const tips = {};
        for (const [k, p] of Object.entries(base)) tips[k] = { x: p.x, y: p.y - (Number(k) === press ? Math.max(0, 40 - f * 10) : 40) };
        dp.injectHandFrame({ t: performance.now(), hands: [hand(tips)] });
        await sleep(33);
      }
      for (let f = 0; f < 3; f++) {
        const tips = {};
        for (const [k, p] of Object.entries(base)) tips[k] = { x: p.x, y: p.y - 40 };
        dp.injectHandFrame({ t: performance.now(), hands: [hand(tips)] });
        await sleep(33);
      }
      await sleep(250);
    }
    return { engine: dp.fusion === dp.engines.classic, played: dp.state.played.map((p) => p.name), hover: dp.state.hover.length };
  }, { markers, W, H, base: { 4: keyPoint(60), 8: keyPoint(62), 12: keyPoint(64), 16: keyPoint(65), 20: keyPoint(67) } });
  assert.ok(result.engine, 'classic engine in use');
  assert.deepEqual(result.played, ['C4', 'E4'], JSON.stringify(result));
  assert.equal(result.hover, 5, 'a dot on the on-screen keyboard for each fingertip');
});

await check('plain desk mode: calibrate on C4 and C5, then play by position', async (page) => {
  await startApp(page, '?sim=1');
  const names = await page.evaluate(async () => {
    const dp = window.deskPiano;
    dp.settings.mode = 'desk';
    dp.applySettings();
    dp.startCalibration();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hand = (x, y) => {
      const pts = Array.from({ length: 21 }, () => ({ x, y: y - 60 }));
      pts[0] = { x, y: y - 160 }; pts[9] = { x, y: y - 90 };
      pts[4] = { x: x - 200, y: y - 30 }; pts[12] = { x: x + 30, y: y - 30 }; pts[16] = { x: x + 60, y: y - 30 }; pts[20] = { x: x + 90, y: y - 30 };
      pts[8] = { x, y };
      return pts;
    };
    let cur = null;
    async function strike(x, y, tap) {
      // move the hand there smoothly first (hands don't teleport)
      if (cur) {
        for (let f = 1; f <= 20; f++) {
          const pts = hand(cur.x + (x - cur.x) * f / 20, cur.y + (y - cur.y) * f / 20);
          pts[8] = { x: pts[8].x, y: pts[8].y - 30 };
          dp.injectHandFrame({ t: performance.now(), hands: [{ label: 'Right', points: pts }] });
          await sleep(33);
        }
      }
      cur = { x, y };
      for (let f = 0; f <= 6; f++) {
        const pts = hand(x, y);
        pts[8] = { x, y: y - Math.max(0, 30 - f * 10) };
        if (tap && f === 3) dp.injectTap({ t: performance.now(), peak: 0.1 });
        dp.injectHandFrame({ t: performance.now(), hands: [{ label: 'Right', points: pts }] });
        await sleep(33);
      }
      for (let f = 1; f <= 3; f++) {
        const pts = hand(x, y); pts[8] = { x, y: y - f * 10 };
        dp.injectHandFrame({ t: performance.now(), hands: [{ label: 'Right', points: pts }] });
        await sleep(33);
      }
      await sleep(200);
    }
    await strike(400, 400, false); // calibration: middle C
    await strike(750, 400, false); // calibration: C5 (350 px = one octave → 50 px per white key)
    document.getElementById('calibSkip').click(); // skip the optional third (C6) tap
    await strike(400 + 2 * 50, 400, true); // E4
    await strike(400 + 4 * 50, 400, true); // G4
    await strike(400 + 3.5 * 50 - 6, 400 + 60, true); // further forward (towards the camera) between F and G = F#4
    return dp.state.played.map((p) => p.name).concat([JSON.stringify(dp.settings.desk)]);
  });
  const cal = names.pop();
  assert.deepEqual(names, ['E4', 'G4', 'F#4'], cal);
  // same camera at twice the resolution: the same spot maps to the same key; rotated → no key
  const k = await page.evaluate(() => {
    const dp = window.deskPiano;
    const { w, h } = dp.state.video;
    const before = dp.keyForPoint(500, 400);
    dp.setVideoSize(w * 2, h * 2);
    const scaled = dp.keyForPoint(1000, 800);
    dp.setVideoSize(h, w);
    const turned = dp.keyForPoint(500, 400);
    dp.setVideoSize(w, h);
    return { before, scaled, turned };
  });
  assert.deepEqual(k, { before: 64, scaled: 64, turned: null }, JSON.stringify(k));
});

await check('teach my fingers: five fingers × three taps are learnt and saved', async (page) => {
  await startApp(page, '?sim=1');
  const res = await page.evaluate(async () => {
    const dp = window.deskPiano;
    dp.startTeaching();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const MCP = { 4: 2, 8: 5, 12: 9, 16: 13, 20: 17 };
    const base = { 4: { x: 500, y: 400 }, 8: { x: 470, y: 400 }, 12: { x: 440, y: 400 }, 16: { x: 410, y: 400 }, 20: { x: 380, y: 400 } };
    const hand = (lifts) => {
      const pts = Array.from({ length: 21 }, () => ({ x: 440, y: 280 }));
      pts[0] = { x: 440, y: 210 };
      for (const k of [4, 8, 12, 16, 20]) { pts[k] = { x: base[k].x, y: base[k].y - lifts[k] }; pts[MCP[k]] = { x: base[k].x, y: 280 }; }
      return { label: 'A', points: pts };
    };
    for (const tip of [4, 8, 12, 16, 20]) for (let n = 0; n < 3; n++) {
      for (let f = 0; f <= 8; f++) {
        const l = { 4: 30, 8: 30, 12: 30, 16: 30, 20: 30 };
        l[tip] = Math.max(0, 30 - f * 8);
        if (f === 4) dp.injectTap({ t: performance.now(), peak: 0.1 });
        dp.injectHandFrame({ t: performance.now(), hands: [hand(l)] });
        await sleep(33);
      }
      for (let f = 1; f <= 3; f++) { dp.injectHandFrame({ t: performance.now(), hands: [hand({ 4: 30, 8: 30, 12: 30, 16: 30, 20: 30, [tip]: f * 10 })] }); await sleep(33); }
    }
    await sleep(100);
    return { teaching: !!dp.state.teach, templates: dp.settings.fingerTemplates, played: dp.state.played.length };
  });
  assert.equal(res.teaching, false, 'teaching finished');
  assert.deepEqual(Object.keys(res.templates).sort(), ['12', '16', '20', '4', '8']);
  assert.equal(res.played, 0, 'no notes while teaching');
  // each finger's pattern is strongest on itself
  const order = ['4', '8', '12', '16', '20'];
  for (const [i, tip] of order.entries()) {
    const v = res.templates[tip];
    assert.equal(v.indexOf(Math.max(...v)), i, `${tip}: ${v}`);
  }
});

// The real camera path: Chromium's fake camera plays a synthetic video of the paper.
{
  const cam = makeFakeCameraY4M();
  const b2 = await chromium.launch({ args: ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cam.file}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b2.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  // MediaPipe prints harmless 'INFO:' lines through console.error
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('INFO:')) errors.push(m.text()); });
  try {
    await startApp(page);
    await page.waitForFunction(() => window.deskPiano.state.markersSeen.size >= 10, null, { timeout: 20000 });
    // middle C's position in the picture maps back to middle C
    const L = cam.layout;
    const r = L.kb.keyRect(60);
    const p = applyH(cam.H, L.keysX + (r.x0 + r.x1) / 2, L.keysY + 125);
    const k = await page.evaluate(({ x, y }) => { const s = window.deskPiano.state; return window.deskPiano.keyForPoint(x * s.video.w / 960, y * s.video.h / 540); }, p);
    assert.equal(k, 60);
    assert.deepEqual(errors, []);
    console.log('ok - finds the paper keyboard through the (fake) camera and maps middle C');
  } catch (e) {
    failures++;
    console.log(`not ok - finds the paper keyboard through the (fake) camera\n  ${e.message}`);
  }
  await b2.close();
  rmSync(cam.dir, { recursive: true, force: true });
}

await browser.close();
await close();
if (failures) { console.log(`${failures} e2e test(s) failed`); process.exit(1); }
console.log('all e2e tests passed');
