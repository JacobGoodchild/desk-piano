#!/usr/bin/env node
// Clip test: runs the full Desk Piano detection over real recordings and scores the notes found.
//
//   node scripts/clip-test.mjs ~/private-clips [--variant full|compact] [--latency 40]
//        [--sensitivity 0.5] [--json ~/private-clips/results.json] [--only name.mp4] [--verbose]
//   node scripts/clip-test.mjs --self-test      (synthetic clip, checks the plumbing)
//
// PRIVACY (see CLIPS.md): clips must live OUTSIDE this repository. This script refuses a folder
// inside the repo, writes temporary frames only to the system temp folder (deleted afterwards),
// prints only note names and numbers, and never writes anything into the repo.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, basename, sep } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tests/server.mjs';
import { OnsetDetector, peakToVelocity } from '../src/onset.js';
import { StrikeDetector } from '../src/strike.js';
import { Fusion } from '../src/fusion.js';
import { paperLayout, markerCorners, paperToKey } from '../src/paper.js';
import { fitHomography, applyH, invertH } from '../src/homography.js';
import { noteName, parseNote } from '../src/notes.js';

const REPO = realpathSync(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);
const SR = 48000;
const FRAME_W = 960;

function insideRepo(p) {
  const r = realpathSync(p);
  return r === REPO || r.startsWith(REPO + sep);
}

function sh(cmd, a, opts = {}) {
  const r = spawnSync(cmd, a, { maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${String(r.stderr).slice(-400)}`);
  return r.stdout;
}

// notes file: "clip.mp4: C4 D4 E4" ; chords as C4+E4+G4 ; "none" (or nothing) = no notes expected
function readExpected(folder) {
  const files = readdirSync(folder).filter((f) => /\.(txt|md)$/i.test(f));
  const map = new Map();
  for (const f of files) {
    for (const line of readFileSync(join(folder, f), 'utf8').split('\n')) {
      const m = /^\s*([^#:][^:]*\.\w+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const toks = m[2].trim().split(/[\s,]+/).filter(Boolean).filter((t) => !/^none$/i.test(t));
      map.set(m[1].trim(), toks.map((t) => t.split('+').map(parseNote).filter((n) => n != null).sort((a, b) => a - b)));
    }
  }
  return map;
}

function probeFps(file) {
  const out = String(sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', file])).trim();
  const [a, b] = out.split('/').map(Number);
  return b ? a / b : a || 30;
}

function decodeAudio(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0 || !r.stdout.length) return new Float32Array(0);
  const buf = r.stdout;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

function tapsFromAudio(samples, sensitivity) {
  const det = new OnsetDetector(SR, { sensitivity });
  const taps = [];
  for (let i = 0; i < samples.length; i += 128) {
    for (const o of det.process(samples.subarray(i, i + 128))) taps.push({ t: (o.sample / SR) * 1000, peak: o.peak, velocity: peakToVelocity(o.peak, sensitivity) });
  }
  return taps;
}

// Replays one clip's frames + taps through the same logic as the app, in time order,
// with camera results arriving `latency` ms after the frame was captured.
function replay(frames, taps, { variant, latency, octave = 0, transpose = 0 }) {
  const layout = paperLayout(variant);
  const known = markerCorners(layout);
  let paperInv = null, paperFrames = 0, markerCounts = [];
  const detector = new StrikeDetector();
  const notes = [];
  const fusion = new Fusion({
    keyFor: (p) => {
      if (!paperInv) return null;
      const q = applyH(paperInv, p.x, p.y);
      const k = paperToKey(layout, q.x, q.y);
      return k == null ? null : k + transpose + octave * 12;
    },
    play: (midi, vel, info) => notes.push({ midi, vel, how: info.how, t: info.t }),
    stop: () => {},
  });
  const events = [];
  for (const f of frames) events.push({ at: f.t + latency, kind: 'frame', f });
  for (const tp of taps) events.push({ at: tp.t + 3, kind: 'tap', tp });
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.kind === 'frame') {
      const f = e.f;
      if (f.markers) {
        const src = [], dst = [];
        for (const m of f.markers) if (known[m.id]) for (let i = 0; i < 4; i++) { src.push(known[m.id][i]); dst.push(m.corners[i]); }
        markerCounts.push(new Set(f.markers.map((m) => m.id)).size);
        if (src.length >= 8) { const H = fitHomography(src, dst); if (H) { paperInv = invertH(H); paperFrames++; } }
      }
      fusion.onStrikeEvents(detector.update({ t: f.t, hands: f.hands }), detector);
    } else {
      fusion.onTap({ t: e.tp.t, velocity: e.tp.velocity }, detector);
    }
    fusion.tick(e.at);
  }
  fusion.tick(1e12);
  return { notes, markerCounts, paperFrames };
}

// group notes starting within 60 ms into chords
function groupChords(notes) {
  const groups = [];
  for (const n of [...notes].sort((a, b) => a.t - b.t)) {
    const g = groups[groups.length - 1];
    if (g && n.t - g.t <= 60) { if (!g.midis.includes(n.midi)) g.midis.push(n.midi); }
    else groups.push({ t: n.t, midis: [n.midi], vel: n.vel });
  }
  groups.forEach((g) => g.midis.sort((a, b) => a - b));
  return groups;
}

// edit-distance alignment of expected vs detected note groups
function score(expected, detected) {
  const E = expected.map((g) => g.join('+')), D = detected.map((g) => g.midis.join('+'));
  const n = E.length, m = D.length;
  const dp = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (E[i - 1] === D[j - 1] ? 0 : 1));
  }
  const res = { correct: 0, wrong: [], missed: [], extra: [] };
  let i = n, j = m;
  const name = (s) => s.split('+').map(Number).map(noteName).join('+');
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (E[i - 1] === D[j - 1] ? 0 : 1)) {
      if (E[i - 1] === D[j - 1]) res.correct++; else res.wrong.unshift(`${name(E[i - 1])}→${name(D[j - 1])}@${(detected[j - 1].t / 1000).toFixed(2)}s`);
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) { res.missed.unshift(name(E[i - 1])); i--; }
    else { res.extra.unshift(`${name(D[j - 1])}@${(detected[j - 1].t / 1000).toFixed(2)}s`); j--; }
  }
  res.accuracy = n === 0 ? (m === 0 ? 1 : 0) : res.correct / Math.max(n, m);
  return res;
}

async function analyseClip(page, serverUrl, file, tmpRoot) {
  const fps = probeFps(file);
  const dir = mkdtempSync(join(tmpRoot, 'frames-'));
  sh('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${FRAME_W}:-2`, '-q:v', '3', join(dir, 'f%05d.jpg')]);
  const names = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
  const frames = [];
  // analyse in batches so memory stays small
  for (let i = 0; i < names.length; i += 120) {
    const batch = names.slice(i, i + 120).map((n) => `${serverUrl}__frames/${basename(dir)}/${n}`);
    const res = await page.evaluate(({ batch, fps, start }) => window.analyseFrames(batch, fps).then((r) => r.map((f, k) => ({ ...f, t: ((start + k) * 1000) / fps }))), { batch, fps, start: i });
    frames.push(...res);
  }
  rmSync(dir, { recursive: true, force: true });
  return { fps, frames };
}

