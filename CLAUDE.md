# Desk Piano: build brief

You're working on your own until **18:30 UK time today**. I won't be around to answer questions, so make sensible
choices yourself and write them down in the progress log. Check the time with `TZ=Europe/London date`.
Save this brief as CLAUDE.md in the repo first, and keep the progress log at the bottom of it.

## Wake-ups (do this before anything else)
Usage limits sometimes stop you part-way. Use your tool for scheduling messages back into this same session to
schedule one every 30 minutes until the end time. Each should say: "Wake-up check: if you stopped, read the progress
log in CLAUDE.md, check git status, and carry on from where you left off. If you're already working, ignore this."
If you have no such tool, say so at the top of the progress log and carry on anyway. Commit and push after every
small working step, and update the log as you go, so nothing is lost if you're cut off.

## The goal
A browser app that lets me play piano on a desk with no piano. I tap my fingers on a **printed paper keyboard**
taped to the desk; a camera watches my hands and the microphone hears the taps; the app plays realistic piano sound.
I play piano at Grade 8 standard, so it should handle real pieces at a moderate speed, with dynamics. Published on
GitHub Pages from this repo.

## How it works (these decisions are made; follow them)
- **The microphone decides WHEN a note plays.** Detect the short "tok" of a fingertip hitting the desk with a fast
  onset detector on the microphone input, with as little delay as possible. How loud the tap is sets how loud the
  note is (velocity).
- **The camera decides WHICH note.** Track both hands (well-known open-source in-browser hand tracking, for example
  Google's MediaPipe hand landmarker, Apache 2.0). When a tap is heard, play the key under each fingertip that has
  just moved down onto the paper. Several fingers coming down together = a chord.
- **Ignore false taps.** Only play a note if the camera sees a fingertip coming down at that moment, so talking,
  knocks or bumps don't trigger notes. If the camera sees a clear finger strike but the microphone missed it
  (for example a very soft tap), still play it, slightly later and quieter, rather than drop it.
- **The app's own sound must not trigger taps.** Recommend headphones on screen. In speaker mode, filter out the
  app's own output (use the browser's echo cancellation where it helps, and ignore onsets that line up with notes
  the app just played unless the camera confirms a new strike).
- **Note length:** a note keeps sounding while the finger stays down and stops when the camera sees it lift, with a
  natural piano release. **Sustain pedal:** a key on the computer keyboard (Space) and an on-screen toggle, plus a
  setting for "pedal always on".

### Paper keyboard mode (the main mode)
- The app includes a **printable keyboard page**: life-size piano keys (real key width, about 23.5 mm per white
  key) covering **C3 to C6**, split across A4 landscape sheets with clear "tape here" marks and overlaps. Black keys
  printed in black, note names printed small on the white keys (middle C clearly marked).
- Print **clear corner markers** on the sheets so the camera can find the paper's position and angle every frame,
  even if the paper or camera moves a bit. Map each fingertip onto the paper to find the key; front/back position
  decides black vs white key.
- An option to print a smaller 2-octave version.

### Plain desk mode (for when there's no paper)
- **Calibration:** tap middle C, then the C above it, so the app learns where the keyboard is and how wide the keys
  are. A "recentre" button to re-tap middle C if my hands drift. Black keys are taps further forward on the desk.

### Camera set-up
The camera faces me from across the desk, tilted down at my hands (about 45°), for example a phone on a stand or
on books at the far side of the paper, or a laptop with an external webcam. A laptop's built-in camera usually can't
see the desk, so support both: the **whole app running on a phone** (Pixel 7, landscape, phone propped up, sound
through headphones) and on a laptop. Show a set-up screen with a live preview, a frame showing where the paper
should be, and a check that both hands and all the corner markers are visible.

## What's on screen
- A **piano keyboard** across the screen that lights up the notes being played, plus the note names.
- The live camera picture (small, optional) with the paper outline and fingertips drawn on.
- A **debug view** (toggle in settings and at `?debug=1`): hand points, the detected paper, each fingertip's key,
  the microphone level with detected taps, and the measured delay from tap to sound.
