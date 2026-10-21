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
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, basename, sep } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../tests/server.mjs';
import { OnsetDetector, peakToVelocity } from '../src/onset.js';
import { StrikeDetector } from '../src/strike.js';
import { Fusion } from '../src/fusion.js';
import { TapFusion } from '../src/tap-fusion.js';
import { FingerTeacher } from '../src/tap-resolver.js';
import { paperLayout, paperToKey, fitPaper, TIP_OFFSET_MM } from '../src/paper.js';
import { applyH, invertH } from '../src/homography.js';
import { noteName, parseNote } from '../src/notes.js';
import { HandIds } from '../src/hand-ids.js';
import { TUNE_GRID } from '../src/auto-tune.js';
import { deskKeyAt } from '../src/desk.js';

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
    for (const o of det.process(samples.subarray(i, i + 128))) taps.push({ t: (o.sample / SR) * 1000, peak: o.peak, floor: o.floor, velocity: peakToVelocity(o.peak, sensitivity, o.floor) });
  }
  return taps;
}

// Replays one clip's frames + taps through the same logic as the app, in time order,
// with camera results arriving `latency` ms after the frame was captured.
function replay(frames, taps, { variant, latency, octave = 0, transpose = 0, strikeOpts = {}, fusionOpts = {}, resolverOpts = {}, tipOffset = TIP_OFFSET_MM, engine = 'tap', avOffset = 0, templates = null, learn = null }) {
  const layout = paperLayout(variant);
  let paperInv = null, paperFrames = 0, markerCounts = [];
  const detector = new StrikeDetector(strikeOpts);
  const handIds = new HandIds();
  const notes = [];
  const handlers = {
    keyFor: (p) => {
      if (!paperInv) return null;
      // --desk 2|3: simulate plain desk mode with a perfect 2- or 3-tap calibration taken from
      // where the paper's C4 / C5 (/ C6) keys are, ignoring the printed keys otherwise
      if (opt('desk')) {
        const Hf = invertH(paperInv);
        const at = (m) => { const r = layout.kb.keyRect(m); return applyH(Hf, layout.keysX + (r.x0 + r.x1) / 2, layout.keysY + 120); };
        const cal = { c4: at(60), c5: at(72), ...(opt('desk') === '3' ? { c6: at(84) } : {}) };
        const k = deskKeyAt(cal, p.x, p.y);
        return k == null ? null : k + transpose + octave * 12;
      }
      const q = applyH(paperInv, p.x, p.y);
      const k = paperToKey(layout, q.x, q.y, tipOffset);
      return k == null ? null : k + transpose + octave * 12;
    },
    play: (midi, vel, info) => notes.push({ midi, vel, how: info.how, t: info.t }),
    stop: () => {},
    opts: fusionOpts,
  };
  const fusion = engine === 'tap' ? new TapFusion({ ...handlers, resolverOpts, opts: { autoSync: !flag('no-sync'), ...fusionOpts } }) : new Fusion(handlers);
  if (engine === 'tap' && templates) fusion.resolver.templates = templates;
  if (engine === 'tap' && learn) {
    // collect the movement patterns of clear-cut single-finger taps (for self-teaching experiments)
    const orig = fusion.resolver.resolve.bind(fusion.resolver);
    fusion.resolver.resolve = (t, a) => {
      const picks = orig(t, a);
      if (picks.length === 1 && picks[0].margin >= learn.margin) learn.teacher.add(picks[0].tip, fusion.resolver.pattern(t));
      return picks;
    };
  }
  const events = [];
  const keepEvery = Number(opt('frame-step', 1)); // --frame-step 2/3: simulate a slower camera/tracker
  frames.forEach((f, i) => { if (i % keepEvery === 0) events.push({ at: f.t + latency, kind: 'frame', f }); });
  for (const tp0 of taps) { const tp = { ...tp0, t: tp0.t + avOffset }; events.push({ at: tp.t + 3, kind: 'tap', tp }); }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.kind === 'frame') {
      const f = e.f;
      if (f.markers) {
        const res = fitPaper(layout, f.markers);
        markerCounts.push(res ? res.used.size : 0);
        if (res && (res.used.size >= 3 || !paperInv)) { paperInv = invertH(res.H); paperFrames++; }
      }
      const frame = { t: f.t, hands: handIds.assign(f.hands) };
      if (engine === 'tap') fusion.onFrame(frame);
      else fusion.onStrikeEvents(detector.update(frame), detector);
    } else {
      fusion.onTap({ t: e.tp.t, velocity: e.tp.velocity }, detector);
    }
    fusion.tick(e.at);
  }
  fusion.tick(1e12);
  return { notes, markerCounts, paperFrames, early: fusion.stats && fusion.stats.early || 0, why: fusion.stats && fusion.stats.why || {}, syncOffset: fusion.syncOffset };
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
  const sensitivity = Number(opt('sensitivity', 0.65));
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
  await page.goto(url + `scripts/clip-runner.html?conf=${opt('conf', '0.5')}`);
  await page.waitForFunction(() => window.runnerReady === true, null, { timeout: 60000 });

  const results = [];
  const analysed = []; // kept in memory only, for --sweep
  let totalCorrect = 0, totalExpected = 0, totalDetected = 0;
  for (const clip of clips) {
    const file = join(folder, clip);
    const exp = expected.get(clip);
    // hand tracking is slow: cache its results next to the clips (outside the repo, never committed)
    const cacheDir = join(folder, '.cache');
    const conf = opt('conf', '0.5');
    const cacheFile = join(cacheDir, `${clip}.${FRAME_W}.v2${conf === '0.5' ? '' : `.c${conf}`}.frames.json`);
    let fps, frames;
    if (!flag('no-cache') && existsSync(cacheFile) && statSync(cacheFile).mtimeMs > statSync(file).mtimeMs) {
      ({ fps, frames } = JSON.parse(readFileSync(cacheFile, 'utf8')));
    } else {
      ({ fps, frames } = await analyseClip(page, url, file, tmpRoot));
      if (!selfTest) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ fps, frames })); }
    }
    const audio = decodeAudio(file);
    const taps = tapsFromAudio(audio, sensitivity);
    analysed.push({ clip, frames, audio, exp });
    const { notes, markerCounts, paperFrames, why } = replay(frames, taps, { variant, latency, octave: Number(opt('octave', 0)), tipOffset: Number(opt('tip-offset', TIP_OFFSET_MM)), engine: opt('engine', 'tap'), avOffset: Number(opt('av-offset', 0)) });
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
      console.log(`  taps not played, why: ${Object.entries(why).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}`);
    }
  }
  const overall = totalExpected || totalDetected ? totalCorrect / Math.max(totalExpected, totalDetected) : 1;
  console.log(`\nOVERALL: ${totalCorrect} correct of ${totalExpected} expected (${totalDetected} detected) → ${(overall * 100).toFixed(1)}%`);
  if (flag('sweep')) sweep(analysed, { variant, latency });
  if (opt('sync-test')) syncTest(analysed, { variant, latency, sensitivity });
  if (flag('auto-tune')) autoTuneTest(analysed, { variant, latency, sensitivity });
  if (opt('self-teach')) selfTeach(analysed, { variant, latency, margin: Number(opt('self-teach')) });
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

