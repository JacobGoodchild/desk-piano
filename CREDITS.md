# Credits and licences

Every third-party asset used by Desk Piano, with its licence. All allow reuse.

| What | Where it lives | Author / source | Licence |
|---|---|---|---|
| **Salamander Grand Piano V3** piano samples (re-encoded: C2–C7 every 3 semitones, velocity layers 4/8/12/16 of 16, trimmed to 4–9 s, 64 kbps MP3) | `samples/piano/` | Alexander Holm — https://archive.org/details/SalamanderGrandPianoV3 | **CC BY 3.0** — https://creativecommons.org/licenses/by/3.0/ |
| Salamander Grand Piano V3 **release (damper) samples**, 21 of 88 re-encoded (1.2 s, 48 kbps) | `samples/piano/rel*.mp3` | Alexander Holm (via npm `@audio-samples/piano-mp3-release` 1.0.5) | **CC BY 3.0** |
| MP3 packaging of the Salamander samples (npm `@audio-samples/piano-mp3-velocity{4,8,12,16}` v1.0.5) | (source of the files above) | Jan Forst — https://github.com/darosh/samples-piano-mp3 | MIT (packaging); samples remain CC BY 3.0 |
| **MediaPipe Tasks Vision** v1.1.1 (hand landmarker JS + WebAssembly) | `vendor/mediapipe/` | Google — npm `@mediapipe/tasks-vision` | **Apache 2.0** |
| **Hand landmarker model** (`hand_landmarker.task`, float16) | `vendor/models/` | Google MediaPipe — storage.googleapis.com/mediapipe-models | **Apache 2.0** |
| Playwright (tests only, not shipped) | `devDependencies` | Microsoft | Apache 2.0 |

Changes made to the Salamander samples: trimmed, faded out at the end, re-encoded at a lower bitrate,
and only a subset of notes and velocity layers kept. Attribution: *Salamander Grand Piano V3 by
Alexander Holm, licensed under CC BY 3.0.*

All other code in this repository was written for this project.
