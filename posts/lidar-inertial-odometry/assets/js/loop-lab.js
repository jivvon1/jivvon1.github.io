/* Loop-closure viewer. Top-down, because a loop is a shape you have to see from
 * above. Every number on screen comes out of loop-core.js. */
import {
  groundTruth, odometry, radiusSearch, verify, loopEdge, optimize, ate
} from './loop-core.js';

const root = document.querySelector('[data-loop-lab]');

const COL = { gt: '#7b8894', odo: '#ff9256', fix: '#54a7ff', ok: '#55c79a', bad: '#e05555', node: '#f0c640' };
const MIN_GAP = 40;        // nodes that must separate a pair before it can be a revisit
const DETECT_EVERY = 3;

function init(root) {
  const canvas = root.querySelector('[data-loop-canvas]');
  const g = canvas.getContext('2d');

  const state = {
    radius: 3.0, drift: 1, useLoops: true, armed: false,
    playing: true, cursor: 0, phase: 'drive',
    loops: [], rejects: [], optimized: null, blend: 0, lastDetect: -99
  };
  let data = null;

  function rebuild() {
    const gt = groundTruth(150);
    const { nodes, edges } = odometry(gt, {
      noiseT: 0.012 * state.drift, noiseR: 0.006 * state.drift, bias: 0.0016 * state.drift, seed: 7
    });
    data = { gt, nodes, edges, N: nodes.length };
    resetRun();
    fitView();
  }

  function resetRun() {
    state.cursor = 0;
    state.phase = 'drive';
    state.playing = true;
    state.loops = [];
    state.rejects = [];
    state.optimized = null;
    state.blend = 0;
    state.lastDetect = -99;
    sync();
    // `armed` deliberately survives a reset: once the reader has seen the panel,
    // slider changes should replay straight away rather than sit frozen.
  }

  /* ---------------------------------------------------------- view fit --- */
  let view = { s: 20, ox: 0, oy: 0 };
  function fitView() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of data.gt) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    for (const p of data.nodes) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const pad = 34;
    const s = Math.min((w - 2 * pad) / Math.max(1e-3, x1 - x0), (h - 2 * pad) / Math.max(1e-3, y1 - y0));
    view = { s, ox: w / 2 - s * (x0 + x1) / 2, oy: h / 2 + s * (y0 + y1) / 2 };
  }
  const SX = (p) => view.ox + p.x * view.s;
  const SY = (p) => view.oy - p.y * view.s;   // canvas y grows downward

  /** Node position at the current morph between odometry and the optimised graph. */
  function posOf(i) {
    const a = data.nodes[i];
    if (!state.optimized || state.blend <= 0) return a;
    const b = state.optimized[i];
    const k = state.blend;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, th: a.th };
  }

  /* ---------------------------------------------------------- detection --- */
  function detectAt(i) {
    if (!state.useLoops) return;
    if (i - state.lastDetect < DETECT_EVERY) return;
    state.lastDetect = i;
    // Search the CURRENT ESTIMATE — the robot has no ground truth to search.
    const cands = radiusSearch(data.nodes, i, state.radius, MIN_GAP);
    if (!cands.length) return;
    const best = cands[0];
    if (state.loops.some(l => Math.abs(l.j - best.j) < 6 && Math.abs(l.i - i) < 6)) return;
    const v = verify(data.gt, i, best.j);
    if (v.ok) state.loops.push({ i, j: best.j, d: best.d });
    else if (state.rejects.length < 40) state.rejects.push({ i, j: best.j, d: best.d, at: performance.now() });
  }

  function runOptimize() {
    if (!state.loops.length) { state.phase = 'done'; sync(); return; }
    const edges = data.edges.concat(state.loops.map(l => loopEdge(data.gt, l.i, l.j, {})));
    state.optimized = optimize(data.nodes, edges, 6);
    state.phase = 'morph';
    state.blend = 0;
    sync();
  }

  /* ------------------------------------------------------------ readout --- */
  function sync() {
    const set = (k, v) => root.querySelectorAll(`[data-loop-out="${k}"]`).forEach(e => { e.textContent = v; });
    if (!data) return;
    const shown = Math.min(data.N - 1, Math.floor(state.cursor));
    set('nodes', `${shown + 1} / ${data.N}`);
    set('loops', state.loops.length);
    set('rejects', state.rejects.length);
    set('radius', state.radius.toFixed(1) + ' m');
    set('drift', (state.drift).toFixed(1) + '×');
    const before = ate(data.nodes, data.gt);
    set('ate0', before.toFixed(3) + ' m');
    const now = state.optimized
      ? ate(data.nodes.map((_, i) => posOf(i)), data.gt)
      : before;
    set('ate1', state.optimized ? now.toFixed(3) + ' m' : '—');
    const phaseText = { drive: '주행 중 — odometry 누적', detect: 'loop 후보 탐색', morph: 'pose graph 최적화 중', done: '완료' };
    set('phase', phaseText[state.phase] || '');

    // A run that finds nothing is a result, not a dead end — say which result.
    const hint = root.querySelector('[data-loop-hint]');
    if (hint) {
      if (state.phase !== 'done' && state.phase !== 'morph') hint.hidden = true;
      else {
        hint.hidden = false;
        if (!state.useLoops) {
          hint.innerHTML = 'loop closure를 껐습니다. 되돌아와도 아무 일이 없고, 누적된 <b>' + before.toFixed(2) + ' m</b>의 드리프트가 그대로 남습니다.';
          hint.className = 'lio-note lio-note--warn';
        } else if (!state.loops.length) {
          hint.innerHTML = '되돌아왔는데도 <b>알아보지 못했습니다.</b> 드리프트가 반경보다 커서 예전 노드가 검색 범위 밖에 있거나, 가까워 보인 후보가 전부 다른 장소였어요. 반경을 키우거나 드리프트를 줄여보세요 — <b>드리프트가 클수록 정작 그걸 고칠 loop을 놓치기 쉽다</b>는 게 이 문제의 고약한 점입니다.';
          hint.className = 'lio-note lio-note--warn';
        } else {
          hint.innerHTML = 'loop factor <b>' + state.loops.length + '개</b>로 평균 오차가 <b>' + before.toFixed(2) + ' m → ' + now.toFixed(2) + ' m</b>. 마지막 pose만이 아니라 <b>지나온 궤적 전체</b>가 함께 당겨졌습니다.';
          hint.className = 'lio-note lio-note--good';
        }
      }
    }
    root.querySelectorAll('[data-loop-act="optimize"]').forEach(b => {
      b.disabled = !(state.phase === 'done' || state.phase === 'drive') || !state.loops.length;
    });
  }

  /* ------------------------------------------------------------- render --- */
  let css = null;
  function readTheme() {
    const s = getComputedStyle(document.documentElement);
    css = { border: s.getPropertyValue('--border').trim(), muted: s.getPropertyValue('--text-muted').trim(), card: s.getPropertyValue('--bg-card').trim() };
  }
  readTheme();
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function path(points, color, width, dash) {
    if (points.length < 2) return;
    g.save();
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round';
    g.setLineDash(dash || []);
    g.beginPath();
    points.forEach((p, k) => k ? g.lineTo(SX(p), SY(p)) : g.moveTo(SX(p), SY(p)));
    g.stroke();
    g.restore();
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; fitView(); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    path(data.gt, css.border, 2.5, [6, 5]);             // ground truth circuit

    const upto = Math.min(data.N - 1, Math.floor(state.cursor));
    const traj = [];
    for (let i = 0; i <= upto; i++) traj.push(posOf(i));
    path(traj, state.blend > 0.02 ? COL.fix : COL.odo, 2.6);

    // rejected candidates fade out — they are part of the story, not an error
    const now = performance.now();
    state.rejects.forEach(r => {
      const age = (now - r.at) / 2200;
      if (age > 1) return;
      g.save();
      g.globalAlpha = (1 - age) * 0.75;
      g.strokeStyle = COL.bad; g.lineWidth = 1.6; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(SX(posOf(r.i)), SY(posOf(r.i))); g.lineTo(SX(posOf(r.j)), SY(posOf(r.j))); g.stroke();
      g.restore();
    });

    state.loops.forEach(l => {
      if (l.i > upto) return;
      g.save();
      g.strokeStyle = COL.ok; g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(SX(posOf(l.i)), SY(posOf(l.i))); g.lineTo(SX(posOf(l.j)), SY(posOf(l.j))); g.stroke();
      g.restore();
    });

    // nodes, thinned so the graph reads as a graph
    g.fillStyle = COL.node;
    for (let i = 0; i <= upto; i += 5) {
      const p = posOf(i);
      g.beginPath(); g.arc(SX(p), SY(p), 1.9, 0, 7); g.fill();
    }

    if (state.phase === 'drive' || state.phase === 'detect') {
      const p = posOf(upto);
      const rr = state.radius * view.s;
      g.save();
      g.strokeStyle = COL.fix; g.lineWidth = 1.4; g.setLineDash([5, 4]);
      g.beginPath(); g.arc(SX(p), SY(p), rr, 0, 7); g.stroke();
      g.restore();
      g.fillStyle = COL.odo;
      g.beginPath(); g.arc(SX(p), SY(p), 5, 0, 7); g.fill();
    }

    // start marker — the place the loop comes back to
    const s0 = posOf(0);
    g.save();
    g.strokeStyle = COL.node; g.lineWidth = 2;
    g.beginPath(); g.arc(SX(s0), SY(s0), 6, 0, 7); g.stroke();
    g.restore();

    // legend — wraps onto a second row rather than running off the canvas
    g.font = '500 13px "JetBrains Mono", monospace';
    const items = [
      { c: COL.gt, label: 'ground truth', dash: true },
      { c: COL.odo, label: 'odometry' },
      { c: COL.fix, label: 'optimized' },
      { c: COL.ok, label: 'loop closure' },
      { c: COL.bad, label: 'rejected', dash: true },
      { c: COL.fix, label: 'search radius ' + state.radius.toFixed(1) + ' m', dash: true, ring: true }
    ];
    const rows = [[]];
    let used = 0;
    items.forEach(it => {
      const wI = 30 + g.measureText(it.label).width;
      if (used + wI > w - 24 && rows[rows.length - 1].length) { rows.push([]); used = 0; }
      rows[rows.length - 1].push(it);
      used += wI;
    });
    rows.forEach((row, r) => {
      const y = h - 12 - (rows.length - 1 - r) * 19;
      let lx = 12;
      row.forEach(({ c, label, dash, ring }) => {
        g.save();
        g.strokeStyle = c; g.lineWidth = ring ? 1.4 : 2.4;
        g.setLineDash(dash ? [4, 3] : []);
        g.beginPath();
        if (ring) g.arc(lx + 8, y - 4, 7, 0, 7);
        else { g.moveTo(lx, y - 4); g.lineTo(lx + 17, y - 4); }
        g.stroke();
        g.restore();
        g.fillStyle = css.muted;
        g.fillText(label, lx + 24, y);
        lx += 30 + g.measureText(label).width;
      });
    });
  }

  /* --------------------------------------------------------------- loop --- */
  let last = performance.now();
  function frame() {
    requestAnimationFrame(frame);
    if (!data) return;
    const t = performance.now(), dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (state.phase === 'drive' && state.playing && state.armed) {
      const prev = Math.floor(state.cursor);
      state.cursor = Math.min(data.N - 1, state.cursor + dt * 38);
      const cur = Math.floor(state.cursor);
      for (let i = prev + 1; i <= cur; i++) detectAt(i);
      if (cur !== prev) sync();
      if (state.cursor >= data.N - 1) { state.phase = 'detect'; setTimeout(runOptimize, 700); sync(); }
    } else if (state.phase === 'morph') {
      state.blend = Math.min(1, state.blend + dt * 0.9);
      if (state.blend >= 1) state.phase = 'done';
      sync();
    }
    draw();
  }

  /* ----------------------------------------------------------------- UI --- */
  const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach(e => e.addEventListener(ev, fn));
  on('[data-loop-act="replay"]', 'click', () => { resetRun(); state.armed = true; });
  on('[data-loop-act="optimize"]', 'click', () => { state.cursor = data.N - 1; runOptimize(); });
  on('[data-loop-act="radius"]', 'input', (e) => { state.radius = +e.target.value; resetRun(); });
  on('[data-loop-act="drift"]', 'input', (e) => { state.drift = +e.target.value; rebuild(); });
  on('[data-loop-act="useloops"]', 'change', (e) => { state.useLoops = e.target.checked; resetRun(); });
  new ResizeObserver(() => { fitView(); }).observe(canvas);
  new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) state.armed = true;
  }, { threshold: 0.35 }).observe(canvas);

  rebuild();     // build the data before the first frame reads it
  frame();
}

if (root) init(root);   // after the module-level constants above are initialised
