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

## Tuning loop

1. Run all clips once and **log the accuracy per clip (before)** in the CLAUDE.md progress log.
2. Look at what fails, one stage at a time:
   - *Paper found 0/N or few markers*: marker detector (`src/markers.js` — threshold `offset`,
     `radius`, `minArea`) or frame size (`FRAME_W` in the script; the app uses ≤960 px wide).
   - *Hands seen in few frames*: lighting/angle; MediaPipe confidence thresholds.
   - *Taps heard ≠ notes played*: tap detector (`src/onset.js` — `sensitivity`, `ratio`, the 2 ms rise
     test, refractory time). Count taps vs. expected notes.
   - *Missed notes with taps heard*: strike detection (`src/strike.js` — `downSpeed`, `minDrop`,
     `stopRatio`, `knuckleWeight`) or fusion windows (`src/fusion.js` — `matchMs`, `pendingMs`,
     `descendLookMs`).
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
