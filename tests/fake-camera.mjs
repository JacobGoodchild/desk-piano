// Builds a synthetic fake-camera video (.y4m) of the printed paper keyboard seen from across the
// desk, in the system temp folder. Used by browser tests and screenshots via Chromium's
// --use-file-for-fake-video-capture. Never uses real camera footage.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paperLayout } from '../src/paper.js';
import { fitHomography } from '../src/homography.js';
import { renderPaperScene, sceneHomography } from './synth.mjs';

export function makeFakeCameraY4M({ variant = 'full', w = 960, h = 540, frames = 10 } = {}) {
  const L = paperLayout(variant);
  const { src, dst } = sceneHomography(L, w, h, { tilt: 0.35, rotate: 0.04 });
  const H = fitHomography(src, dst);
  const grey = renderPaperScene(L, H, w, h, { bg: 70 });
  // tint the desk around the paper a warm wood colour: Y from grey, constant U/V
  const ySize = w * h, cSize = (w / 2) * (h / 2);
  const frame = Buffer.alloc(ySize + cSize * 2);
  frame.set(grey, 0);
  frame.fill(118, ySize, ySize + cSize); // U
  frame.fill(140, ySize + cSize); // V (slightly warm)
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < frames; i++) parts.push(Buffer.from('FRAME\n'), frame);
  const dir = mkdtempSync(join(tmpdir(), 'dp-fakecam-'));
  const file = join(dir, 'paper.y4m');
  writeFileSync(file, Buffer.concat(parts));
  return { file, dir, H, layout: L };
}
