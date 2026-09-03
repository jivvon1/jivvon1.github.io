/* Correspondence + scan matching.
 *
 * Given features from sweep k (the "map") and sweep k+1 (the "query"), find for
 * every query feature the geometric primitive it should land on in the map, and
 * then move the query cloud until it does. That motion IS the relative pose.
 */
import { poseMat, apply } from './lio-core.js';

/* ------------------------------------------------------------------ NN ----
 * Uniform hash grid. Fast enough that the numeric Jacobian below can afford to
 * rebuild every correspondence seven times per iteration.
 */
export class Grid {
  constructor(feat, cell = 0.9) {
    this.f = feat; this.cell = cell; this.map = new Map();
    for (let i = 0; i < feat.n; i++) {
      const k = this.key(feat.xyz[3 * i], feat.xyz[3 * i + 1], feat.xyz[3 * i + 2]);
      let b = this.map.get(k);
      if (!b) this.map.set(k, b = []);
      b.push(i);
    }
  }
  key(x, y, z) {
    const c = this.cell;
    return (Math.floor(x / c) * 73856093) ^ (Math.floor(y / c) * 19349663) ^ (Math.floor(z / c) * 83492791);
  }
  /** Indices within `radius` cells of (x,y,z). */
  candidates(x, y, z, out) {
    out.length = 0;
    const c = this.cell;
    const gx = Math.floor(x / c), gy = Math.floor(y / c), gz = Math.floor(z / c);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = this.map.get(((gx + dx) * 73856093) ^ ((gy + dy) * 19349663) ^ ((gz + dz) * 83492791));
      if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
    }
    return out;
  }
}

const cand = [];
const MAX_ASSOC = 1.6;       // gate: a match further than this is not a match
const RING_SPAN = 3;         // "a nearby but different scan line"

function d2(f, i, x, y, z) {
  const dx = f.xyz[3 * i] - x, dy = f.xyz[3 * i + 1] - y, dz = f.xyz[3 * i + 2] - z;
  return dx * dx + dy * dy + dz * dz;
}

/* ------------------------------------------------- edge correspondence ----
 *          |  ij⃗ × il⃗ |
 *   d_E =  ------------      i: current edge point, j & l: two map edge points
 *            |  jl⃗ |         on DIFFERENT scan lines → they define the line.
 */
export function edgeMatch(grid, x, y, z) {
  const f = grid.f;
  grid.candidates(x, y, z, cand);
  let j = -1, bj = MAX_ASSOC * MAX_ASSOC;
  for (let k = 0; k < cand.length; k++) {
    const d = d2(f, cand[k], x, y, z);
    if (d < bj) { bj = d; j = cand[k]; }
  }
  if (j < 0) return null;
  let l = -1, bl = MAX_ASSOC * MAX_ASSOC * 2.4;
  for (let k = 0; k < cand.length; k++) {
    const i = cand[k];
    const dr = f.ring[i] - f.ring[j];
    if (dr === 0 || Math.abs(dr) > RING_SPAN) continue;   // must be a different scan line
    const d = d2(f, i, x, y, z);
    if (d < bl) { bl = d; l = i; }
  }
  if (l < 0) return null;
  return { j, l };
}

export function edgeResidual(f, m, x, y, z) {
  const jx = f.xyz[3 * m.j], jy = f.xyz[3 * m.j + 1], jz = f.xyz[3 * m.j + 2];
  const lx = f.xyz[3 * m.l], ly = f.xyz[3 * m.l + 1], lz = f.xyz[3 * m.l + 2];
  const ax = x - jx, ay = y - jy, az = z - jz;      // ij⃗ (from j to i)
  const bx = x - lx, by = y - ly, bz = z - lz;      // il⃗
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  const base = Math.hypot(jx - lx, jy - ly, jz - lz);
  if (base < 1e-4) return NaN;
  return Math.hypot(cx, cy, cz) / base;
}

/* ------------------------------------------------ planar correspondence ---
 *          | ij⃗ · ( jm⃗ × jl⃗ ) |
 *   d_H =  ---------------------   j,l on the SAME line, m on a different one:
 *              | jm⃗ × jl⃗ |        three points → the plane i should lie on.
 */
