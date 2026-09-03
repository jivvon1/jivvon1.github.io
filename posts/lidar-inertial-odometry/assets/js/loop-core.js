/* Pose-graph loop closure — the maths behind LIO-SAM's back end.
 *
 * Frame-to-frame matching is dead reckoning: every relative pose is slightly
 * wrong and the errors compound. Revisiting somewhere you have already been is
 * the one chance to undo that, and it only helps if the whole trajectory is
 * allowed to bend at once. That is what a pose graph does.
 *
 * States are SE(2) here — a top-down view is the honest way to show a loop,
 * and the SE(3) case is the same algebra with a bigger tangent space.
 */

export const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

/** b expressed in a's frame: a⁻¹ ⊕ b */
export function between(a, b) {
  const c = Math.cos(a.th), s = Math.sin(a.th);
  const dx = b.x - a.x, dy = b.y - a.y;
  return { x: c * dx + s * dy, y: -s * dx + c * dy, th: norm(b.th - a.th) };
}

/** a ⊕ d */
export function compose(a, d) {
  const c = Math.cos(a.th), s = Math.sin(a.th);
  return { x: a.x + c * d.x - s * d.y, y: a.y + s * d.x + c * d.y, th: norm(a.th + d.th) };
}

/* deterministic RNG so a given noise setting always tells the same story */
export function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rand) => {
  const u = Math.max(1e-9, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/* ------------------------------------------------------------ trajectory ---
 * A closed circuit that comes back over its own start: the classic case where
 * a loop closure has something to say.
 */
export function groundTruth(steps = 260) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps * Math.PI * 2;
    // a rounded, slightly lopsided circuit — not a perfect circle, so the
    // revisit happens over a recognisable stretch rather than everywhere
    const r = 8.4 + 2.5 * Math.cos(2 * u) + 0.9 * Math.sin(3 * u);
    pts.push({ x: r * Math.cos(u), y: r * Math.sin(u) * 0.82 });
  }
  const poses = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    poses.push({ x: a.x, y: a.y, th: Math.atan2(b.y - a.y, b.x - a.x) });
  }
  return poses;
}

/* -------------------------------------------------------------- odometry ---
 * Each step's true relative motion, corrupted the way scan matching actually
 * fails: a small random error plus a systematic rotation bias. The bias is what
 * makes the trajectory curl away instead of just getting fuzzy.
 */
export function odometry(gt, { noiseT = 0.012, noiseR = 0.006, bias = 0.0016, seed = 7 } = {}) {
  const rand = rng(seed);
  const edges = [];
  const nodes = [{ ...gt[0] }];
  for (let i = 1; i < gt.length; i++) {
    const truth = between(gt[i - 1], gt[i]);
    const z = {
      x: truth.x + gauss(rand) * noiseT,
      y: truth.y + gauss(rand) * noiseT,
      th: norm(truth.th + gauss(rand) * noiseR + bias)
    };
    edges.push({ i: i - 1, j: i, z, w: [1 / (noiseT * noiseT), 1 / (noiseT * noiseT), 1 / (noiseR * noiseR)], kind: 'odom' });
    nodes.push(compose(nodes[i - 1], z));
  }
  return { nodes, edges };
}

/* --------------------------------------------------------- radius search ---
 * LIO-SAM looks for revisits in the CURRENT ESTIMATE, not in truth — it has no
 * truth. So drift can hide a real loop, and can also propose a false one; the
 * scan match that follows is what settles it.
 */
