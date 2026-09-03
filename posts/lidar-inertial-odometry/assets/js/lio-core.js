/* LIO core — the math behind "two sweeps in, one relative pose out".
 *
 * Everything here is deliberately the textbook LOAM/LIO-SAM pipeline, not an
 * approximation of it: a real ray-cast sweep (so motion distortion is a genuine
 * artefact, not a drawn one), the LOAM curvature, the edge/planar residuals
 * exactly as written in the paper, and a damped Gauss-Newton over the 6-DoF
 * relative pose. The viewer only draws what this file computes.
 */

export const RINGS = 16;          // VLP-16
export const AZ = 256;            // azimuth samples per ring
export const MAX_RANGE = 36;
const D2R = Math.PI / 180;
const ELEV_MIN = -15, ELEV_MAX = 15;

export const elevationOf = (r) => (ELEV_MIN + (ELEV_MAX - ELEV_MIN) * r / (RINGS - 1)) * D2R;

/* ---------------------------------------------------------------- world ---
 * Axis-aligned rectangles extruded in +y. Corners between two faces are what
 * become edge features; the faces themselves become planar features.
 */
export const WALLS = [];   // [x1,z1,x2,z2,height]
export const BLOCKS = [];  // [cx,cz,w,d,h] — same geometry, for rendering

function addRect(cx, cz, w, d, h, render = true) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  WALLS.push([x0, z0, x1, z0, h], [x1, z0, x1, z1, h], [x1, z1, x0, z1, h], [x0, z1, x0, z0, h]);
  if (render) BLOCKS.push([cx, cz, w, d, h]);
}

export const ROOM = { w: 27, d: 21, h: 6 };
addRect(0, 0, ROOM.w, ROOM.d, ROOM.h, false);
[[-6.8, 4.6, 1.4, 1.4, 4.4], [5.6, -3.4, 1.9, 1.9, 4.4], [7.8, 5.6, 1.1, 1.1, 4.4],
 [-4.2, -6.6, 5.6, 2.2, 3.2], [9.2, -6.2, 2.4, 2.4, 3.6], [-9.5, -2.0, 2.0, 4.4, 3.0]]
  .forEach(p => addRect(p[0], p[1], p[2], p[3], p[4]));

/** Nearest hit along a world ray, or -1. Ground plane y=0 plus every wall segment. */
export function raycast(ox, oy, oz, dx, dy, dz) {
  let best = MAX_RANGE, hit = false;
  if (dy < -1e-6) { const t = -oy / dy; if (t > 0.05 && t < best) { best = t; hit = true; } }
  for (let i = 0; i < WALLS.length; i++) {
    const w = WALLS[i];
    const ex = w[2] - w[0], ez = w[3] - w[1];
    const den = dx * ez - dz * ex;
    if (den > -1e-9 && den < 1e-9) continue;
    const rx = w[0] - ox, rz = w[1] - oz;
    const t = (rx * ez - rz * ex) / den;
    if (t <= 0.05 || t >= best) continue;
    const u = (rx * dz - rz * dx) / den;
    if (u < 0 || u > 1) continue;
    const y = oy + t * dy;
    if (y < 0 || y > w[4]) continue;
    best = t; hit = true;
  }
  return hit ? best : -1;
}

/* ----------------------------------------------------------------- pose ---
 * {x,y,z,roll,pitch,yaw}; rotation is Ry(yaw)·Rx(pitch)·Rz(roll) stored as a
 * flat column-major 4x4 so the solver can transform points without allocating.
 */
export function poseMat(p) {
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
  const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
  const cr = Math.cos(p.roll), sr = Math.sin(p.roll);
  // Ry * Rx * Rz, written out column-major (m[0..2] = first column).
  return new Float64Array([
    cy * cr + sy * sp * sr, cp * sr, -sy * cr + cy * sp * sr, 0,
    -cy * sr + sy * sp * cr, cp * cr, sy * sr + cy * sp * cr, 0,
    sy * cp, -sp, cy * cp, 0,
    p.x, p.y, p.z, 1
  ]);
}

export function invMat(m) {
  const out = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = m[r * 4 + c];  // Rᵀ
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  out[15] = 1;
  return out;
}

export function apply(m, x, y, z, out, o = 0) {
  out[o]     = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

export function mulMat(a, b) {   // a·b
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

export const lerpPose = (a, b, f) => ({
  x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f,
  roll: a.roll + (b.roll - a.roll) * f, pitch: a.pitch + (b.pitch - a.pitch) * f,
  yaw: a.yaw + (b.yaw - a.yaw) * f
});

/** Relative pose b⊖a as a 4x4 (a⁻¹·b) turned back into pose components. */
export function relPose(a, b) {
  const m = mulMat(invMat(poseMat(a)), poseMat(b));
  return { x: m[12], y: m[13], z: m[14], ...eulerOf(m) };
}

export function eulerOf(m) {
  // Inverse of poseMat: pitch from -m[9] (= -R21), then yaw and roll.
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[9])));
  const cp = Math.cos(pitch);
  if (Math.abs(cp) < 1e-6) return { roll: 0, pitch, yaw: Math.atan2(-m[2], m[0]) };
  return { roll: Math.atan2(m[1], m[5]), pitch, yaw: Math.atan2(m[8], m[10]) };
}

