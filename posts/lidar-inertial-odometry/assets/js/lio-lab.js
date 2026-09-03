/* LIO lab — the viewer. All geometry it draws comes from lio-core / lio-solve;
 * nothing here is faked for the picture.
 *
 * Frames: everything is drawn in the world frame. The map cloud is sweep k
 * deskewed and placed at pose P1; the query cloud is sweep k+1 in its own end
 * frame, carried into the world by P1·θ. When θ equals the true relative pose
 * the two clouds coincide — which is exactly what stage ⑤ is minimising.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  RINGS, AZ, BLOCKS, ROOM, simulateSweep, curvature, curvaturePercentile,
  extractFeatures, packFeatures, poseMat, mulMat, relPose, lerpPose
} from './lio-core.js';
import { Grid, buildProblem, gaussNewtonStep, cost, associate } from './lio-solve.js';

const root = document.querySelector('[data-lio-lab]');

const C = {
  map: 0x9db0c2, query: 0xff9256, edge: 0xf0c640, plane: 0x55c79a,
  link: 0x54a7ff, truth: 0x65c98c, ghost: 0x3d4854
};
const deg = (r) => (r * 180 / Math.PI);
const IDENTITY = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };

function start(root) {
  /* ------------------------------------------------------------- scene --- */
  const host = root.querySelector('[data-lio-view]');
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x161b20, 26, 62);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 160);
  camera.position.set(4.6, 7.4, 11.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.prepend(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(-1.4, 1.3, 0.6);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3;
  controls.maxDistance = 46;
  controls.maxPolarAngle = Math.PI * 0.495;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1c2228, 1.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(6, 14, 8);
  scene.add(key);

  const grid = new THREE.GridHelper(ROOM.w, 27, 0x4b5763, 0x2c343c);
  grid.position.y = 0.01;
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  scene.add(grid);

  const envGroup = new THREE.Group();
  scene.add(envGroup);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x39434e, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.5 });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x5d6b79, transparent: true, opacity: 0.75 });
  BLOCKS.forEach(([cx, cz, w, d, h]) => {
    const g = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(g, wallMat);
    mesh.position.set(cx, h / 2, cz);
    envGroup.add(mesh);
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
    line.position.copy(mesh.position);
    envGroup.add(line);
  });
  const shell = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(ROOM.w, ROOM.h, ROOM.d)),
    new THREE.LineBasicMaterial({ color: 0x46525e, transparent: true, opacity: 0.5 }));
  shell.position.y = ROOM.h / 2;
  scene.add(shell);

  /* ---------------------------------------------------------- trajectory ---
   * P0 → P1 is sweep k, P1 → P2 is sweep k+1. The relative pose we are after
   * is exactly P1⁻¹·P2. A slider scales the second leg. */
  const P0 = { x: -3.4, y: 1.05, z: 2.4, roll: 0.012, pitch: -0.02, yaw: 0.22 };
  const P1 = { x: -2.2, y: 1.10, z: 1.65, roll: -0.018, pitch: 0.028, yaw: 0.40 };
  const state = {
    stage: 'sweep', motion: 1, turn: 8, applyTruth: false, deskew: true, imuPrior: true,
    edgeP: 0.90, planeP: 0.45, iter: 0, lambda: 1e-3,
    theta: { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 },
    history: [], pick: 0, playing: true, revealed: 0
  };

  /* Sweep k+1 ends one forward step later. "Forward" means the sensor's own
   * +x axis (azimuth 0), not a world direction — otherwise turning the motion
   * slider up would slide the platform sideways through the room. Heading
   * change is a separate control, and attitude wobble is small and fixed, so
   * each slider changes exactly the one thing it is named after. */
  const FORWARD = 1.25;   // metres per unit of the slider
  const P2 = () => {
    const m = poseMat(P1);
    const d = FORWARD * state.motion;
    return {
      x: P1.x + m[0] * d, y: P1.y + m[1] * d, z: P1.z + m[2] * d,
      roll: P1.roll + 0.03, pitch: P1.pitch - 0.035,
      yaw: P1.yaw + state.turn * Math.PI / 180
    };
  };

  /* --------------------------------------------------------------- data --- */
  let data = null;
  function rebuild() {
    const p2 = P2();
    const s0 = simulateSweep(P0, P1);
    const s1 = simulateSweep(P1, p2);
    const c0 = curvature(s0.fixed, s0.valid);
    const c1 = curvature(s1.fixed, s1.valid);
    const eThr = curvaturePercentile(c0, state.edgeP);
    const pThr = curvaturePercentile(c0, state.planeP);
    const f0 = extractFeatures(s0.fixed, s0.valid, c0, eThr, pThr, { edge: 4, plane: 8 });
    const f1 = extractFeatures(s1.fixed, s1.valid, c1, eThr, pThr, { edge: 2, plane: 4 });
    const mapE = packFeatures(s0.fixed, f0.edge), mapP = packFeatures(s0.fixed, f0.plane);
    const qE = packFeatures(s1.fixed, f1.edge), qP = packFeatures(s1.fixed, f1.plane);
    data = {
      p2, s0, s1, c0, c1, eThr, pThr, f0, f1, mapE, mapP, qE, qP,
      prob: buildProblem(qE, qP, new Grid(mapE), new Grid(mapP)),
      truth: relPose(P1, p2),
      M1: poseMat(P1)
    };
    resetSolve();
    rebuildClouds();
    syncReadouts();
  }

  function resetSolve() {
    const t = data.truth;
    state.theta = state.imuPrior
      // IMU pre-integration prior: right ballpark, wrong in the last few cm/deg.
      ? { x: t.x * 0.86, y: t.y + 0.04, z: t.z - 0.07, roll: t.roll * 0.5, pitch: t.pitch * 0.4, yaw: t.yaw * 0.78 }
      : { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    state.iter = 0;
    state.lambda = 1e-3;
    const c = cost(data.prob, state.theta);
    state.history = [c.rms];
    state.assoc = c.assoc;
  }

  /* ------------------------------------------------------------- clouds --- */
  const mapFrame = new THREE.Group();   // children live in sweep-k (P1) coordinates
  scene.add(mapFrame);
  const queryObj = new THREE.Group();
  scene.add(queryObj);

  /* `azimuthMajor` repacks ring-major storage into sweep order, so that a
   * drawRange boundary is a rotating beam rather than a growing stack of rings. */
  function pointsFrom(xyz, valid, color, size, opacity = 0.95, azimuthMajor = false) {
    const pts = [];
    const push = (i) => pts.push(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
    if (azimuthMajor) {
      for (let az = 0; az < AZ; az++) for (let r = 0; r < RINGS; r++) {
        const i = r * AZ + az;
        if (valid[i]) push(i);
      }
    } else {
      const n = valid ? valid.length : xyz.length / 3;
      for (let i = 0; i < n; i++) {
        if (valid && !valid[i]) continue;
        push(i);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const obj = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: true, transparent: true, opacity }));
    // A threshold can legitimately select zero features; an empty geometry has
    // no bounding sphere to cull against, so skip culling rather than let
    // three.js compute a NaN radius for it.
    if (!pts.length) obj.frustumCulled = false;
    return obj;
  }

  let mapCloud, queryCloud, sweepCloud, sweepRef, featE, featP, ghostCloud;
  let cumCache = null, cumFor = null;   // declared before the render loop that reads them
  const matchGroup = new THREE.Group();
  mapFrame.add(matchGroup);

  function rebuildClouds() {
    [mapCloud, queryCloud, sweepCloud, sweepRef, ghostCloud, featE, featP].forEach(o => {
      if (!o) return;
      o.parent && o.parent.remove(o);
      o.geometry.dispose();
    });
    const { s0, s1 } = data;

    // Stage ① — sweep k as it is built, in world coordinates. Two versions of
    // the same measurements: naively stacked, and deskewed with the true motion.
    sweepCloud = pointsFrom(state.deskew ? s0.world : applyMat(s0.raw, s0.valid, data.M1),
      s0.valid, state.deskew ? C.map : 0xff6b4a, 0.086, 0.95, true);
    sweepCloud.geometry.setDrawRange(0, 0);
    scene.add(sweepCloud);
    // With deskew off, keep the corrected cloud as a faint reference so the
    // smear reads as a visible displacement rather than something to take on trust.
    sweepRef = pointsFrom(s0.world, s0.valid, C.map, 0.07, 0.22, true);
    sweepRef.geometry.setDrawRange(0, 0);
    scene.add(sweepRef);

    // Stages ②–⑤ — map cloud (fixed) and query cloud (moved by θ).
    mapCloud = pointsFrom(s0.world, s0.valid, C.map, 0.088, 0.85);
    scene.add(mapCloud);
    queryCloud = pointsFrom(s1.fixed, s1.valid, C.query, 0.088, 0.85);
    queryObj.add(queryCloud);

    featE = pointsFrom(data.mapE.xyz, null, C.edge, 0.15);
    featP = pointsFrom(data.mapP.xyz, null, C.plane, 0.115);
    mapFrame.add(featE, featP);

    // colorByCurvature already drops the invalid returns, so this must NOT be
    // filtered a second time — indexing the compacted array by original point
    // indices runs off the end and writes NaN positions into the buffer.
    ghostCloud = pointsFrom(colorByCurvature(s0.fixed, s0.valid, data.c0), null, 0xffffff, 0.09);
    ghostCloud.material.vertexColors = true;
    mapFrame.add(ghostCloud);
    applyStage();
  }

  function applyMat(xyz, valid, m) {
    const out = new Float32Array(xyz.length);
    for (let i = 0; i < valid.length; i++) {
      if (!valid[i]) continue;
      const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
      out[3 * i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[3 * i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[3 * i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return out;
  }

  /** Per-point colour ramp on curvature, with the two thresholds as hard stops. */
  function colorByCurvature(xyz, valid, c) {
    const cols = [];
    const pts = [];
    for (let i = 0; i < valid.length; i++) {
      if (!valid[i]) continue;
      pts.push(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
      const v = c[i];
      let col;
      if (!Number.isFinite(v)) col = new THREE.Color(C.ghost);
      else if (v >= data.eThr) col = new THREE.Color(C.edge);
      else if (v <= data.pThr) col = new THREE.Color(C.plane);
      else col = new THREE.Color(0x55606c);
      cols.push(col.r, col.g, col.b);
    }
    curvatureColors = cols;
    return pts;
  }
  let curvatureColors = null;

  /* -------------------------------------------------------- match overlay --- */
  function drawMatch() {
    while (matchGroup.children.length) {
      const c = matchGroup.children.pop();
      c.geometry && c.geometry.dispose();
      c.material && c.material.dispose();
    }
    const wanted = state.stage === 'match' ? 'one' : (state.stage === 'solve' ? 'many' : null);
    if (!wanted || !state.assoc || !state.assoc.length) return;
    const list = state.assoc;
    if (wanted === 'many') {
      const seg = [];
      for (let k = 0; k < list.length; k += 3) {
        const a = list[k];
        const f = a.type === 'edge' ? data.mapE : data.mapP;
        seg.push(a.p[0], a.p[1], a.p[2], f.xyz[3 * a.m.j], f.xyz[3 * a.m.j + 1], f.xyz[3 * a.m.j + 2]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      matchGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: C.link, transparent: true, opacity: 0.8 })));
      return;
    }
    const kind = root.querySelector('[data-match-kind].is-active');
    const type = kind ? kind.dataset.matchKind : 'edge';
    // Every pair here is real; this just skips the ones whose residual is a
    // sub-centimetre line nobody can see, so the geometry reads on screen.
    const all = list.filter(a => a.type === type);
    const big = all.filter(a => a.d > 0.25);
    const pool = big.length ? big : all;
    if (!pool.length) return;
    const a = pool[state.pick % pool.length];
    const f = type === 'edge' ? data.mapE : data.mapP;
    const P = (i) => new THREE.Vector3(f.xyz[3 * i], f.xyz[3 * i + 1], f.xyz[3 * i + 2]);
    const i3 = new THREE.Vector3(a.p[0], a.p[1], a.p[2]);
    const dot = (v, color, size) => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 10), new THREE.MeshBasicMaterial({ color }));
      s.position.copy(v);
      matchGroup.add(s);
    };
    const seg = (u, v, color, radius = 0.045) => {
      const dir = v.clone().sub(u);
      const len = dir.length();
      if (len < 1e-5) return;
      const tube = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, len, 10, 1),
        new THREE.MeshBasicMaterial({ color }));
      tube.position.copy(u).addScaledVector(dir, 0.5);
      tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      matchGroup.add(tube);
    };
    const rad = Math.max(0.035, Math.min(0.12, a.d * 0.2));
    dot(i3, 0x3fd47f, rad * 1.25);
    const j = P(a.m.j), l = P(a.m.l);
    dot(j, 0xe05555, rad); dot(l, 0xe05555, rad);
    let viewDir = null;
    if (type === 'edge') {
      const dir = l.clone().sub(j).normalize();
      // Look along the normal of the i–j–l triangle: that is the one direction
      // from which the perpendicular d_E is not foreshortened to nothing.
      viewDir = j.clone().sub(i3).cross(l.clone().sub(i3));
      seg(j.clone().addScaledVector(dir, -2.5), l.clone().addScaledVector(dir, 2.5), C.link, rad * 0.34);
      // foot of the perpendicular = the geometric meaning of d_E
      const t = i3.clone().sub(j).dot(dir);
      seg(i3, j.clone().addScaledVector(dir, t), C.edge, rad * 0.44);
    } else {
      const m = P(a.m.m);
      dot(m, 0xe05555, rad);
      const u = m.clone().sub(j), v = l.clone().sub(j);
      const n = u.clone().cross(v).normalize();
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2),
        new THREE.MeshBasicMaterial({ color: C.plane, transparent: true, opacity: 0.16, side: THREE.DoubleSide }));
      quad.position.copy(j.clone().add(l).add(m).multiplyScalar(1 / 3));
      quad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      matchGroup.add(quad);
      seg(j, l, C.link, rad * 0.34); seg(j, m, C.link, rad * 0.34);
      const h = i3.clone().sub(j).dot(n);
      seg(i3, i3.clone().addScaledVector(n, -h), C.edge, rad * 0.44);
      // Edge-on to the plane, so the drop from i reads as a height.
      viewDir = n.clone().cross(new THREE.Vector3(0, 1, 0));
      if (viewDir.lengthSq() < 1e-6) viewDir.set(1, 0, 0);
      viewDir.normalize().addScaledVector(n, 0.4);
    }
    const box = root.querySelector('[data-match-readout]');
    if (box) box.innerHTML = matchHTML(type, a);
    const M = new THREE.Matrix4().fromArray(data.M1);
    const R = new THREE.Matrix3().setFromMatrix4(M);
    if (!viewDir || viewDir.lengthSq() < 1e-9) viewDir = new THREE.Vector3(1, 0.6, 1);
    viewDir.applyMatrix3(R).normalize();
    if (viewDir.y < 0.14) { viewDir.y = 0.14; viewDir.normalize(); }   // stay above the floor
    focusOn(i3.clone().applyMatrix4(M), viewDir);
  }

  /* Ease the orbit target onto the pair under discussion — at room scale a
   * single correspondence is a few pixels wide otherwise. */
  function focusOn(worldPoint, dir) {
    state.focus = { at: worldPoint, dir, dist: 5.4, t: 0 };
  }

  function matchHTML(type, a) {
    const rows = type === 'edge'
      ? [['i', 'current edge point'], ['j', 'nearest map point'], ['l', 'nearest on a different scan line']]
      : [['i', 'current planar point'], ['j', 'nearest map point'], ['l', 'nearest on the same scan line'], ['m', 'nearest on a different one']];
    return rows.map(([k, t]) => `<div><b>${k}</b><span>${t}</span></div>`).join('')
      + `<div class="lio-dist"><b>${type === 'edge' ? 'd<sub>ℰ</sub>' : 'd<sub>ℋ</sub>'}</b><span>${a.d.toFixed(3)} m</span></div>`;
  }

  /* -------------------------------------------------------------- stages --- */
  function applyStage() {
    const s = state.stage;
    const rawOverlay = s === 'overlay' && !state.applyTruth;
    envGroup.visible = shell.visible = !rawOverlay;
    sweepCloud.visible = s === 'sweep';
    sweepRef.visible = s === 'sweep' && !state.deskew;
    mapCloud.visible = s !== 'sweep' && s !== 'feature';
    queryObj.visible = s === 'overlay' || s === 'match' || s === 'solve';
    if (queryCloud) queryCloud.material.opacity = s === 'match' ? 0.3 : (s === 'solve' ? 0.9 : 0.85);
    if (mapCloud) mapCloud.material.opacity = s === 'match' ? 0.3 : 0.85;
    ghostCloud.visible = s === 'feature';
    featE.visible = featP.visible = (s === 'feature' || s === 'match');
    if (ghostCloud.visible && curvatureColors) {
      ghostCloud.geometry.setAttribute('color', new THREE.Float32BufferAttribute(curvatureColors, 3));
      ghostCloud.material.vertexColors = true;
      ghostCloud.material.needsUpdate = true;
    }
    if (s === 'sweep') { state.revealed = 0; state.playing = true; }
    root.querySelectorAll('[data-stage-panel]').forEach(p => { p.hidden = p.dataset.stagePanel !== s; });
    root.querySelectorAll('[data-stage]').forEach(b => b.classList.toggle('is-active', b.dataset.stage === s));
    drawMatch();
    syncReadouts();
  }

  /* -------------------------------------------------------------- solver --- */
  function iterate(n = 1) {
    for (let k = 0; k < n; k++) {
      const r = gaussNewtonStep(data.prob, state.theta, state.lambda);
      state.theta = r.theta;
      state.lambda = r.lambda;
      state.assoc = r.assoc;
      state.iter++;
      state.history.push(r.rms);
      if (state.history.length > 60) state.history.shift();
    }
    drawMatch();
    syncReadouts();
  }

  /* ------------------------------------------------------------ readouts --- */
  const chart = root.querySelector('[data-lio-chart]');
  function syncReadouts() {
    if (!data) return;
    const set = (k, v) => root.querySelectorAll(`[data-out="${k}"]`).forEach(e => { e.textContent = v; });
    const t = data.truth, th = state.theta;
    const dt = Math.hypot(th.x - t.x, th.y - t.y, th.z - t.z);
    const dr = Math.hypot(deg(th.roll - t.roll), deg(th.pitch - t.pitch), deg(th.yaw - t.yaw));
    set('iter', state.iter);
    set('rms', Number.isFinite(state.history.at(-1)) ? state.history.at(-1).toFixed(3) + ' m' : '—');
    set('pairs', state.assoc ? state.assoc.length : 0);
    set('errt', dt.toFixed(3) + ' m');
    set('errr', dr.toFixed(2) + '°');
    set('est', `${th.x.toFixed(2)}, ${th.y.toFixed(2)}, ${th.z.toFixed(2)} · ${deg(th.yaw).toFixed(1)}°`);
    set('truth', `${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)} · ${deg(t.yaw).toFixed(1)}°`);
    set('nedge', data.mapE.n);
    set('nplane', data.mapP.n);
    set('qedge', data.qE.n);
    set('qplane', data.qP.n);
    set('ethr', data.eThr.toFixed(3));
    set('pthr', data.pThr.toFixed(4));
    set('motion', `${Math.hypot(t.x, t.y, t.z).toFixed(2)} m`);
    set('turn', `${deg(t.yaw).toFixed(1)}°`);
    drawChart();
  }

  function drawChart() {
    if (!chart) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = chart.clientWidth, h = chart.clientHeight;
    chart.width = w * dpr; chart.height = h * dpr;
    const g = chart.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const line = css.getPropertyValue('--border').trim() || '#333';
    const hist = state.history.filter(Number.isFinite);
    g.strokeStyle = line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(28, h - 18); g.lineTo(w - 6, h - 18); g.stroke();
    if (hist.length < 2) return;
    const max = Math.max(...hist) * 1.12, min = 0;
    const X = i => 28 + (w - 36) * (i / Math.max(1, hist.length - 1));
    const Y = v => h - 18 - (h - 30) * ((v - min) / Math.max(1e-6, max - min));
    g.strokeStyle = '#54a7ff'; g.lineWidth = 2; g.beginPath();
    hist.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)));
    g.stroke();
    g.fillStyle = '#54a7ff';
    g.beginPath(); g.arc(X(hist.length - 1), Y(hist.at(-1)), 3, 0, 7); g.fill();
    g.fillStyle = css.getPropertyValue('--text-muted').trim() || '#888';
    g.font = '500 12px JetBrains Mono, monospace';
    g.fillText(max.toFixed(2), 2, 14);
    g.fillText('0', 2, h - 21);
    g.fillText('iteration', w - 52, h - 6);
  }

  /* ------------------------------------------------------------------ UI --- */
  root.querySelectorAll('[data-stage]').forEach(b => b.addEventListener('click', () => {
    state.stage = b.dataset.stage;
    applyStage();
  }));
  root.querySelectorAll('[data-match-kind]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-match-kind]').forEach(o => o.classList.toggle('is-active', o === b));
    state.pick = 0;
    drawMatch();
  }));
  const bind = (sel, ev, fn) => root.querySelectorAll(sel).forEach(e => e.addEventListener(ev, fn));
  bind('[data-act="replay"]', 'click', () => { state.revealed = 0; state.playing = true; });
  bind('[data-act="deskew"]', 'change', (e) => { state.deskew = e.target.checked; rebuildClouds(); state.revealed = 0; });
  bind('[data-act="imu"]', 'change', (e) => { state.imuPrior = e.target.checked; resetSolve(); drawMatch(); syncReadouts(); });
  bind('[data-act="motion"]', 'input', (e) => { state.motion = +e.target.value; rebuild(); });
  bind('[data-act="turn"]', 'input', (e) => { state.turn = +e.target.value; rebuild(); });
  bind('[data-act="applytruth"]', 'change', (e) => { state.applyTruth = e.target.checked; applyStage(); });
  bind('[data-act="edgethr"]', 'input', (e) => { state.edgeP = +e.target.value; rebuild(); });
  bind('[data-act="planethr"]', 'input', (e) => { state.planeP = +e.target.value; rebuild(); });
  bind('[data-act="step"]', 'click', () => iterate(1));
  bind('[data-act="run"]', 'click', () => iterate(12));
  bind('[data-act="reset"]', 'click', () => { resetSolve(); drawMatch(); syncReadouts(); });
  bind('[data-act="next-pair"]', 'click', () => { state.pick++; drawMatch(); });

  /* ----------------------------------------------------------------- run --- */
  function resize() {
    const r = host.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / Math.max(1, r.height);
    camera.updateProjectionMatrix();
    drawChart();
  }
  new ResizeObserver(resize).observe(host);

  const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.2, 18),
    new THREE.MeshStandardMaterial({ color: 0xf0c640, roughness: 0.4 }));
  scene.add(sensor);
  const beam = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]),
    new THREE.LineBasicMaterial({ color: 0xf0c640, transparent: true, opacity: 0.55 }));
  scene.add(beam);

  rebuild();
  root.querySelector('[data-lio-loading]')?.classList.add('is-loaded');
  resize();

  const clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, clock.getDelta());
    // world placement of the query cloud: P1 · θ
    queryObj.matrixAutoUpdate = false;
    // Stage ② shows the raw arrival pose (θ = I): the gap between the clouds IS
    // the unknown. Every later stage shows the current estimate instead.
    const shownT = state.stage === 'overlay'
      ? (state.applyTruth ? data.truth : IDENTITY)
      : state.theta;
    queryObj.matrix.fromArray(mulMat(data.M1, poseMat(shownT)));
    mapFrame.matrixAutoUpdate = false;
    mapFrame.matrix.fromArray(data.M1);

    if (state.stage === 'sweep') {
      if (state.playing) {
        state.revealed += dt * AZ * 0.42;
        if (state.revealed >= AZ) { state.revealed = AZ; state.playing = false; }
      }
      const a = Math.min(AZ, Math.floor(state.revealed));
      // points are stored ring-major, so reveal column a across every ring
      const shown = countUpTo(data.s0.valid, a);
      sweepCloud.geometry.setDrawRange(0, shown);
      sweepRef.geometry.setDrawRange(0, shown);
      const f = a / AZ;
      const p = lerpPose(P0, P1, f);
      sensor.position.set(p.x, p.y, p.z);
      sensor.visible = beam.visible = true;
      const az = f * Math.PI * 2;
      beam.position.copy(sensor.position);
      beam.scale.setScalar(7);
      beam.rotation.set(0, -az - p.yaw, 0);
      const st = root.querySelector('[data-sweep-progress]');
      if (st) st.textContent = Math.round(f * 100) + '%';
    } else {
      sensor.visible = beam.visible = false;
    }
    if (state.focus) {
      state.focus.t = Math.min(1, state.focus.t + dt * 2.4);
      const k = 1 - Math.pow(1 - state.focus.t, 3);
      controls.target.lerp(state.focus.at, k * 0.22);
      const want = state.focus.dir
        ? state.focus.at.clone().addScaledVector(state.focus.dir, state.focus.dist)
        : camera.position.clone().sub(controls.target).setLength(state.focus.dist).add(controls.target);
      camera.position.lerp(want, k * 0.16);
      if (state.focus.t >= 1) state.focus = null;
    }
    controls.update();
    renderer.render(scene, camera);
  })();

  /* Points are packed ring-major (ring·AZ + azimuth) but the geometry drops the
   * invalid returns, so a reveal boundary in azimuth has to be counted, not
   * multiplied. Cached because it runs every frame. */
  function countUpTo(valid, a) {
    if (cumFor !== valid) {
      cumFor = valid;
      cumCache = new Int32Array(AZ + 1);
      for (let az = 0; az < AZ; az++) {
        let c = 0;
        for (let r = 0; r < RINGS; r++) if (valid[r * AZ + az]) c++;
        cumCache[az + 1] = cumCache[az] + c;   // same order as the packed buffer
      }
    }
    return cumCache[Math.max(0, Math.min(AZ, a))];
  }
}

if (root) start(root);   // after the module-level constants above are initialised
