// Personal auto-tuning. During "Check accuracy" the app keeps the hand-tracking frames and taps
// (in memory only), then replays them through the note engine with 20 variations of its
// main settings and keeps the one that gets this player's notes right most often — the same tuning
// done with test clips, but live, for this player, camera and desk. Nothing is saved except the
// chosen numbers.
import { TapFusion } from './tap-fusion.js';

// Variations to try (each combined with the others). Only the "how much must the finger move"
// gates: tuning more (weights, comparison finger) on one clip made the other clips worse (overfit).
export const TUNE_GRID = {
  minLead: [0.015, 0.02, 0.03, 0.045],
  minLate: [0.01, 0.02, 0.03, 0.04, 0.06],
};

// Number of notes matched in order (longest common subsequence).
export function alignCorrect(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

// Which expected notes were matched, in order (same alignment as alignCorrect): [true/false per note].
export function alignMatched(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const hit = new Array(a.length).fill(false);
  for (let i = a.length, j = b.length; i > 0 && j > 0;) {
    if (a[i - 1] === b[j - 1]) { hit[i - 1] = true; i--; j--; } else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--;
  }
  return hit;
}

// Play the recorded frames and taps through a fresh engine; returns the notes in order.
export function replayNotes({ frames, taps, keyFor, resolverOpts, fusionOpts = {}, templates = null, syncOffset = 0 }) {
  const got = [];
  const sim = new TapFusion({ keyFor, play: (m) => got.push(m), stop() {}, opts: { ...fusionOpts, autoSync: false }, resolverOpts });
  sim.syncOffset = syncOffset;
  sim.resolver.templates = templates;
  const events = [...frames.map((f) => ({ t: f.t, f })), ...taps.map((x) => ({ t: x.t, x }))].sort((a, b) => a.t - b.t);
  for (const e of events) { if (e.f) sim.onFrame(e.f); else sim.onTap({ ...e.x }); }
  return got;
}

const scoreOf = (expected, got) => { const c = alignCorrect(expected, got); return { correct: c, score: c - 0.5 * Math.max(0, got.length - c) }; };

// Returns { params, before, after } — params is null if nothing was clearly better (needs at least
// `margin` more notes right), so a lucky variation on a few notes doesn't change anything.
// keyForTip (optional): (tipOffsetMm) → keyFor, to also try where the fingertip meets the paper
// (camera angle: mixes up black and white keys); baseTip is the current value.
export function autoTune({ frames, taps, expected, keyFor, base, fusionOpts, templates, syncOffset, margin = 2, keyForTip = null, baseTip = 5, tips = [0, 5, 10] }) {
  const run = (extra, tip = baseTip) => scoreOf(expected, replayNotes({ frames, taps, keyFor: tip === baseTip ? keyFor : keyForTip(tip), resolverOpts: { ...base, ...extra }, fusionOpts, templates, syncOffset }));
  const before = run({});
  let combos = [{}];
  for (const [k, vals] of Object.entries(TUNE_GRID)) combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  let best = null;
  for (const tip of keyForTip ? tips : [baseTip]) {
    for (const c of combos) {
      const changed = Object.fromEntries(Object.entries(c).filter(([k, v]) => base[k] !== v));
      const r = run(changed, tip);
      const params = tip === baseTip ? changed : { ...changed, tipOffset: tip };
      const n = Object.keys(params).length;
      // better score wins; on a tie, the variation that changes fewest settings
      if (!best || r.score > best.r.score || (r.score === best.r.score && n < best.n)) best = { r, params, n };
    }
  }
  const ok = best && best.n > 0 && best.r.correct >= before.correct + margin && best.r.score > before.score;
  return { params: ok ? best.params : null, before: before.correct, after: ok ? best.r.correct : before.correct };
}
