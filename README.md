# Desk Piano

Play the piano on a **printed paper keyboard** taped to your desk. A camera watches your hands to see
*which* keys your fingers land on; the microphone hears the "tok" of each tap to know *when* and *how
loud*. The app plays a real grand piano sound (Salamander Grand Piano).

- **Play it:** https://jacobgoodchild.github.io/desk-piano/
- **Print the keyboard:** https://jacobgoodchild.github.io/desk-piano/print.html (A4 landscape, 100% scale)

Everything runs in your browser. Camera and microphone are analysed on the device and never recorded,
saved or uploaded.

Developer notes: no build step — plain ES modules. `npm test` runs unit tests (Node) and browser tests
(headless Chromium with a fake camera and microphone, synthetic data only). See `CLAUDE.md` for the
brief and progress log, `CLIPS.md` for testing against real recordings, `CREDITS.md` for licences.