- Settings: mode (Paper / Plain desk), range, transpose and octave shift, sensitivity, speaker or headphones.
- **Computer-keyboard controls for testing without a camera or microphone**, so the sound can always be checked.

## Sound
Realistic grand piano from real recordings with a licence that allows reuse (for example the Salamander Grand Piano
samples, if their licence checks out; verify and record it). Use enough velocity layers to make soft and loud notes
sound different, but keep the download small enough for a phone (compressed files, sampling every few notes and
pitch-shifting between). Proper release and sustain-pedal behaviour. Use the browser's audio system with the
lowest delay possible. Measure the delay from tap to sound and log it.

## Test clips: NOT this session
There are **no real test clips yet, so don't wait for or ask for any**. Build and test with synthetic data for now
(fake hand movements, fake rendered paper scenes and fake tap sounds generated in code).

In a later session I'll upload short clips (with sound) of myself playing on the paper keyboard directly into the
session. Get ready for that now: build a clip-testing script (`scripts/clip-test.mjs` or similar) that takes a
folder path **outside the repo**, runs the full detection over every clip, and compares the notes it detects
against the expected notes listed in a notes file I'll include (for example "c-major-scale.mp4: C4 D4 E4 F4 G4
A4 B4 C5"), reporting missed notes, wrong notes, extra notes and timing. Clips with no playing (for example talking
or knocking) should produce no notes. Write `CLIPS.md` explaining how a future session should use it: tune the tap
detector, finger-strike detection and key mapping until accuracy is as high as possible, and log accuracy before
and after per clip.

## Privacy and safety (very important)
- The app never uploads, records or saves camera video or microphone audio. Everything is processed on the device.
- **Rules for test clips (now and in future sessions):** clips must be stored only in a folder outside the repo
  (for example `~/private-clips/`), never inside the repo folder. Never commit, publish or screenshot clips, frames
  or audio from them, or anything extracted from them (tracked points, measurements), and never put them on the
  GitHub Pages site or in test output. Write these rules into CLIPS.md too, so future sessions follow them.
- Keep `screenshots/` and any test output folders in `.gitignore`. Screenshots must use a fake camera feed.
- The automated tests in this public repo use synthetic data only.
- Only use assets with a licence that allows reuse (CC0, CC-BY, Apache, MIT); list each in CREDITS.md.
- No network requests while playing, no tracking, no cookies, no eval, no secrets. Only localStorage (in try/catch).
- Plain ES modules, no build step, libraries and models copied into `vendor/` (if this environment can't download
  them, make a GitHub Actions workflow that fetches and commits them, then pull them down; say which route you
  used), an import map in index.html. Only well-known npm packages.
- Keep it working after every commit. If something breaks, undo it rather than stacking fixes on top.
- GitHub Actions: run the tests on every push to `main` and deploy to Pages only if they pass.

## How to check your work (before every commit)
1. Run the tests (headless Chromium with a fake camera and fake microphone): no console errors, the page loads,
   set-up and settings work, and synthetic taps and finger movements produce the right notes, chords and loudness.
2. Take screenshots (fake camera) of the app and the printable keyboard page, and look at them; fix anything ugly.
3. Commit with a clear message, one feature per commit, and push to `main`.

## Order of work
1. Setup: repo structure, vendored libraries and models, tests with a fake camera and microphone, deploy workflow,
   privacy rules in `.gitignore`. Get a first version live quickly.
2. The printable paper keyboard page with corner markers.
3. Paper detection and fingertip-to-key mapping, with the debug view and synthetic tests.
4. Microphone tap detection with loudness, and ignoring the app's own sound.
5. Piano sound engine, playable with the computer-keyboard controls.
6. Putting it together: taps plus finger strikes give notes and chords; note lengths; sustain.
7. Plain desk mode with calibration and recentring.
8. The clip-testing script and CLIPS.md, ready for later.
9. Polish: lower delay, set-up screen, settings, phone layout.
10. If all that's done early, keep refining whatever would make it feel most like a real piano.