// --sweep: try combinations of the main detection settings on the already-analysed clips (the
// slow hand tracking is done once) and print the best. Nothing is saved.
function sweep(analysed, { variant, latency }) {
  const grid = JSON.parse(opt('grid', 'null')) || {
    sensitivity: [0.5, 0.65],
    minTravel: [0.03, 0.06],
    minLead: [0.02, 0.04, 0.07],
    chordRatio: [0.7, 0.85, 1.01],
    afterMs: [35, 70],
    minLate: [0.0, 0.04, 0.07],
    maxAfter: [0.04, 0.08, 0.2],
    lateWeight: [0, 1, 2],
  };
  const combos = [{}];
  for (const [k, vals] of Object.entries(grid)) {
    const next = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [k]: v });
    combos.splice(0, combos.length, ...next);
  }
  const tapCache = new Map();
  const rows = [];
  for (const c of combos) {
    let correct = 0, expN = 0, detN = 0, falseNotes = 0;
    for (const a of analysed) {
      const key = `${a.clip}|${c.sensitivity ?? 0.65}`;
      if (!tapCache.has(key)) tapCache.set(key, tapsFromAudio(a.audio, c.sensitivity ?? 0.65));
      const { notes, early } = replay(a.frames, tapCache.get(key), {
        variant, latency,
        resolverOpts: Object.fromEntries(Object.entries(c).filter(([k]) => !['sensitivity', 'tipOffset', 'avOffset', 'autoSync', 'earlyMs', 'earlyMargin'].includes(k))),
        tipOffset: c.tipOffset ?? TIP_OFFSET_MM,
        avOffset: c.avOffset ?? 0,
        fusionOpts: { autoSync: c.autoSync ?? true, earlyMs: c.earlyMs ?? 0, earlyMargin: c.earlyMargin ?? 0.25 },
      });
      const groups = groupChords(notes);
      c.earlyN = (c.earlyN || 0) + early; c.notesN = (c.notesN || 0) + notes.length;
      if (!a.exp) continue;
      const sc = score(a.exp, groups);
      correct += sc.correct; expN += a.exp.length; detN += groups.length;
      if (!a.exp.length) falseNotes += groups.length;
    }
    const { earlyN, notesN, ...cc } = c;
    if (earlyN) cc.early = `${earlyN}/${notesN}`;
    rows.push({ ...cc, accuracy: expN || detN ? correct / Math.max(expN, detN) : 1, falseNotes });
  }
  rows.sort((a, b) => b.accuracy - a.accuracy || a.falseNotes - b.falseNotes);
  console.log(`\nSWEEP (${combos.length} combinations) – best 10:`);
  for (const r of rows.slice(0, 10)) console.log(`  ${(r.accuracy * 100).toFixed(1)}%  notes in no-play clips: ${r.falseNotes}  ` + Object.entries(r).filter(([k]) => !['accuracy', 'falseNotes'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' '));
}

