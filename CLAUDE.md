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
- **16:44** Clip-test script + CLIPS.md done; `--self-test` (synthetic paper video + tap sounds, temp
  folder only) passes: paper found in 20/20 analysed frames (12/12 markers), 3 taps heard, 0 notes (no hands).
- **16:46** Delay measured (`node scripts/measure-latency.mjs`, fake mic playing synthetic taps):
  tap detection → main thread median **4.6 ms** (max 5.9). Headless Chromium reports audio base 10 ms +
  output 32 ms + input 10 ms → **~57 ms tap→sound** on the fast path (finger already seen descending).
  On a real phone the output/input numbers will differ; the debug view shows the live values and the
  measured tap→sound average. Fixed a clock-mapping bug (was using the output timestamp for input).
- **16:50** Browser tests now also drive the *real camera path*: Chromium's fake camera plays a synthetic
  video of the printed paper (generated into the temp folder) and the app finds 12/12 markers and maps
  middle C correctly. Screenshots use the same fake feed.
  - Decision: default camera is the **front** camera on phones (`facingMode: user`), because with the
    phone on the far side of the paper facing you, that's the only way you can also see the screen.
    The picture is mirrored by default (setting) so left/right matches your view.
  - Decision: hands get stable ids by wrist position (MediaPipe's Left/Right label flickers and is
    mirrored), so a label flip can't cut notes short.
- **16:56** Set-up screen (big preview, steps, per-marker red/green outlines, opens on first visit);
  learnt loudness range (`VelocityMapper`: after ~8 taps your own softest→pp, hardest→ff); screen wake
  lock; paper re-detected every 10th frame once found (saves phone CPU); fast-run fusion fix (synthetic
  runs at 10–14 notes/s all correct). Live site checked in headless Chromium: loads, no console errors.
- **16:58** Sound levels (`node scripts/measure-sound.mjs`, offline render): single C4 pp −50 dB rms,
  mf −39, ff −26 (≈24 dB range); 10-note ff chord peaks 0.99 through a soft-knee limiter with 2× headroom
  (no hard clipping, no added delay — a DynamicsCompressor would add ~6 ms look-ahead).
- **17:05** Damper release sounds (Salamander release samples, subtle level); paper fit now drops
  misread markers and won't replace a good fit with a 2-marker one; MediaPipe timestamp guard; phone
  rotation; fixed double-counted input delay in the tap→sound figure; loudness learner only learns from
  taps that became notes; clip tester `--sweep`. Marker stress test (synthetic blur + uneven light):
  at 960 px wide (what the app uses) 9–12 of 12 markers found in every case; at 640 px small far
  markers start to drop (5–12). Detection takes ~15–20 ms per 960 px frame in Node.
- **17:14** Phone portrait layout; tip-height correction (`TIP_OFFSET_MM` = 5 mm, tunable); speakers/
  headphones and camera changes apply immediately (mic/camera restart, tested); set-up side-view diagram;
  print-page wording fixes (footer said "camera on THIS side" on the player's edge). All CI runs green;
  every push to `main` redeploys https://jacobgoodchild.github.io/desk-piano/.
- **17:20–17:50** The session's worker was restarted and lost about 35 minutes; nothing was lost (all
  work was already pushed). Wake-ups at 16:50/17:20/17:50 arrived late but were handled.
- **17:55** Wrapped up: latest `main` passed CI and is deployed; live site checked.

## End-of-session summary (20 Oct)

**Live:** https://jacobgoodchild.github.io/desk-piano/ (print the keyboard from the "Print keyboard" link).

**What works**
- Printable life-size keyboard, C3–C6 on 3 A4 sheets (or C4–C6 on 2), with cut/overlap/tape marks,
  a 10 cm scale check, note names, middle C in red, and 10–12 square markers the camera locks onto.
- Paper finding: custom marker detector + homography; ignores misread markers; red/green marker
  outlines on the set-up screen.
- Hand tracking (MediaPipe, both hands), finger-strike detection, microphone tap detection in an
  AudioWorklet, and the rules from the brief: tap = when + how loud, camera = which key; chords; no
  notes from talking/knocks; quiet camera-only notes when a tap is missed; echo protection in speaker
  mode; notes last until the finger lifts; sustain pedal (Space, button, "always on").
- Salamander grand piano: 4 velocity layers, crossfaded, damper release sounds, learnt loudness range.
- Plain desk mode with calibration (middle C, then C5) and recentre (button or R).
- Set-up screen, settings, debug view (`?debug=1`), computer-keyboard and touch-screen playing,
  phone landscape/portrait layouts, front camera + mirrored picture by default, screen kept awake.

**How it was tested** (synthetic data only): 23 unit tests (geometry, markers in rendered camera
scenes, tap detection incl. fast repeats and speech-like sound, strikes + taps → notes/chords/fast runs/
echo/false taps, hand ids) and 5 browser tests in headless Chromium with a fake camera and microphone
(incl. a fake camera video of the paper, which the app finds 12/12 markers in). CI runs them on every
push to `main` and only deploys if they pass. Screenshots taken with the fake feed and checked.