/* ---------------------------------------------------------------- sweep ---
 * One revolution. Azimuth index a is also a timestamp: the sensor is at
 * lerp(start,end,a/AZ) when that column is measured. That single fact is the
 * whole origin of motion distortion — and of why LIO-SAM needs the IMU.
 */
export function simulateSweep(poseStart, poseEnd) {
  const n = RINGS * AZ;
  const raw = new Float32Array(3 * n);     // naive assembly: local points stacked as-is
  const fixed = new Float32Array(3 * n);   // deskewed into the end frame
  const world = new Float32Array(3 * n);
  const valid = new Uint8Array(n);
  const ei = invMat(poseMat(poseEnd));
  for (let a = 0; a < AZ; a++) {
    const f = a / AZ;
    const m = poseMat(lerpPose(poseStart, poseEnd, f));
    const az = f * Math.PI * 2;
    const ca = Math.cos(az), sa = Math.sin(az);
    for (let r = 0; r < RINGS; r++) {
      const el = elevationOf(r), ce = Math.cos(el), se = Math.sin(el);
      const lx = ce * ca, ly = se, lz = ce * sa;                       // sensor-frame direction
      const dx = m[0] * lx + m[4] * ly + m[8] * lz;
      const dy = m[1] * lx + m[5] * ly + m[9] * lz;
      const dz = m[2] * lx + m[6] * ly + m[10] * lz;
      const t = raycast(m[12], m[13], m[14], dx, dy, dz);
      const i = r * AZ + a;
      if (t < 0) continue;
      valid[i] = 1;
      const wx = m[12] + t * dx, wy = m[13] + t * dy, wz = m[14] + t * dz;
      world[3 * i] = wx; world[3 * i + 1] = wy; world[3 * i + 2] = wz;
      apply(ei, wx, wy, wz, fixed, 3 * i);                            // correct: uses pose at time a
      raw[3 * i] = lx * t; raw[3 * i + 1] = ly * t; raw[3 * i + 2] = lz * t;   // wrong: pretends pose_end
    }
  }
  return { raw, fixed, world, valid, n };
}

/* ------------------------------------------------------------ curvature ---
 *  c = ‖ Σ_{j∈S, j≠i} (P_i − P_j) ‖ / ( |S| · ‖P_i‖ )     — LOAM eq. (1)
 * S is the 5 points either side of i on the SAME ring, which is why the ring
 * index has to survive packet decoding in any real implementation.
 */
export const HALF_WINDOW = 5;

export function curvature(pts, valid) {
  const n = RINGS * AZ;
  const c = new Float32Array(n).fill(NaN);
  for (let r = 0; r < RINGS; r++) {
    const base = r * AZ;
    for (let a = 0; a < AZ; a++) {
      const i = base + a;
      if (!valid[i]) continue;
      let sx = 0, sy = 0, sz = 0, cnt = 0, ok = true;
      for (let k = -HALF_WINDOW; k <= HALF_WINDOW && ok; k++) {
        if (!k) continue;
        const j = base + ((a + k + AZ) % AZ);
        if (!valid[j]) { ok = false; break; }
        sx += pts[3 * i] - pts[3 * j];
        sy += pts[3 * i + 1] - pts[3 * j + 1];
        sz += pts[3 * i + 2] - pts[3 * j + 2];
        cnt++;
      }
      if (!ok) continue;
      const range = Math.hypot(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]);
      if (range < 1e-3) continue;
      c[i] = Math.hypot(sx, sy, sz) / (cnt * range);
    }
  }
  return c;
}

/** Percentile of the finite curvatures — used to place the default thresholds. */
export function curvaturePercentile(c, p) {
  const v = [];
  for (let i = 0; i < c.length; i++) if (Number.isFinite(c[i])) v.push(c[i]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
}

/* -------------------------------------------------------------- feature ---
 * LOAM picks features per ring per azimuth sector so they stay spread out —
 * a corner-rich corner of the room can't hijack the whole optimisation.
 */
const SECTORS = 6;

export function extractFeatures(pts, valid, c, edgeThr, planeThr, perSector = { edge: 2, plane: 4 }) {
  const edge = [], plane = [];
  const span = Math.floor(AZ / SECTORS);
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SECTORS; s++) {
      const a0 = s * span, a1 = (s === SECTORS - 1) ? AZ : a0 + span;
      const bucket = [];
      for (let a = a0; a < a1; a++) {
        const i = r * AZ + a;
        if (valid[i] && Number.isFinite(c[i])) bucket.push(i);
      }
      bucket.sort((p, q) => c[q] - c[p]);
      let taken = 0;
      for (let k = 0; k < bucket.length && taken < perSector.edge; k++) {
        if (c[bucket[k]] < edgeThr) break;
        edge.push(bucket[k]); taken++;
      }
      taken = 0;
      for (let k = bucket.length - 1; k >= 0 && taken < perSector.plane; k--) {
        if (c[bucket[k]] > planeThr) break;
        plane.push(bucket[k]); taken++;
      }
    }
  }
  return { edge, plane };
}

/** Pack a list of point indices into flat xyz + ring arrays. */
export function packFeatures(pts, idx) {
  const n = idx.length;
  const xyz = new Float32Array(3 * n);
  const ring = new Int16Array(n);
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    xyz[3 * k] = pts[3 * i]; xyz[3 * k + 1] = pts[3 * i + 1]; xyz[3 * k + 2] = pts[3 * i + 2];
    ring[k] = Math.floor(i / AZ);
  }
  return { xyz, ring, n };
}