async function main() {
  let folder = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  const selfTest = flag('self-test');
  const tmpRoot = mkdtempSync(join(tmpdir(), 'desk-piano-clips-'));
  if (selfTest) folder = makeSyntheticClips(tmpRoot);
  if (!folder) { console.error('usage: node scripts/clip-test.mjs <folder outside the repo> | --self-test'); process.exit(2); }
  folder = resolve(folder.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  if (!existsSync(folder) || !statSync(folder).isDirectory()) { console.error(`not a folder: ${folder}`); process.exit(2); }
  if (insideRepo(folder)) { console.error('REFUSING: clips must be stored outside the repository (see CLIPS.md).'); process.exit(2); }
  const jsonOut = opt('json');
  if (jsonOut && insideRepo(resolve(jsonOut, '..'))) { console.error('REFUSING: --json output must be outside the repository.'); process.exit(2); }
  const variant = opt('variant', 'full');
  const latency = Number(opt('latency', 40));
  const sensitivity = Number(opt('sensitivity', 0.5));
  const only = opt('only');
  const expected = readExpected(folder);
  const clips = readdirSync(folder).filter((f) => VIDEO_EXT.has(extname(f).toLowerCase())).filter((f) => !only || f === only).sort();
  if (!clips.length) { console.error('no clips found'); process.exit(2); }

  const { url, close } = await startServer();
  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const page = await browser.newPage();
  await page.route('**/__frames/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.split('/__frames/')[1]);
    const file = join(tmpRoot, rel);
    if (!file.startsWith(tmpRoot)) return route.abort();
    return route.fulfill({ body: readFileSync(file), contentType: 'image/jpeg' });
  });
  await page.goto(url + 'scripts/clip-runner.html');
  await page.waitForFunction(() => window.runnerReady === true, null, { timeout: 60000 });

  const results = [];
  let totalCorrect = 0, totalExpected = 0, totalDetected = 0;
  for (const clip of clips) {
    const file = join(folder, clip);
    const exp = expected.get(clip);
    const { fps, frames } = await analyseClip(page, url, file, tmpRoot);
    const taps = tapsFromAudio(decodeAudio(file), sensitivity);
    const { notes, markerCounts, paperFrames } = replay(frames, taps, { variant, latency, octave: Number(opt('octave', 0)) });
    const groups = groupChords(notes);
    const handFrames = frames.filter((f) => f.hands.length).length;
    const sc = exp ? score(exp, groups) : null;
    const hows = notes.reduce((a, n) => ((a[n.how] = (a[n.how] || 0) + 1), a), {});
    const r = {
      clip, fps: Math.round(fps), frames: frames.length, handFrames, taps: taps.length,
      paperFound: `${paperFrames}/${markerCounts.length}`, markersMax: Math.max(0, ...markerCounts),
      detected: groups.map((g) => g.midis.map(noteName).join('+')).join(' '),
      expected: exp ? exp.map((g) => g.map(noteName).join('+')).join(' ') || '(none)' : '(not listed)',
      how: hows, ...(sc || {}),
    };
    if (sc) { totalCorrect += sc.correct; totalExpected += exp.length; totalDetected += groups.length; }
    results.push(r);
    console.log(`\n== ${clip}`);
    console.log(`  frames ${r.frames} @${r.fps}fps, hands seen in ${handFrames}, taps heard ${taps.length}, paper found ${r.paperFound} (max markers ${r.markersMax})`);
    console.log(`  expected: ${r.expected}`);
    console.log(`  detected: ${r.detected || '(none)'}   [${Object.entries(hows).map(([k, v]) => `${k}:${v}`).join(' ')}]`);
    if (sc) console.log(`  correct ${sc.correct}, wrong ${sc.wrong.length} ${sc.wrong.join(' ')}, missed ${sc.missed.length} ${sc.missed.join(' ')}, extra ${sc.extra.length} ${sc.extra.join(' ')}, accuracy ${(sc.accuracy * 100).toFixed(0)}%`);
    if (flag('verbose')) {
      const iois = groups.slice(1).map((g, k) => Math.round(g.t - groups[k].t));
      console.log(`  note times (s): ${groups.map((g) => (g.t / 1000).toFixed(2)).join(' ')}`);
      console.log(`  gaps between notes (ms): ${iois.join(' ')}`);
    }
  }
  const overall = totalExpected || totalDetected ? totalCorrect / Math.max(totalExpected, totalDetected) : 1;
  console.log(`\nOVERALL: ${totalCorrect} correct of ${totalExpected} expected (${totalDetected} detected) → ${(overall * 100).toFixed(1)}%`);
  if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify({ when: new Date().toISOString(), variant, latency, sensitivity, overall, results }, null, 2));
  await browser.close();
  await close();
  rmSync(tmpRoot, { recursive: true, force: true });
  if (selfTest) {
    const r = results[0];
    const ok = r && r.markersMax >= 6 && r.taps >= 3 && !r.detected;
    console.log(ok ? '\nSELF-TEST PASSED (paper found, taps heard, no hands → no notes)' : '\nSELF-TEST FAILED');
    process.exit(ok ? 0 : 1);
  }
}