**Measured delay:** tap detection → app ≈ 5 ms. Total tap → sound ≈ 57 ms in headless Chromium
(most of that is the browser's reported audio output path). On the phone, read the live figure in the
debug view.

**Not done / unknown**
- Nothing has been tried with real hands, a real phone, or real taps yet — all thresholds are
  educated guesses until the clip session.
- No offline/service-worker caching; no half-pedalling.

**Best next steps**
1. Clip session: follow CLIPS.md (`node scripts/clip-test.mjs ~/private-clips --verbose`, then `--sweep`).
2. Try it on the Pixel 7: check frame rate, the tap→sound figure in the debug view, and whether the
   front camera sees all markers; adjust `TIP_OFFSET_MM` if black/white keys get confused.
3. If delay feels high, use landings from a 60 fps camera and trust the "descending finger" guess more.

---

# Overnight run (20 Oct 19:53 → 21 Oct 06:40 UK)

## What Jacob asked for (from chat)
Work all night until **06:40 UK**, improving, using his real clips (stored ONLY in `~/private-clips/`,
outside the repo — never commit/publish/screenshot them or anything extracted from them; aggregate
accuracy numbers only in this log). If nothing left, add features (e.g. other keyboard sounds like
electric piano/organ). His feedback from trying it:
1. Hovering hands over the paper trigger lots of keys at once → must not.
2. It sometimes tracks the wrong finger → should be the finger actually pressing.
3. Webcam was high up so the mic barely heard taps → (mic choice, adapt to quiet taps).
4. Sound too quiet → louder + volume control.
5. "Missing desk mode" → it exists in Settings but is too hidden → make it obvious on the main screen.
He printed the 3-sheet keyboard. Clips (expected notes in `~/private-clips/notes.txt`):
hovering (none), resting hands (none), middle C ×4, C-E-G chord ×2, Mary Had a Little Lamb simple
(E D C D E E E D D D E G G "pretty much") and complex, part of Pirates of the Caribbean, chromatic
scale two octaves with thumb-under. (He uploaded the hovering clip twice — identical file.)

## Wake-ups
`send_later` every 30 min from 20:20 to 06:20 UK (rate-limited, scheduled in batches) + final wrap-up.

## Log
- **19:55** Clips copied to `~/private-clips/`. Found his webcam video is **mirrored**: marker detector
  found 0/12 markers as-is, 12/12 when flipped → detector now also reads mirrored markers (test added).
- **19:57** Clip tester bug: MediaPipe timestamps restarted per batch → fixed (global clock).
- **20:05 BASELINE** (`clip-test`, defaults): overall **8.5%** (10 correct of 19 expected, 118 detected).
  Per clip: hovering 55 false chords; resting 11 false; middle C ×4 18% (11 detected); CEG ×2 0% (9
  detected); Mary simple 25% (32 detected). Taps heard per clip: 0–2 (!). Almost every note came from
  the camera-only path. Matches Jacob's experience exactly.
- Also added: volume slider (default 120%, +6 dB vs before), Paper/Desk switch in the header,
  microphone picker in Settings.
- **20:20** Audio: Jacob's webcam mic hears taps only 15–25 dB above the room noise (taps at −58…−73 dBFS!)
  and webcam AAC smears the attack over ~10 ms. Tap detector now uses a learnt background floor and a
  15 ms rise window → middle-C clip: all 4 taps found (was 1).
- **20:30** Camera findings (private analysis): his whole hand drops with 3–5 fingertips touching the paper
  on every note, so "which finger" can't come from a landing detector. Fingertip landmark sits ~where
  the pad touches (key mapping columns are right). Chords (C-E-G) show NO per-finger signal in this
  footage — probably unsolvable from one low camera; single notes do have a signal.
- **20:40** New engine `TapFusion` + `TapResolver` (tap-first): on each heard tap, look at the last 250 ms
  and pick the finger whose downward travel (+ travel in the last 100 ms) most exceeds the hand's median
  finger; require it to still be moving down just before the tap. Camera-only notes off by default.
  Clip results with defaults: **43.9% overall** (was 8.5%): middle C 4/4 (+1 extra), Mary simple 12/26
  correct, chromatic 9/25, hovering 1 false (was 55), resting 2 false (was 11), CEG 0/2 (picks D).
  Sweep best ≈ 47% (no chords). Waiting 70 ms after the tap for the landing frame matters (46% vs 37%
  at 35 ms) → will be a "faster ↔ more accurate" setting.
- **20:30** (times above ran ~15 min fast) Engine refinements, each checked on clips: compare against
  the 2nd-least-moved finger (typicalRank 1), one note per hand per tap by default (chords optional:
  they cost ~7 points on these clips because the C-E-G clip has no per-finger signal), repeated-note
  fallback (0.6 s) → **49.1%**. Tried and rejected (no gain or worse): ring-finger→middle credit,
  landmark smoothing, other look-back windows. Second hand only joins a tap if it moved ≥60% as
  decisively. Desk-mode calibration now tap-first too. App wired to the new engine (settings: engine,
  response accurate/fast, chords within a hand). In `?sim=1` test mode the fake mic's beeps are ignored.
