// The printable paper keyboard: where the keys, markers and sheet joins are, in mm.
// Everything is in "paper coordinates": the keyboard coordinates of layout.js shifted so
// x = 0 is the left edge of the whole strip (including the end columns) and y = 0 is the
// back edge of the marker strip (farthest from the player).
import { KeyboardLayout } from './layout.js';
import { markerSVG } from './markers.js';
import { noteName, isBlack } from './notes.js';
import { fitHomography, applyH } from './homography.js';

export const PAGE = { w: 297, h: 210, margin: 10, overlap: 15 };
export const MARKER_SIZE = 24;
const END_COL = 34; // columns beyond each end of the keys holding front/back markers
const BACK_STRIP = 34; // strip behind the keys holding markers

export const VARIANTS = {
  full: { id: 'full', label: '3 octaves, C3–C6 (3 sheets)', low: 48, high: 84 },
  compact: { id: 'compact', label: '2 octaves, C4–C6 (2 sheets)', low: 60, high: 84 },
};

export function paperLayout(variantId = 'full') {
  const v = VARIANTS[variantId] || VARIANTS.full;
  const kb = new KeyboardLayout(v.low, v.high);
  const keysX = END_COL, keysY = BACK_STRIP;
  const width = kb.width + END_COL * 2;
  const height = BACK_STRIP + kb.whiteLen;
  const usable = PAGE.w - PAGE.margin * 2;
  const step = usable - PAGE.overlap;
  const pages = [];
  for (let x0 = 0; ; x0 += step) {
    pages.push({ x0, x1: Math.min(x0 + usable, width) });
    if (x0 + usable >= width) break;
  }
  // markers: back strip, spread evenly but kept away from sheet joins; plus front markers in the end columns
  const markers = [];
  let id = 0;
  const m = MARKER_SIZE;
  const backY = (BACK_STRIP - m) / 2;
  const joins = pages.slice(1).map((p) => [p.x0 - 4, p.x0 + PAGE.overlap + 4]);
  const clear = (x) => joins.every(([a, b]) => x + m < a || x > b);
  const want = Math.max(4, Math.round(width / 70));
  for (let i = 0; i < want; i++) {
    let x = 5 + (i * (width - 10 - m)) / (want - 1);
    for (let tries = 0; tries < 40 && !clear(x); tries++) x += (i < want / 2 ? 1 : -1) * 3;
    if (clear(x)) markers.push({ id: id++, x, y: backY, size: m });
  }
  const frontY = BACK_STRIP + kb.whiteLen - m - 8;
  const midY = BACK_STRIP + kb.blackLen - m;
  for (const x of [(END_COL - m) / 2, width - END_COL + (END_COL - m) / 2]) {
    markers.push({ id: id++, x, y: midY, size: m });
    markers.push({ id: id++, x, y: frontY, size: m });
  }
  return { variant: v, kb, keysX, keysY, width, height, pages, markers };
}

// Marker corner positions in paper coordinates (TL, TR, BR, BL), keyed by id.
export function markerCorners(layout) {
  const out = {};
  for (const mk of layout.markers) {
    const { x, y, size: s } = mk;
    out[mk.id] = [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
  }
  return out;
}

// The tracked fingertip point is a few mm above the paper; seen from the camera (across the desk,
// looking down) it projects a little towards the player. Pull it back by this much.
export const TIP_OFFSET_MM = 5;

// paper coords → key under that point (or null)
export function paperToKey(layout, x, y, tipOffset = 0) {
  return layout.kb.keyAt(x - layout.keysX, y - layout.keysY - tipOffset);
}

// The whole strip as SVG content (mm units). Used by the print page and synthetic scenes.
export function stripSVG(layout, { labels = true } = {}) {
  const { kb, keysX, keysY } = layout;
  let s = `<rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="#fff"/>`;
  for (const k of kb.keys) if (!k.black) {
    s += `<rect x="${keysX + k.x0}" y="${keysY}" width="${kb.whiteW}" height="${kb.whiteLen}" fill="#fff" stroke="#000" stroke-width="0.6"/>`;
  }
  for (const k of kb.keys) if (k.black) {
    s += `<rect x="${keysX + k.x0}" y="${keysY}" width="${k.x1 - k.x0}" height="${kb.blackLen}" fill="#111"/>`;
  }
  if (labels) {
    for (const k of kb.keys) if (!k.black) {
      const cx = keysX + (k.x0 + k.x1) / 2;
      const isMid = k.midi === 60;
      s += `<text x="${cx}" y="${keysY + kb.whiteLen - 8}" font-size="${isMid ? 5 : 3.6}" font-weight="${isMid ? 700 : 400}" text-anchor="middle" fill="${isMid ? '#c00' : '#666'}" font-family="sans-serif">${noteName(k.midi)}</text>`;
      if (isMid) {
        s += `<circle cx="${cx}" cy="${keysY + kb.whiteLen - 20}" r="3" fill="none" stroke="#c00" stroke-width="0.8"/>`;
        s += `<text x="${cx}" y="${keysY + kb.whiteLen - 2.5}" font-size="3" text-anchor="middle" fill="#c00" font-family="sans-serif">middle C</text>`;
      }
    }
  }
  for (const mk of layout.markers) s += markerSVG(mk.id, mk.x, mk.y, mk.size);
  return s;
}

export { isBlack };

// Fit the paper → image homography from detected markers, dropping any marker that disagrees
// with the others (a misread or a marker-like pattern elsewhere). Returns
// { H, used: Set(ids), error (px, median corner error) } or null if there's not enough to go on.
export function fitPaper(layout, found, scale = 1) {
  const known = markerCorners(layout);
  let ms = [];
  const seen = new Set();
  for (const m of found) {
    if (!known[m.id] || seen.has(m.id)) continue; // ignore unknown and duplicate ids
    seen.add(m.id);
    ms.push({ id: m.id, src: known[m.id], dst: m.corners.map((c) => ({ x: c.x * scale, y: c.y * scale })) });
  }
  const fit = (list) => fitHomography(list.flatMap((m) => m.src), list.flatMap((m) => m.dst));
  const errOf = (H, m) => Math.max(...m.src.map((p, i) => { const q = applyH(H, p.x, p.y); return Math.hypot(q.x - m.dst[i].x, q.y - m.dst[i].y); }));
  for (let round = 0; round < 3 && ms.length >= 2; round++) {
    const H = fit(ms);
    if (!H) return null;
    const errs = ms.map((m) => errOf(H, m));
    const sorted = [...errs].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const size = Math.sqrt(Math.abs(polyArea(ms[0].dst)));
    const limit = Math.max(3 * med, 0.25 * size, 3);
    const keep = ms.filter((m, i) => errs[i] <= limit);
    if (keep.length === ms.length || keep.length < 2) return { H, used: new Set(ms.map((m) => m.id)), error: med };
    ms = keep;
  }
  if (ms.length < 2) return null;
  const H = fit(ms);
  return H ? { H, used: new Set(ms.map((m) => m.id)), error: 0 } : null;
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const p = q[i], r = q[(i + 1) % q.length]; a += p.x * r.y - r.x * p.y; }
  return a / 2;
}
