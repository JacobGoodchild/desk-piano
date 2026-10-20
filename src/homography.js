// Planar homography helpers. H is a 9-element row-major array mapping (x, y) → (u, v).

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((v) => v / det);
}

function normaliser(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
  const s = Math.SQRT2 / (d / pts.length || 1);
  return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], s, mx, my };
}

function mul(A, B) {
  const R = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) R[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return R;
}

function solve(M, rhs) {
  const n = rhs.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    [rhs[col], rhs[piv]] = [rhs[piv], rhs[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (!f) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
      rhs[r] -= f * rhs[col];
    }
  }
  return rhs.map((v, i) => v / M[i][i]);
}

// Least-squares homography from src[i] → dst[i] (at least 4 pairs), normalised DLT with h33 = 1.
export function fitHomography(src, dst) {
  if (src.length < 4) return null;
  const ns = normaliser(src), nd = normaliser(dst);
  const ATA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const ATb = new Array(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const x = (src[i].x - ns.mx) * ns.s, y = (src[i].y - ns.my) * ns.s;
    const u = (dst[i].x - nd.mx) * nd.s, v = (dst[i].y - nd.my) * nd.s;
    const rows = [
      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
      [[0, 0, 0, x, y, 1, -v * x, -v * y], v],
    ];
    for (const [r, b] of rows) {
      for (let p = 0; p < 8; p++) {
        ATb[p] += r[p] * b;
        for (let q = 0; q < 8; q++) ATA[p][q] += r[p] * r[q];
      }
    }
  }
  const h = solve(ATA, ATb);
  if (!h) return null;
  const Hn = [...h, 1];
  const TdInv = invertH(nd.T);
  const H = mul(mul(TdInv, Hn), ns.T);
  return H.map((v) => v / H[8]);
}