export function planeMatch(grid, x, y, z) {
  const f = grid.f;
  grid.candidates(x, y, z, cand);
  let j = -1, bj = MAX_ASSOC * MAX_ASSOC;
  for (let k = 0; k < cand.length; k++) {
    const d = d2(f, cand[k], x, y, z);
    if (d < bj) { bj = d; j = cand[k]; }
  }
  if (j < 0) return null;
  let l = -1, bl = Infinity, m = -1, bm = Infinity;
  for (let k = 0; k < cand.length; k++) {
    const i = cand[k];
    if (i === j) continue;
    const d = d2(f, i, x, y, z);
    if (d > MAX_ASSOC * MAX_ASSOC * 2.4) continue;
    if (f.ring[i] === f.ring[j]) { if (d < bl) { bl = d; l = i; } }
    else if (Math.abs(f.ring[i] - f.ring[j]) <= RING_SPAN) { if (d < bm) { bm = d; m = i; } }
  }
  if (l < 0 || m < 0) return null;
  return { j, l, m };
}

export function planeResidual(f, mm, x, y, z) {
  const j = mm.j, l = mm.l, m = mm.m;
  const jx = f.xyz[3 * j], jy = f.xyz[3 * j + 1], jz = f.xyz[3 * j + 2];
  const ux = f.xyz[3 * m] - jx, uy = f.xyz[3 * m + 1] - jy, uz = f.xyz[3 * m + 2] - jz;   // jm⃗
  const vx = f.xyz[3 * l] - jx, vy = f.xyz[3 * l + 1] - jy, vz = f.xyz[3 * l + 2] - jz;   // jl⃗
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nn = Math.hypot(nx, ny, nz);
  if (nn < 1e-5) return NaN;
  return Math.abs((x - jx) * nx + (y - jy) * ny + (z - jz) * nz) / nn;
}

/* --------------------------------------------------------------- solver ---
 * Damped Gauss-Newton on θ = (tx,ty,tz,roll,pitch,yaw). Correspondences are
 * re-found at every residual evaluation, so this is a full ICP-style loop, not
 * a one-shot linearisation.
 */
const PARAMS = ['x', 'y', 'z', 'roll', 'pitch', 'yaw'];
const STEP = [1e-4, 1e-4, 1e-4, 1e-5, 1e-5, 1e-5];

export function buildProblem(queryEdge, queryPlane, edgeGrid, planeGrid) {
  return { queryEdge, queryPlane, edgeGrid, planeGrid };
}

/** Find the correspondence for every query feature at pose θ. */
export function associate(prob, theta) {
  const m = poseMat(theta);
  const p = new Float64Array(3);
  const assoc = [];
  const { queryEdge, queryPlane, edgeGrid, planeGrid } = prob;
  for (let i = 0; i < queryEdge.n; i++) {
    apply(m, queryEdge.xyz[3 * i], queryEdge.xyz[3 * i + 1], queryEdge.xyz[3 * i + 2], p);
    const mt = edgeMatch(edgeGrid, p[0], p[1], p[2]);
    if (!mt) continue;
    const d = edgeResidual(edgeGrid.f, mt, p[0], p[1], p[2]);
    if (!Number.isFinite(d) || d > MAX_ASSOC) continue;
    assoc.push({ type: 'edge', i, m: mt, d, p: [p[0], p[1], p[2]] });
  }
  for (let i = 0; i < queryPlane.n; i++) {
    apply(m, queryPlane.xyz[3 * i], queryPlane.xyz[3 * i + 1], queryPlane.xyz[3 * i + 2], p);
    const mt = planeMatch(planeGrid, p[0], p[1], p[2]);
    if (!mt) continue;
    const d = planeResidual(planeGrid.f, mt, p[0], p[1], p[2]);
    if (!Number.isFinite(d) || d > MAX_ASSOC) continue;
    assoc.push({ type: 'plane', i, m: mt, d, p: [p[0], p[1], p[2]] });
  }
  return assoc;
}

/* Residuals for a FIXED correspondence set — the inner half of an ICP step.
 * Keeping the associations frozen while the Jacobian is probed is what makes
 * the linearisation well defined; they are refreshed at the next iteration. */
