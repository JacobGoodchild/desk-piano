# Testing with real clips

This is for a **future session** where Jacob uploads short clips (with sound) of himself playing on the
paper keyboard. Use them to tune the detection until it is as accurate as possible.

## Privacy rules — follow these every time (very important)

1. **Clips live only outside the repo**, e.g. `~/private-clips/`. Never copy, move or save a clip (or any
   part of one) inside the repository folder. If clips arrive inside the repo folder, move them out
   *before doing anything else* and check `git status` shows nothing from them.
2. **Never commit, push, publish or screenshot** clips, frames, audio, or anything extracted from them —
   that includes tracked hand points, marker positions, audio levels, and per-frame measurements.
   Only aggregate numbers (accuracy %, counts of missed/wrong/extra notes, note names) may go into the
   progress log or commit messages.
3. Never put clip material on the GitHub Pages site or in test output. The automated tests in this
   public repo use **synthetic data only**.
4. `scripts/clip-test.mjs` enforces some of this: it refuses a clip folder inside the repo, refuses a
   `--json` output path inside the repo, keeps temporary frames in the system temp folder and deletes
   them afterwards. Don't work around these checks.
5. `.gitignore` already blocks `*.mp4 *.mov *.webm *.wav screenshots/ test-output/ clip-output/
   private-clips/` as a safety net — but don't rely on it.

## Folder layout

```
~/private-clips/
  notes.txt               # expected notes, one line per clip
  c-major-scale.mp4
  chords.mp4
  talking.mp4
```

`notes.txt` format (any `.txt` file in the folder is read):

```
c-major-scale.mp4: C4 D4 E4 F4 G4 A4 B4 C5
chords.mp4: C4+E4+G4 F4+A4+C5 G4+B4+D5
talking.mp4: none
knocking.mp4: none
```

Chords are notes joined with `+`. `none` (or nothing) means the clip should produce **no** notes.

## Running it

```
npm install                    # once (Playwright; uses the pre-installed Chromium)
node scripts/clip-test.mjs --self-test            # plumbing check with a synthetic clip
node scripts/clip-test.mjs ~/private-clips --verbose
node scripts/clip-test.mjs ~/private-clips --only chords.mp4 --verbose
node scripts/clip-test.mjs ~/private-clips --json ~/private-clips/results-before.json
```

Add `--sweep` to try 486 combinations of the main settings (tap sensitivity, strike speed and
distance, tap/landing match window, knuckle weighting) on the already-analysed clips — the slow hand
tracking runs only once — and print the 10 best. Use it as a starting point, then confirm by hand.

Experiment: `--self-teach 0.3` learns finger patterns from clear-cut taps in the other clips and
re-scores each clip with them (leave-one-out). On the first clips it made things worse (32 → 26
correct) because clear-cut taps never involved the middle finger — so the app does not teach itself;
only the explicit "Teach my fingers" step (all five fingers) is used.