// --sync-test: all clips played back to back (twice) with deliberate sound/picture offsets, to see
// how fast auto-sync corrects them and what that does to accuracy. Grid via --grid on syncSamples/syncGain.
function syncTest(analysed, { variant, latency, sensitivity }) {
  const offsets = String(opt('sync-test')).split(',').map(Number);
  const grid = JSON.parse(opt('grid', 'null')) || { syncSamples: [25, 12, 8], syncGain: [0.5, 0.8] };
  let combos = [{}];
  for (const [k, vals] of Object.entries(grid)) combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  const scored = analysed.filter((a) => a.exp);
  const frames = [], taps = [], ranges = [];
  let t0 = 0;
  for (let round = 0; round < 2; round++) for (const a of scored) {
    const fr = a.frames, end = fr.length ? fr[fr.length - 1].t : 0;
    for (const f of fr) frames.push({ ...f, t: f.t + t0 });
    for (const tp of tapsFromAudio(a.audio, sensitivity)) taps.push({ ...tp, t: tp.t + t0 });
    ranges.push({ a, from: t0, to: t0 + end + 500, round });
    t0 += end + 2000;
  }
  console.log(`\nSYNC TEST (${scored.length} clips × 2 in a row):`);
  for (const off of offsets) for (const c of [{ autoSync: false }, ...combos.map((x) => ({ autoSync: true, ...x }))]) {
    const { notes, syncOffset } = replay(frames, taps, { variant, latency, avOffset: off, fusionOpts: { syncSamples: 25, syncGain: 0.5, ...c } });
    let correct = [0, 0], n = [0, 0], stray = [0, 0];
    for (const r of ranges) {
      const g = groupChords(notes.filter((x) => x.t >= r.from && x.t < r.to).map((x) => ({ ...x, t: x.t - r.from })));
      if (r.a.exp.length) { correct[r.round] += score(r.a.exp, g).correct; n[r.round] += r.a.exp.length; } else stray[r.round] += g.length;
    }
    console.log(`  offset ${off} ms ${JSON.stringify(c)}: 1st pass ${correct[0]}/${n[0]} (${stray[0]} stray), 2nd pass ${correct[1]}/${n[1]} (${stray[1]} stray), final correction ${Math.round(syncOffset)} ms`);
  }
}

