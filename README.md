# Desk Piano

Play the piano on a **printed paper keyboard** taped to your desk. A camera watches your hands to see
*which* finger pressed; the microphone hears the "tok" of each tap to know *when* and *how loud*. The
app plays a real grand piano (Salamander Grand Piano) — or an electric piano, organ, harpsichord or
strings.

- **Play it:** https://jacobgoodchild.github.io/desk-piano/
- **Print the keyboard:** https://jacobgoodchild.github.io/desk-piano/print.html (A4 landscape, 100% scale)

Everything runs in your browser. Camera and microphone are analysed on the device and never recorded,
saved or uploaded. Once you have played while online, it also works offline.

## Quick start

1. Print the keyboard (3 sheets, or 2 for the smaller C4–C6 version), cut along the dashed lines,
   tape the sheets together and tape them to the desk.
2. Put a phone (front camera, screen facing you, landscape) or a webcam on the **far side** of the
   paper, facing you, tilted down at your hands. Headphones are best.
3. Press **Start**. The set-up screen ticks off: piano loaded, microphone hearing taps, camera,
   hand-tracking speed, both hands, and every paper marker (missing ones are outlined red).
   The numbered steps tick themselves off as each one is done.
4. Optional but recommended: **Teach my fingers** (set-up screen) — tap 3 times with each finger.
5. Optional: **Check accuracy** (set-up screen) — play C D E F G F E D C. If it got notes wrong, the
   app replays what you played with slightly different detection settings and offers to keep the
   ones that suit you (**Forget** undoes it). Finishing a *Follow a tune* piece offers the same.
6. Play. Tap firmly enough that the mic hears it (watch the green "Mic" bar).

No paper? Press **Desk** in the top bar and tap middle C, then the C above, to calibrate (optionally
a third tap two octaves above middle C makes the far ends more accurate). **R** recentres.

The green **Mic** bar flashes green when a tap became a note, and orange when a tap was heard but no
finger was seen pressing (move the camera, or keep the other fingers still). **Set-up → Check
accuracy** gives a quick score on a short exercise. Orange dots on the on-screen keyboard show the
key under each fingertip the camera sees — check they match your fingers before you play.

**Follow a tune** (beside the camera picture): pick a tune — scale, Mary had a little lamb, Twinkle
twinkle, Ode to joy, Frère Jacques, chromatic scale, Für Elise, Minuet in G, Jingle bells, Amazing grace —
and the next key lights up green; it moves on
when you play the right note and counts wrong ones.

No microphone (or you didn't allow it)? The app still plays clear finger strikes from the camera
alone — quieter and less reliable (hovering hands can set notes off), so allow the mic if you can.

## Controls

- **Pedal** button or **Space** = sustain pedal (Settings: "Pedal always on"). A USB/Bluetooth foot pedal
  ("page turner": Page Up/Down or arrow keys) or a MIDI sustain pedal (after MIDI → Find devices) works too.
- **● Rec** records what you play; **▶ Play back**; **Save .mid** downloads a MIDI file.
- Volume slider, **⛶** full screen (locks phones to landscape).
- Computer keys **A–;** play C4–E5 (W E T Y U O P = black keys), **Z / X** octave, Shift = loud,
  Ctrl = soft. You can also tap the on-screen keys.
- **♩** metronome. Settings: sound (grand, bright, honky-tonk, electric piano, organ, harpsichord, strings,
  vibraphone, music box, bass), layer two sounds, split below middle C, reverb, touch (light/normal/
  heavy), loudness from taps or fixed, keyboard range / octave / transpose,
  tap sensitivity, "faster ↔ more accurate", chords within one hand, camera/microphone choice,
  MIDI output to a real keyboard/synth/app, note trail, debug view (also `?debug=1`).

## How it decides which note

When the microphone hears a tap, the app looks at the last quarter-second of hand tracking and picks
the finger that came down more than the rest of that hand — so hovering or resting hands don't play,
and moving your whole hand doesn't play a chord. "Teach my fingers" learns how your fingers move
together (e.g. the ring finger is dragged along by the middle finger) and uses that to pick the right
one. See `CLAUDE.md` (progress log) for the measurements behind these choices.

## Developer notes

No build step — plain ES modules. `npm test` runs unit tests (Node) and browser tests (headless
Chromium with a fake camera and microphone, synthetic data only). `scripts/clip-test.mjs` scores the
detection against real recordings kept **outside** the repo (see `CLIPS.md` for the rules).
`CREDITS.md` lists every third-party asset and its licence.

Main pieces: `src/app.js` (wiring and UI), `src/tap-resolver.js` + `src/tap-fusion.js` (which finger
pressed, decided on each heard tap), `src/onset.js` + `src/tap-worklet.js` (tap detector),
`src/markers.js` + `src/paper.js` (finding the printed paper), `src/desk.js` (plain desk mode),
`src/auto-tune.js` (personal tuning), `src/piano.js` / `src/synths.js` (sounds), `sw.js` (offline).
Useful scripts: `scripts/measure-latency.mjs` (delay), `scripts/measure-instruments.mjs` (levels),
`scripts/screenshots.mjs` (fake-camera screenshots into the git-ignored `screenshots/`).