// Synthetic clip for --self-test: the rendered paper (no hands) with tap sounds. Written only to
// the temp folder.
function makeSyntheticClips(tmpRoot) {
  const dir = mkdtempSync(join(tmpRoot, 'synthetic-'));
  const script = `
    import { paperLayout } from '${REPO}/src/paper.js';
    import { fitHomography } from '${REPO}/src/homography.js';
    import { renderPaperScene, sceneHomography, tapSound } from '${REPO}/tests/synth.mjs';
    import { writeFileSync } from 'node:fs';
    const L = paperLayout('full'); const w = 960, h = 540;
    const { src, dst } = sceneHomography(L, w, h, { tilt: 0.35, rotate: 0.04 });
    const img = renderPaperScene(L, fitHomography(src, dst), w, h);
    writeFileSync('${dir}/scene.gray', Buffer.from(img));
    const sr = 48000, a = new Float32Array(sr * 2);
    for (const t of [0.3, 0.8, 1.3]) { const s = tapSound(sr, 0.2); a.set(s, Math.round(t * sr)); }
    writeFileSync('${dir}/taps.f32', Buffer.from(a.buffer));
  `;
  sh(process.execPath, ['--input-type=module', '-e', script]);
  sh('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '960x540', '-r', '30', '-stream_loop', '-1', '-i', join(dir, 'scene.gray'),
    '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', join(dir, 'taps.f32'), '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'no-hands.mp4')]);
  rmSync(join(dir, 'scene.gray')); rmSync(join(dir, 'taps.f32'));
  writeFileSync(join(dir, 'notes.txt'), 'no-hands.mp4: none\n');
  return dir;
}

main().catch((e) => { console.error(e); process.exit(1); });