// --auto-tune: tests the app's personal auto-tuning (Check accuracy). For each clip with expected
// notes, tune on that clip alone (same grid and rule as src/auto-tune.js: at least 2 more notes
// right), then score all the OTHER clips with the tuned settings vs the defaults. Shows whether
// tuning on one short exercise carries over to other playing.
function autoTuneTest(analysed, { variant, latency, sensitivity }) {
  const tapsOf = new Map(analysed.map((a) => [a.clip, tapsFromAudio(a.audio, sensitivity)]));
  const evalClip = (a, extra) => {
    const { notes } = replay(a.frames, tapsOf.get(a.clip), { variant, latency, resolverOpts: extra });
    const groups = groupChords(notes);
    if (!a.exp.length) return { correct: 0, n: 0, det: groups.length, falseNotes: groups.length };
    const sc = score(a.exp, groups);
    return { correct: sc.correct, n: a.exp.length, det: groups.length, falseNotes: 0, score: sc.correct - 0.5 * Math.max(0, groups.length - sc.correct) };
  };
  let combos = [{}];
  for (const [k, vals] of Object.entries(TUNE_GRID)) combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  const withExp = analysed.filter((a) => a.exp);
  console.log('\nAUTO-TUNE (tune on one clip, score the others):');
  for (const A of withExp.filter((a) => a.exp.length)) {
    const base = evalClip(A, {});
    let best = null;
    for (const c of combos) {
      const r = evalClip(A, c);
      if (!best || r.score > best.r.score) best = { r, c };
    }
    const ok = best.r.correct >= base.correct + 2 && best.r.score > base.score;
    const params = ok ? best.c : {};
    let d = { correct: 0, n: 0, det: 0, falseNotes: 0 }, t = { correct: 0, n: 0, det: 0, falseNotes: 0 };
    for (const B of withExp) {
      if (B === A) continue;
      const rb = evalClip(B, {}), rt = evalClip(B, params);
      for (const k of Object.keys(d)) { d[k] += rb[k]; t[k] += rt[k]; }
    }
    const pct = (x) => (x.n ? (100 * x.correct / Math.max(x.n, x.det - x.falseNotes)).toFixed(1) : '-');
    console.log(`  tuned on ${A.clip}: ${base.correct}→${best.r.correct}/${A.exp.length} ${ok ? JSON.stringify(params) : '(not clearly better: kept defaults)'}`);
    console.log(`    other clips: defaults ${d.correct}/${d.n} correct (${pct(d)}%), ${d.falseNotes} stray; tuned ${t.correct}/${t.n} (${pct(t)}%), ${t.falseNotes} stray`);
  }
}

// --self-teach M: learn finger patterns from clear-cut taps (margin ≥ M) in all OTHER clips, then score
// each clip using them (leave-one-out) — tests whether the app could teach itself while you play.
function selfTeach(analysed, { variant, latency, margin }) {
  let correct = 0, expN = 0, detN = 0, base = 0;
  for (const a of analysed) {
    const teacher = new FingerTeacher();
    for (const b of analysed) if (b !== a) replay(b.frames, tapsFromAudio(b.audio, 0.65), { variant, latency, learn: { teacher, margin } });
    const t0 = replay(a.frames, tapsFromAudio(a.audio, 0.65), { variant, latency });
    const t1 = replay(a.frames, tapsFromAudio(a.audio, 0.65), { variant, latency, templates: teacher.templates() });
    if (!a.exp) continue;
    const s0 = score(a.exp, groupChords(t0.notes)), s1 = score(a.exp, groupChords(t1.notes));
    base += s0.correct; correct += s1.correct; expN += a.exp.length; detN += groupChords(t1.notes).length;
    console.log(`  ${a.clip}: ${s0.correct} → ${s1.correct} correct (taught fingers: ${Object.keys(teacher.templates()).join(',')})`);
  }
  console.log(`SELF-TEACH margin ${margin}: correct ${base} → ${correct} of ${expN}`);
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