## At the end
At about 18:25 UK time, stop starting new work, make sure `main` is deployed and working, and write a short summary
in plain English: what works, what was tested and how, the measured delay, the link to the live game, what isn't
done, and the best ideas for next time.

---

# Progress log

- **16:20** Started. Repo was empty. Wake-ups scheduled with `send_later` at 16:50, 17:20, 17:50, 18:20 UK.
- **16:25** Vendoring route: this environment *can* reach the npm registry and Google's model storage (but not
  github.com directly), so libraries/samples were downloaded here and committed directly — no fetch workflow needed.
  - `@mediapipe/tasks-vision@1.1.1` (Apache-2.0) → `vendor/mediapipe/` (SIMD wasm only; Pixel 7 Chrome has SIMD).
  - `hand_landmarker.task` (float16, Apache-2.0) → `vendor/models/`.
  - Salamander Grand Piano V3 (Alexander Holm, CC-BY 3.0) via npm `@audio-samples/piano-mp3-velocity{4,8,12,16}`
    (MIT packaging). Re-encoded with ffmpeg: C2–C7, every 3 semitones (C, D#, F#, A), 4 velocity layers,
    trimmed to 5–9 s with fade, 64 kbps stereo → 84 files, 4.6 MB total.
- **Decision (branch):** the session is set up to develop on `claude/desk-piano-app-4nwwo0`, while the brief says
  push to `main`. I push every commit to both: the session branch and `main` (main = what Pages deploys).
- **Decision (markers):** wrote a small custom square-marker detector (4×4-bit codes in a black frame) as a plain
  ES module rather than vendoring js-aruco2, which isn't an ES module.
- **16:42** First full version pushed to `main`: printable keyboard (`print.html`), marker detection +
  homography, MediaPipe hand tracking, AudioWorklet tap detector, strike detector, tap/strike fusion,
  Salamander piano engine, computer-keyboard + on-screen keys, settings, set-up dialog, debug view,
  plain desk mode with calibration/recentre. 19 unit tests + 5 headless-browser tests (fake camera/mic).
  - Decisions: 2-octave "smaller version" = C4–C6 life-size on 2 sheets (vs 3 sheets for C3–C6), because
    shrinking key width would make it unplayable. Full strip is 585 mm so sheet 3 is a narrow end piece.
  - On a tap, fingers still *descending* in the latest camera frame are played straight away (lowest
    delay) at their predicted touch-down point; if the actual landing is on a different key within 80 ms
    the note is corrected. Taps with no finger moving are dropped. Landings without a tap play after
    100 ms at a quiet velocity.
  - Fingertip motion is measured relative to 60% of its knuckle's motion so sliding the hand forward
    (which also moves it down the picture) isn't seen as a strike.
  - Tap detector: high-pass 250 Hz, peak follower; onset when it jumps >3× within 2 ms, >2.5× the 15 ms
    average and >4× the 80 ms background; 45 ms refractory; loudness = peak over the next 3 ms.
- **16:55** Clip-test script + CLIPS.md done; `--self-test` (synthetic paper video + tap sounds, temp
  folder only) passes: paper found in 20/20 analysed frames (12/12 markers), 3 taps heard, 0 notes (no hands).
- **17:00** Delay measured (`node scripts/measure-latency.mjs`, fake mic playing synthetic taps):
  tap detection → main thread median **4.6 ms** (max 5.9). Headless Chromium reports audio base 10 ms +
  output 32 ms + input 10 ms → **~57 ms tap→sound** on the fast path (finger already seen descending).
  On a real phone the output/input numbers will differ; the debug view shows the live values and the
  measured tap→sound average. Fixed a clock-mapping bug (was using the output timestamp for input).