export function residualsFixed(prob, theta, assoc) {
  const m = poseMat(theta);
  const p = new Float64Array(3);
  const out = new Float64Array(assoc.length);
  for (let k = 0; k < assoc.length; k++) {
    const a = assoc[k];
    const src = a.type === 'edge' ? prob.queryEdge : prob.queryPlane;
    apply(m, src.xyz[3 * a.i], src.xyz[3 * a.i + 1], src.xyz[3 * a.i + 2], p);
    const f = a.type === 'edge' ? prob.edgeGrid.f : prob.planeGrid.f;
    const d = a.type === 'edge'
      ? edgeResidual(f, a.m, p[0], p[1], p[2])
      : planeResidual(f, a.m, p[0], p[1], p[2]);
    out[k] = Number.isFinite(d) ? d * (1 - 0.9 * Math.min(1, d / MAX_ASSOC)) : 0;
  }
  return out;
}

const rms = (r) => {
  if (!r.length) return NaN;
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i] * r[i];
  return Math.sqrt(s / r.length);
};

/** Association-refreshing cost: what the user actually sees as "residual". */
export function cost(prob, theta) {
  const a = associate(prob, theta);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i].d * a[i].d;
  return { rms: a.length ? Math.sqrt(s / a.length) : NaN, count: a.length, assoc: a };
}

/** One damped Gauss-Newton (Levenberg-Marquardt) step. */
export function gaussNewtonStep(prob, theta, lambda = 1e-3) {
  const assoc = associate(prob, theta);
  const M = assoc.length;
  if (M < 12) return { theta, rms: NaN, count: M, lambda, ok: false, assoc };

  const r0 = residualsFixed(prob, theta, assoc);
  const J = [];
  for (let k = 0; k < 6; k++) {
    const t2 = { ...theta };
    t2[PARAMS[k]] += STEP[k];
    const r1 = residualsFixed(prob, t2, assoc);
    const col = new Float64Array(M);
    for (let i = 0; i < M; i++) col[i] = (r1[i] - r0[i]) / STEP[k];
    J.push(col);
  }

  const H = new Float64Array(36), g = new Float64Array(6);
  for (let a = 0; a < 6; a++) {
    for (let i = 0; i < M; i++) g[a] += J[a][i] * r0[i];
    for (let b = a; b < 6; b++) {
      let s = 0;
      for (let i = 0; i < M; i++) s += J[a][i] * J[b][i];
      H[a * 6 + b] = H[b * 6 + a] = s;
    }
  }
  for (let a = 0; a < 6; a++) H[a * 6 + a] = H[a * 6 + a] * (1 + lambda) + 1e-9;

  const delta = solve6(H, g);
  const before = rms(r0);
  if (!delta) return { theta, rms: before, count: M, lambda: lambda * 4, ok: false, assoc };

  let scale = 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = { ...theta };
    for (let k = 0; k < 6; k++) next[PARAMS[k]] = theta[PARAMS[k]] + scale * delta[k];   // solve6 already returns −H⁻¹g
    const after = rms(residualsFixed(prob, next, assoc));
    if (Number.isFinite(after) && after <= before) {
      const c = cost(prob, next);
      return { theta: next, rms: c.rms, count: c.count, lambda: Math.max(1e-5, lambda * 0.5), ok: true, assoc: c.assoc };
    }
    scale *= 0.35;
  }
  return { theta, rms: before, count: M, lambda: Math.min(1, lambda * 6), ok: false, assoc };
}

/** Gaussian elimination with partial pivoting on the 6x6 normal equations. */
function solve6(Hin, gin) {
  const A = new Float64Array(42);
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) A[r * 7 + c] = Hin[r * 6 + c];
    A[r * 7 + 6] = -gin[r];
  }
  for (let c = 0; c < 6; c++) {
    let piv = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(A[r * 7 + c]) > Math.abs(A[piv * 7 + c])) piv = r;
    if (Math.abs(A[piv * 7 + c]) < 1e-12) return null;
    if (piv !== c) for (let k = c; k < 7; k++) { const t = A[c * 7 + k]; A[c * 7 + k] = A[piv * 7 + k]; A[piv * 7 + k] = t; }
    const d = A[c * 7 + c];
    for (let r = c + 1; r < 6; r++) {
      const f = A[r * 7 + c] / d;
      if (!f) continue;
      for (let k = c; k < 7; k++) A[r * 7 + k] -= f * A[c * 7 + k];
    }
  }
  const out = new Float64Array(6);
  for (let r = 5; r >= 0; r--) {
    let s = A[r * 7 + 6];
    for (let c = r + 1; c < 6; c++) s -= A[r * 7 + c] * out[c];
    out[r] = s / A[r * 7 + r];
  }
  return out.every(Number.isFinite) ? out : null;
}