More options: `--conf 0.3` (MediaPipe confidence thresholds; each value has its own cache),
`--av-offset 30` (pretend the sound is 30 ms late, to test timing robustness), `--no-sync` (turn
off the engine's automatic sound/picture timing correction), `--engine classic` (old engine).
The hand-tracking results are cached in `<clip folder>/.cache/` (outside the repo — never commit
them); delete that folder to force a fresh analysis.

Options: `--variant full|compact` (which printed keyboard is in the clips), `--latency 40` (simulated
camera processing delay in ms — the phone is roughly 30–60), `--sensitivity 0.5` (tap sensitivity),
`--octave N`.

What it does per clip: extracts frames with ffmpeg (to a temp folder), runs the real MediaPipe hand
tracker and the paper marker detector in headless Chromium, runs the tap detector on the audio in Node,
then replays both through the same `StrikeDetector` + `Fusion` logic the app uses, in time order, with
camera results arriving `--latency` ms late (as on a real device). It then aligns detected notes with
expected notes (edit distance) and reports **correct / wrong / missed / extra** notes, accuracy, note
times and gaps, and how each note was triggered (`tap+descending`, `tap+land`, `land+tap`,
`tap+corrected`, `camera-only`).

## What we learnt from the first clips (Oct 2026)

- Jacob's webcam sends a **mirrored** image (the marker detector handles that now).
- The webcam microphone hears taps only ~15–25 dB above the room noise and smears them over ~10 ms;
  the tap detector now works relative to the learnt background noise.
- He plays with the whole hand dropping onto the paper: 3–5 fingertips touch on every note, so a
  "which finger landed" detector fails. The default engine is now **tap-first** (`src/tap-resolver.js`
  + `src/tap-fusion.js`): on each tap it picks the finger that moved down most compared with the
  hand's other fingers, and must still be moving down just before the tap.
- Chords: in the C-E-G clip no finger stands out, so chords within a hand are **off by default**.
- Slower hand tracking (simulate with `--frame-step 2|3`) costs accuracy; the app now waits longer
  after a tap when frames are sparse and interpolates hand positions between frames.

## Clips that would help most next time

1. **Teach-my-fingers clip** — `fingers-right.mp4`: right hand resting on C D E F G, tap each finger
   3 times in order (thumb, index, middle, ring, little), pause between. Notes file line:
   `fingers-right.mp4: C4 C4 C4 D4 D4 D4 E4 E4 E4 F4 F4 F4 G4 G4 G4`. Same for the left hand.
2. Slow, single-note scales (C major up and down) in each hand.
3. Chords held for a moment (C-E-G, then F-A-C) with the hand starting clearly lifted.
4. A clip filmed from higher up (looking down more steeply at the fingers), and one with the
   microphone close to the desk, to compare.
5. The **Check accuracy** exercise (`check.mp4: C4 D4 E4 F4 G4 F4 E4 D4 C4`) and one or two
   **Follow a tune** pieces played as written (e.g. `mary.mp4` with the tune's notes from
   `src/tunes.js`) — exact transcriptions make every clip scoreable, and `--auto-tune` can then
   test the app's personal tuning on real, known sequences.
6. Something at real speed (a Grade-8-style passage, both hands) with a written note list, to see
   how far accuracy falls with tempo.

Tips for the recordings: keep the whole paper and all markers in view, the phone/webcam at the far
side ~45° down, the mic as close to the paper as possible, and say nothing while playing.

## Engine settings to tune (in `RESOLVER_DEFAULTS`)

`lookbackMs`, `afterMs` (70 = accurate, 35 = fast), `minTravel`, `minLead`, `minLate`, `maxAfter`,
`lateWeight`, `zWeight`, `jointWeight`, `flexWeight` (finger bend; off — worth re-testing on new clips),
`typicalRank`, `chordRatio`, `handRatio`, `repeatMs`. Use
`--sweep --grid '{"minLead":[0.02,0.04],"afterMs":[35,70]}'` to try specific values. The old
landing-based engine is still available with `--engine classic`.

`--sync-test 0,20,-20` plays all clips back to back with deliberate sound/picture offsets to test auto-sync.
`--desk 2|3` simulates plain desk mode (a perfect 2- or 3-tap calibration taken from the paper).
`--auto-tune` (add `--tune-tip` to include the fingertip offset) checks the app's personal auto-tuning (Set-up → Check accuracy): it tunes on each
clip alone and scores the other clips with the result. Tuning must never make the other clips worse;
if it does, narrow `TUNE_GRID` in `src/auto-tune.js`.

## Tuning loop

1. Run all clips once and **log the accuracy per clip (before)** in the CLAUDE.md progress log.
2. Look at what fails, one stage at a time:
   - *Paper found 0/N or few markers*: marker detector (`src/markers.js` — threshold `offset`,
     `radius`, `minArea`) or frame size (`FRAME_W` in the script; the app uses ≤960 px wide).
   - *Hands seen in few frames*: lighting/angle; MediaPipe confidence thresholds.
   - *Taps heard ≠ notes played*: tap detector (`src/onset.js` — `sensitivity`, `ratio`, the 2 ms rise
     test, refractory time). Count taps vs. expected notes.
   - *Missed notes with taps heard*: the tap resolver's gates (`minTravel`, `minLate`, `maxAfter`,
     `minLead`) — or, with `--engine classic`, the strike detector (`src/strike.js`). `--verbose`
     prints **why** each heard tap played nothing ("too little travel", "not still moving down",
     "kept moving after the tap", "no finger ahead of the others", "off the keys", "no hands",
     "no camera frame in time"); the live app shows the last reason in the debug view. Loosen the
     gate that blocks most real notes, then check the hovering/resting clips stay silent.
   - *Wrong notes (neighbouring key)*: key mapping — the fingertip landmark sits above the contact
     point; `TIP_OFFSET_MM` in `src/paper.js` (default 5 mm towards the camera) corrects for that.
     Black↔white mix-ups → tune it; sideways mix-ups → check the predicted touch-down point.
     Black/white confusion → the depth (y) offset.
   - *Extra notes*: echo/false taps (`echoMs`), camera-only threshold (`cameraOnlyMs`, `minDrop`),
     lift detection (`liftDist`) causing re-triggers.
   - *Talking/knocking clips produce notes*: tighten camera confirmation (higher `downSpeed`/`minDrop`)
     and the onset rise test.
3. Change one thing at a time, re-run, keep it only if overall accuracy improves without hurting the
   no-playing clips.
4. Put new defaults into the source (`STRIKE_DEFAULTS`, `FUSION_DEFAULTS`, onset options), run
   `npm test` (synthetic tests must still pass; update them if the new behaviour is intentionally
   different), commit, and **log accuracy after, per clip**, in the progress log (numbers only).