export function radiusSearch(nodes, i, radius, minGap) {
  const out = [];
  for (let j = 0; j < i - minGap; j++) {
    const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
    if (d < radius) out.push({ j, d });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}

/** Stand-in for the ICP check: a candidate is accepted only if the two places
 *  really are the same place. A far-apart pair that only looks close because of
 *  drift is what the scan match rejects. */
export function verify(gt, i, j, gate = 2.6) {
  const d = Math.hypot(gt[i].x - gt[j].x, gt[i].y - gt[j].y);
  return { ok: d < gate, trueDist: d };
}

export function loopEdge(gt, i, j, { noiseT = 0.02, noiseR = 0.01, seed = 3 } = {}) {
  const rand = rng(seed + i * 131 + j);
  const truth = between(gt[j], gt[i]);
  return {
    i: j, j: i,
    z: { x: truth.x + gauss(rand) * noiseT, y: truth.y + gauss(rand) * noiseT, th: norm(truth.th + gauss(rand) * noiseR) },
    w: [1 / (noiseT * noiseT), 1 / (noiseT * noiseT), 1 / (noiseR * noiseR)],
    kind: 'loop'
  };
}

/* ------------------------------------------------------------- optimiser ---
 *   e_ij = z_ij⁻¹ ⊕ (x_i⁻¹ ⊕ x_j),      min Σ e_ijᵀ Ω_ij e_ij
 * Gauss-Newton with analytic SE(2) Jacobians; node 0 is pinned, because a pose
 * graph only ever determines the shape of a trajectory, never where it sits.
 */
export function errorAndJacobian(xi, xj, z) {
  const ci = Math.cos(xi.th), si = Math.sin(xi.th);
  const cz = Math.cos(z.th), sz = Math.sin(z.th);
  const dx = xj.x - xi.x, dy = xj.y - xi.y;
  // R_i^T (t_j - t_i)
  const px = ci * dx + si * dy, py = -si * dx + ci * dy;
  // e_t = R_z^T (p - t_z)
  const qx = px - z.x, qy = py - z.y;
  const e = [cz * qx + sz * qy, -sz * qx + cz * qy, norm(xj.th - xi.th - z.th)];

  // R_z^T R_i^T
  const m00 = cz * ci + sz * -si, m01 = cz * si + sz * ci;
  const m10 = -sz * ci + cz * -si, m11 = -sz * si + cz * ci;
  // d(R_i^T)/dθ_i · (t_j - t_i)
  const dpx = -si * dx + ci * dy, dpy = -ci * dx - si * dy;
  const A = [[-m00, -m01, cz * dpx + sz * dpy],
             [-m10, -m11, -sz * dpx + cz * dpy],
             [0, 0, -1]];
  const B = [[m00, m01, 0], [m10, m11, 0], [0, 0, 1]];
  return { e, A, B };
}

export function optimize(nodes, edges, iterations = 1) {
  const N = nodes.length;
  const x = nodes.map(p => ({ ...p }));
  for (let it = 0; it < iterations; it++) {
    const H = new Float64Array(3 * N * 3 * N);
    const g = new Float64Array(3 * N);
    const add = (r, c, v) => { H[r * 3 * N + c] += v; };

    for (const ed of edges) {
      const { e, A, B } = errorAndJacobian(x[ed.i], x[ed.j], ed.z);
      const W = ed.w;
      const bi = 3 * ed.i, bj = 3 * ed.j;
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          let hii = 0, hij = 0, hji = 0, hjj = 0;
          for (let k = 0; k < 3; k++) {
            hii += A[k][a] * W[k] * A[k][b];
            hij += A[k][a] * W[k] * B[k][b];
            hji += B[k][a] * W[k] * A[k][b];
            hjj += B[k][a] * W[k] * B[k][b];
          }
          add(bi + a, bi + b, hii); add(bi + a, bj + b, hij);
          add(bj + a, bi + b, hji); add(bj + a, bj + b, hjj);
        }
        let gi = 0, gj = 0;
        for (let k = 0; k < 3; k++) { gi += A[k][a] * W[k] * e[k]; gj += B[k][a] * W[k] * e[k]; }
        g[bi + a] += gi; g[bj + a] += gj;
      }
    }
    // gauge fix: pin node 0, and keep the system safely positive-definite
    for (let a = 0; a < 3; a++) add(a, a, 1e6);
    for (let a = 0; a < 3 * N; a++) add(a, a, 1e-6);

    const dx = solveDense(H, g, 3 * N);
    if (!dx) break;
    for (let i = 0; i < N; i++) {
      x[i].x -= dx[3 * i];
      x[i].y -= dx[3 * i + 1];
      x[i].th = norm(x[i].th - dx[3 * i + 2]);
    }
  }
  return x;
}

/** H·δ = −g by Cholesky; H is symmetric positive definite after the gauge fix. */
function solveDense(H, g, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = H[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 1e-12) return null;
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = g[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const out = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * out[k];
    out[i] = s / L[i * n + i];
  }
  return out;
}

/** Mean position error against ground truth — the number the user watches drop. */
export function ate(nodes, gt) {
  let s = 0;
  for (let i = 0; i < nodes.length; i++) s += Math.hypot(nodes[i].x - gt[i].x, nodes[i].y - gt[i].y);
  return s / nodes.length;
}
