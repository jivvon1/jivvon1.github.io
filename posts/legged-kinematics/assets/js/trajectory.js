/* Path lab: draw a path, walk it, and compare per-gait dead-reckoning against ground truth.
   The smoothed drawn path is the commanded TRUTH. For each gait we integrate the joint-derived
   body velocity (≈ commanded speed) with that gait's contact schedule — fewer feet in contact /
   flight phases → more un-observable heading drift → the estimate curves away from truth. */
(function () {
  const app = document.querySelector('[data-kinematics-app]');
  if (!app) return;
  const $ = (q) => app.querySelector(q);
  const cssv = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);

  const state = {
    velocity: 0, yawRate: 0, heading: 0, worldX: 0, worldZ: 0, phase: 0, paused: false, last: performance.now(),
    gait: 'trot', gaitPhase: 0, contacts: [true, true, true, true], legState: null, legQ: null, bodyLift: 0, bodyPitch: 0, frozen: false, wasWalking: false,
    walking: false, walkDist: 0,
  };
  app.go2State = state;

  /* ── gaits (leg order FL,FR,RL,RR) ── */
  const GAITS = {
    walk:  { label: 'walk',  offs: [0.00, 0.50, 0.75, 0.25], duty: 0.75, cad: 1.6, col: '#3fb950', desc: '항상 3발↑ 접촉' },
    trot:  { label: 'trot',  offs: [0.00, 0.50, 0.50, 0.00], duty: 0.52, cad: 2.4, col: '#4d8bff', desc: '대각 2발씩' },
    pace:  { label: 'pace',  offs: [0.00, 0.50, 0.00, 0.50], duty: 0.52, cad: 2.4, col: '#a084ff', desc: '좌/우 2발씩' },
    bound: { label: 'bound', offs: [0.00, 0.00, 0.50, 0.50], duty: 0.42, cad: 2.9, col: '#e0a341', desc: '앞2/뒤2 + 비행' },
    pronk: { label: 'pronk', offs: [0.00, 0.00, 0.00, 0.00], duty: 0.45, cad: 2.7, col: '#e5484d', desc: '4발 동시 + 큰 비행' },
  };
  const GKEYS = Object.keys(GAITS);
  const contactsOf = (g, ph) => GAITS[g].offs.map((o) => (((ph - o) % 1) + 1) % 1 < GAITS[g].duty);
  const liftOf = (g, ph) => {
    if (contactsOf(g, ph).some(Boolean)) return 0;
    const inC = (p) => contactsOf(g, ((p % 1) + 1) % 1).some(Boolean);
    const eps = 1e-3; let back = 0, fwd = 0;
    while (back < 1 && !inC(ph - back - eps)) back += eps;
    while (fwd < 1 && !inC(ph + fwd + eps)) fwd += eps;
    const len = back + fwd; if (len <= eps) return 0;
    const p = back / len; return 4 * p * (1 - p);
  };
  const LEG = { L1: 0.213, L2: 0.213, stand: [0, 0.82, -1.55], AK: 0.62, LH: 0.303 };

  /* ── stance-leg length compensation ──
     A stance leg used to sweep the thigh with the knee frozen, so the hip→sole vertical reach
     drifted from 0.304 m (mid-stance) to 0.243 m (end of stance). The viewer pins the lowest
     stance sole to the floor, so that drift became a sawtooth in body height — invisible in
     trot/pace (duty > 0.5 overlaps the pairs and Math.min() smooths the swap) but a hard pop
     twice per cycle in bound, which flies with no overlap at all. Solve the knee instead:
     given a thigh angle, pick the knee that holds the reach at HSTAND. */
  const HSTAND = 0.288;                      // slightly under the 0.304 stand reach → room to sweep
  const ATMAX = 0.33;                        // widest thigh sweep the constant-reach knee can serve
  const kneeFor = (q1, H) => {
    const c = ((H === undefined ? HSTAND : H) - LEG.L1 * Math.cos(q1)) / LEG.L2;
    return -Math.acos(Math.max(-1, Math.min(1, c))) - q1;
  };

  /* ── stance compression (SLIP) ──
     A perfectly rigid stance leg is the opposite error from the old sawtooth: real legs load like
     a spring, so the trunk sinks on touchdown and rebounds on push-off. Dip the target reach by a
     half-sine over stance — it is zero at both ends, so a pair swap is still continuous and the
     old pop cannot come back. Scales with stride, and with flight time (less duty → harder landing). */
  const COMPMAX = 0.022;
  const compOf = (g, AT) => COMPMAX * (AT / ATMAX) * Math.min(1.3, 0.5 / GAITS[g].duty);
  const stanceH = (comp, prog) => HSTAND - comp * Math.sin(Math.PI * prog);

  /* Trunk pitch: a gait whose front and rear pairs load alternately (bound) rocks the body with
     them; one whose pairs stay in phase (trot/pace/pronk) cancels to exactly zero. */
  const pitchOf = (g, ph) => {
    const s = GAITS[g].offs.map((o) => Math.sin(2 * Math.PI * (ph - o)));
    return 0.13 * ((s[0] + s[1]) - (s[2] + s[3])) / 2;   // + = nose down over the loaded front pair
  };

  /* ── ①과 동일한 URDF 체인 + Jacobian (각 발 ᴮv를 실제로 계산) ── */
  const v_ad = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const v_sb = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const v_sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const v_cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const rodr = (v, k, t) => { const c = Math.cos(t), s = Math.sin(t), kv = v_cr(k, v), kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2]; return v_ad(v_ad(v_sc(v, c), v_sc(kv, s)), v_sc(k, kd * (1 - c))); };
  const CHAIN = [{ org: [0.1934, 0.0465, 0], axis: [1, 0, 0] }, { org: [0, 0.0955, 0], axis: [0, 1, 0] }, { org: [0, 0, -0.213], axis: [0, 1, 0] }];
  const FOOT_OFF = [0, 0, -0.213];
  function chain(q) {   // joint angles → joint positions P, axes A (base frame), foot s
    const P = [], A = []; let o = [0, 0, 0], R = (v) => v;
    for (let j = 0; j < 3; j++) { o = v_ad(o, R(CHAIN[j].org)); const a = R(CHAIN[j].axis); P.push(o); A.push(a); const Rp = R, qj = q[j]; R = (v) => rodr(Rp(v), a, qj); }
    return { P, A, s: v_ad(o, R(FOOT_OFF)) };
  }
  // body velocity a single leg reports from its joint motion:  ᴮv = −Jq̇,  J:,ⱼ = aⱼ×(s−pⱼ)
  function legBodyVel(q, qPrev, dt) {
    const { P, A, s } = chain(q);
    let Jqd = [0, 0, 0];
    for (let j = 0; j < 3; j++) { const dqj = (q[j] - qPrev[j]) / dt; if (dqj) Jqd = v_ad(Jqd, v_sc(v_cr(A[j], v_sb(s, P[j])), dqj)); }
    return v_sc(Jqd, -1);   // 3D body velocity [forward, left, up]
  }
  const SPEED = 0.55;   // constant walking speed along the path (m/s)
  const HB = 0.05;      // heading-drift bias scale — divided by #contacts, ×7 during flight

  /* ── geometry helpers ── */
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function pathLen(P) { let L = 0; for (let i = 1; i < P.length; i++) L += dist(P[i - 1], P[i]); return L; }
  function resample(P, ds) {   // even arc-length resample
    if (P.length < 2) return P.slice();
    const out = [P[0]]; let carry = 0;
    for (let i = 1; i < P.length; i++) {
      let seg = dist(P[i - 1], P[i]); if (seg < 1e-6) continue;
      const dx = (P[i].x - P[i - 1].x) / seg, dy = (P[i].y - P[i - 1].y) / seg;
      let d = carry;
      while (d < seg) { out.push({ x: P[i - 1].x + dx * d, y: P[i - 1].y + dy * d }); d += ds; }
      carry = d - seg;
    }
    out.push(P[P.length - 1]); return out;
  }
  function smoothPath(pts) {
    if (pts.length < 3) return pts.slice();
    const total = pathLen(pts); if (total < 0.2) return pts.slice();
    const rs = resample(pts, Math.max(0.04, total / 160));
    return rs.map((p, i) => {   // moving average
      let sx = 0, sy = 0, n = 0;
      for (let k = -4; k <= 4; k++) { const j = Math.max(0, Math.min(rs.length - 1, i + k)); sx += rs[j].x; sy += rs[j].y; n++; }
      return { x: sx / n, y: sy / n };
    });
  }

  /* ── world ↔ draw-canvas mapping (canvas spans WORLD_W × WORLD_H metres) ── */
  const WORLD_W = 6.4, WORLD_H = 4.2;
  const drawCanvas = $('[data-draw-canvas]');
  const dctx = drawCanvas.getContext('2d');
  function drawSize() { const r = drawCanvas.getBoundingClientRect(); return { w: r.width, h: r.height }; }
  function toWorld(px, py) { const { w, h } = drawSize(); return { x: (px / w - 0.5) * WORLD_W, y: (0.5 - py / h) * WORLD_H }; }
  function toPx(p) { const { w, h } = drawSize(); return [(p.x / WORLD_W + 0.5) * w, (0.5 - p.y / WORLD_H) * h]; }

  /* ── state: the drawn path + the 5 gait simulations ── */
  let rawPts = [], path = [], sims = {}, drawing = false;

  function commitPath() {
    path = smoothPath(rawPts);
    resetWalk();          // zero walkDist & move to the new start BEFORE drawing
    computeSims();
    renderDraw();
    const st = $('[data-status]'); if (st) st.textContent = path.length > 1 ? 'Space로 걷기 · 다시 드래그하면 새 경로' : '경로를 그려보세요';
  }
  function clearPath() { rawPts = []; path = []; sims = {}; state.walking = false; state.frozen = false; renderDraw(); renderPlots(); const st = $('[data-status]'); if (st) st.textContent = '경로를 그려보세요'; }

  // leg joint angles for gait g at phase gp (sweep amp AT) — FL,FR,RL,RR → [abad,thigh,knee]
  function legPose(g, gp, AT) {
    const comp = compOf(g, AT);
    return GAITS[g].offs.map((o) => {
      const ph = (((gp - o) % 1) + 1) % 1;
      if (ph < GAITS[g].duty) { const pr = ph / GAITS[g].duty, q1 = LEG.stand[1] + AT * (2 * pr - 1); return [0, q1, kneeFor(q1, stanceH(comp, pr))]; }
      const sw = (ph - GAITS[g].duty) / (1 - GAITS[g].duty), q1 = LEG.stand[1] + AT * (1 - 2 * sw);
      return [0, q1, kneeFor(q1) - LEG.AK * Math.sin(Math.PI * sw)];   // same base as stance → continuous at touchdown
    });
  }

  /* ── per-gait batch simulation ──
     Walks the truth path; at every step it builds each leg's joint angles, reads the body velocity
     BACK from the stance legs' joint rates (ᴮv = −Jq̇, forward = Lh·q̇₁), and integrates that at the
     drifting heading. Fewer feet / flight → more un-observable heading drift → the estimate curls off. */
  function simulateGait(g, P) {
    if (P.length < 2) return { est: [], drift: 0 };
    const dt = 1 / 60, ds = SPEED * dt, Gd = GAITS[g];
    const T = resample(P, ds);
    const rate = Gd.cad * (0.55 + SPEED);
    const AT = Math.min(ATMAX, SPEED * (Gd.duty / Math.max(0.3, rate)) / (2 * LEG.LH));
    const h0 = Math.atan2(T[1].y - T[0].y, T[1].x - T[0].x);
    let estX = T[0].x, estY = T[0].y, estYaw = h0, prevH = h0, gp = 0, vb = SPEED;
    let prevQ = legPose(g, 0, AT);
    const est = [{ x: estX, y: estY }];
    for (let i = 1; i < T.length; i++) {
      const h = Math.atan2(T[i].y - T[i - 1].y, T[i].x - T[i - 1].x);
      let yawRate = h - prevH; yawRate = Math.atan2(Math.sin(yawRate), Math.cos(yawRate)) / dt; prevH = h;
      gp = (gp + dt * rate) % 1;
      const q = legPose(g, gp, AT), contact = contactsOf(g, gp);
      // each stance leg → its own ᴮv via the ① chain+Jacobian; fuse by ARITHMETIC MEAN of the forward comp.
      let vsum = 0, nc = 0;
      q.forEach((ql, li) => { if (!contact[li]) return; vsum += legBodyVel(ql, prevQ[li], dt)[0]; nc++; });
      prevQ = q;
      if (nc > 0) { vb += (Math.max(-2, Math.min(2, vsum / nc)) - vb) * Math.min(1, dt * 6); estYaw += (yawRate + HB / nc) * dt; }
      else { estYaw += (yawRate + HB * 7) * dt; }   // flight: no planted foot → coast vb, heading drifts hard
      estX += Math.cos(estYaw) * vb * dt; estY += Math.sin(estYaw) * vb * dt;
      est.push({ x: estX, y: estY });
    }
    const end = T[T.length - 1];
    return { est, drift: Math.hypot(estX - end.x, estY - end.y) };
  }
  function computeSims() { sims = {}; GKEYS.forEach((g) => { sims[g] = simulateGait(g, path); }); renderPlots(); }

  /* ── draw-canvas rendering ── */
  function sizeCanvas(cv) { const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr)); }
  function renderDraw() {
    if (!dctx) return;
    const r = drawCanvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    if (drawCanvas.width !== Math.round(r.width * dpr)) sizeCanvas(drawCanvas);
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height;
    dctx.clearRect(0, 0, w, h);
    const grid = cssv('--border', '#D3DCE3'), sub = cssv('--text-muted', '#6B7B88');
    dctx.strokeStyle = grid; dctx.lineWidth = 1; dctx.setLineDash([3, 5]);
    for (let gx = -3; gx <= 3; gx++) { const [x] = toPx({ x: gx, y: 0 }); dctx.beginPath(); dctx.moveTo(x, 0); dctx.lineTo(x, h); dctx.stroke(); }
    for (let gy = -2; gy <= 2; gy++) { const [, y] = toPx({ x: 0, y: gy }); dctx.beginPath(); dctx.moveTo(0, y); dctx.lineTo(w, y); dctx.stroke(); }
    dctx.setLineDash([]);
    if (path.length > 1) {
      // commanded truth — light gray
      dctx.strokeStyle = 'rgba(139,148,158,0.5)'; dctx.lineWidth = 3; dctx.lineJoin = 'round'; dctx.beginPath();
      path.forEach((p, i) => { const [x, y] = toPx(p); i ? dctx.lineTo(x, y) : dctx.moveTo(x, y); }); dctx.stroke();
      const [sx, sy] = toPx(path[0]); dctx.fillStyle = '#3fb950'; dctx.beginPath(); dctx.arc(sx, sy, 5, 0, 7); dctx.fill();
      const [ex, ey] = toPx(path[path.length - 1]); dctx.fillStyle = 'rgba(139,148,158,0.8)'; dctx.beginPath(); dctx.arc(ex, ey, 5, 0, 7); dctx.fill();
      // estimated path for the current gait — stamped up to the current walk progress
      const est = sims[state.gait] && sims[state.gait].est;
      if (est && est.length > 1 && state.walkDist > 0) {
        const frac = Math.min(1, state.walkDist / (pathLen(path) || 1));
        const k = Math.max(1, Math.floor(frac * (est.length - 1)));
        dctx.strokeStyle = GAITS[state.gait].col; dctx.lineWidth = 2.6; dctx.beginPath();
        for (let i = 0; i <= k; i++) { const [x, y] = toPx(est[i]); i ? dctx.lineTo(x, y) : dctx.moveTo(x, y); } dctx.stroke();
        const [hx, hy] = toPx(est[k]); dctx.fillStyle = GAITS[state.gait].col; dctx.beginPath(); dctx.arc(hx, hy, 4.5, 0, 7); dctx.fill();
      }
    } else if (rawPts.length > 1) {
      dctx.strokeStyle = sub; dctx.lineWidth = 2; dctx.beginPath();
      rawPts.forEach((p, i) => { const [x, y] = toPx(p); i ? dctx.lineTo(x, y) : dctx.moveTo(x, y); }); dctx.stroke();
    } else {
      dctx.fillStyle = sub; dctx.font = "500 13px 'JetBrains Mono'"; dctx.textAlign = 'center';
      dctx.fillText('여기에 드래그해서 경로를 그리세요', w / 2, h / 2); dctx.textAlign = 'start';
    }
  }

  /* ── the 5 gait comparison plots ── */
  let cells = null;
  function buildGrid() {
    const grid = $('[data-gaitgrid]'); if (!grid || cells) return;
    cells = {};
    GKEYS.forEach((g) => {
      const cell = document.createElement('div'); cell.className = 'kin-gcell'; cell.dataset.gcell = g;
      const head = document.createElement('div'); head.className = 'kin-gcell-head';
      head.innerHTML = `<span class="kin-gcell-name" style="color:${GAITS[g].col}">${GAITS[g].label}</span><span class="kin-gcell-drift" data-drift>—</span>`;
      const cv = document.createElement('canvas'); cv.className = 'kin-gcell-canvas';
      cell.append(head, cv);
      cell.addEventListener('click', () => setGait(g));
      grid.appendChild(cell);
      cells[g] = { cell, cv, ctx: cv.getContext('2d'), drift: head.querySelector('[data-drift]') };
    });
  }
  function renderPlots() {
    buildGrid(); if (!cells) return;
    // shared bounds across truth + all estimates (fair comparison)
    let all = path.slice();
    GKEYS.forEach((g) => { if (sims[g]) all = all.concat(sims[g].est); });
    let maxDrift = -1, worst = null;
    GKEYS.forEach((g) => { if (sims[g] && sims[g].drift > maxDrift) { maxDrift = sims[g].drift; worst = g; } });
    GKEYS.forEach((g) => {
      const c = cells[g], ctx = c.ctx, cv = c.cv;
      const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr)); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = r.width, h = r.height, pad = 12;
      ctx.clearRect(0, 0, w, h);
      const truthC = '#8b949e', bd = cssv('--border', '#D3DCE3');
      c.cell.classList.toggle('is-worst', g === worst && maxDrift > 0.01);
      c.cell.classList.toggle('is-current', g === state.gait);
      if (!all.length || path.length < 2) { ctx.fillStyle = cssv('--text-muted', '#6B7B88'); ctx.font = "500 10px 'JetBrains Mono'"; ctx.textAlign = 'center'; ctx.fillText('경로 없음', w / 2, h / 2); ctx.textAlign = 'start'; c.drift.textContent = '—'; return; }
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      all.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
      const spanX = Math.max(0.3, maxX - minX), spanY = Math.max(0.3, maxY - minY);
      const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
      const cxw = (minX + maxX) / 2, cyw = (minY + maxY) / 2;
      const px = (p) => w / 2 + (p.x - cxw) * s, py = (p) => h / 2 - (p.y - cyw) * s;
      const line = (arr, color, width) => { if (arr.length < 2) return; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.beginPath(); arr.forEach((p, i) => { const X = px(p), Y = py(p); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke(); };
      line(path, truthC, 2);
      line(sims[g].est, GAITS[g].col, 2.2);
      // endpoints + drift connector
      const te = path[path.length - 1], ee = sims[g].est[sims[g].est.length - 1];
      ctx.setLineDash([3, 3]); ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px(te), py(te)); ctx.lineTo(px(ee), py(ee)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = truthC; ctx.beginPath(); ctx.arc(px(te), py(te), 3, 0, 7); ctx.fill();
      ctx.fillStyle = GAITS[g].col; ctx.beginPath(); ctx.arc(px(ee), py(ee), 3, 0, 7); ctx.fill();
      c.drift.textContent = sims[g].drift.toFixed(2) + ' m';
      c.drift.style.color = g === worst ? '#e5484d' : cssv('--text-muted', '#6B7B88');
    });
  }

  /* ── gait selector (drives the 3D robot) ── */
  function setGait(g) {
    state.gait = g; state.gaitPhase = 0; state.frozen = false;
    Object.values(gaitBtns).forEach((b) => b.classList.toggle('is-active', b.dataset.g === g));
    const cur = $('[data-gait-cur]'); if (cur) cur.textContent = g;
    renderPlots();
  }
  const gaitBtnWrap = $('[data-gait-btns]'), gaitBtns = {};
  if (gaitBtnWrap) GKEYS.forEach((g) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'kin-gait-btn' + (g === state.gait ? ' is-active' : ''); b.textContent = GAITS[g].label; b.dataset.g = g;
    b.addEventListener('click', () => setGait(g)); gaitBtnWrap.appendChild(b); gaitBtns[g] = b;
  });

  /* ── walk control: drive go2State along the path so the 3D robot follows it ── */
  function bumpTrail() { state.trailEpoch = (state.trailEpoch || 0) + 1; }
  function resetWalk() { state.walking = false; state.walkDist = 0; if (path.length) { state.worldX = path[0].x; state.worldZ = -path[0].y; state.heading = path.length > 1 ? Math.atan2(path[1].y - path[0].y, path[1].x - path[0].x) : 0; } bumpTrail(); }
  function toggleWalk() {
    if (state.walking) { state.walking = false; return; }        // Space again → stop where it is
    if (path.length < 2) return;
    if (state.walkDist >= pathLen(path) - 0.02 || state.walkDist <= 0) resetWalk();   // finished/fresh → from start
    state.walking = true; bumpTrail();
  }
  function pathPointAt(d) {   // point + heading at arc-length d along the path
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      const seg = dist(path[i - 1], path[i]);
      if (acc + seg >= d || i === path.length - 1) {
        const t = seg > 1e-6 ? Math.min(1, (d - acc) / seg) : 0;
        return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t, h: Math.atan2(path[i].y - path[i - 1].y, path[i].x - path[i - 1].x) };
      }
      acc += seg;
    }
    const n = path.length - 1; return { x: path[n].x, y: path[n].y, h: state.heading };
  }

  /* ── pointer drawing ── */
  drawCanvas.addEventListener('pointerdown', (e) => { drawing = true; rawPts = [toWorld(e.offsetX, e.offsetY)]; path = []; sims = {}; state.walking = false; state.walkDist = 0; drawCanvas.setPointerCapture(e.pointerId); });
  drawCanvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = toWorld(e.offsetX, e.offsetY); if (!rawPts.length || dist(p, rawPts[rawPts.length - 1]) > 0.03) { rawPts.push(p); renderDraw(); } });
  const endDraw = () => { if (!drawing) return; drawing = false; commitPath(); };
  drawCanvas.addEventListener('pointerup', endDraw); drawCanvas.addEventListener('pointercancel', endDraw);

  const walkBtn = $('[data-draw-walk]'); if (walkBtn) walkBtn.addEventListener('click', toggleWalk);
  const clearBtn = $('[data-draw-clear]'); if (clearBtn) clearBtn.addEventListener('click', clearPath);

  /* keyboard-focus coordinator (shared with ①) */
  window.KinKB = window.KinKB || (function () {
    let active = null;
    const setActive = (w) => { if (active === w) return; if (active) active.classList.remove('is-kb-active'); active = w || null; if (active) active.classList.add('is-kb-active'); };
    document.addEventListener('pointerdown', (e) => setActive(e.target.closest('[data-kin-kb]')), true);
    return { isActive: (w) => active === w, setActive };
  })();
  const lab = drawCanvas.closest('.kin-lab'); if (lab) lab.setAttribute('data-kin-kb', '');
  window.addEventListener('keydown', (e) => {
    if (!lab || !window.KinKB.isActive(lab)) return;
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); toggleWalk(); }
    else if (e.key.toLowerCase() === 'r') clearPath();
  });

  /* ── main loop: advance the walk + the gait clock (legs read by go2-viewer) ── */
  function tick(now) {
    const dt = Math.min(0.04, (now - state.last) / 1000); state.last = now;
    const len = path.length ? pathLen(path) : 0;
    if (state.walking && len > 0.1) {
      state.walkDist += SPEED * dt;
      const p = pathPointAt(state.walkDist);
      state.worldX = p.x; state.worldZ = -p.y;
      let dh = p.h - state.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); state.heading += dh * Math.min(1, dt * 8);
      state.velocity = SPEED;
      if (state.walkDist >= len) { state.walking = false; state.velocity = 0; }
    } else if (!state.walking) {
      state.velocity += (0 - state.velocity) * Math.min(1, dt * 4);
    }
    // Stopping freezes the pose where the gait actually was — mid-swing, mid-flight, whatever.
    // (Letting it keep running would decay `velocity` → AT → 0 and slide the legs back together.)
    if (state.walking) state.frozen = false; else if (state.wasWalking) state.frozen = true;
    state.wasWalking = state.walking;
    if (!state.frozen) {
      if (state.velocity > 0.02) state.gaitPhase = (state.gaitPhase + dt * GAITS[state.gait].cad * (0.55 + state.velocity)) % 1;
      const Gd = GAITS[state.gait];
      state.contacts = contactsOf(state.gait, state.gaitPhase);
      state.legState = Gd.offs.map((o) => { const ph = (((state.gaitPhase - o) % 1) + 1) % 1; return ph < Gd.duty ? { contact: true, prog: ph / Gd.duty } : { contact: false, prog: (ph - Gd.duty) / (1 - Gd.duty) }; });
      state.bodyLift = liftOf(state.gait, state.gaitPhase);
      state.bodyPitch = pitchOf(state.gait, state.gaitPhase);
      const rate = Gd.cad * (0.55 + state.velocity), AT = Math.min(ATMAX, state.velocity * (Gd.duty / Math.max(0.3, rate)) / (2 * LEG.LH));
      const comp = compOf(state.gait, AT);
      state.legQ = state.legState.map((ls) => {
        const q1 = LEG.stand[1] + AT * (ls.contact ? 2 * ls.prog - 1 : 1 - 2 * ls.prog);
        return ls.contact
          ? [0, q1, kneeFor(q1, stanceH(comp, ls.prog))]
          : [0, q1, kneeFor(q1) - LEG.AK * Math.sin(Math.PI * ls.prog)];
      });
    }
    const st = $('[data-status]'); if (st && path.length > 1) st.textContent = state.walking ? '걷는 중… (Space로 멈춤)' : 'Space로 걷기 · 다시 드래그하면 새 경로';
    if (walkBtn && walkBtn.dataset.w !== String(state.walking)) { walkBtn.dataset.w = String(state.walking); walkBtn.innerHTML = state.walking ? '<i class="fas fa-pause"></i> 멈춤' : '<i class="fas fa-play"></i> 걷기'; }
    if (state.walking || (state.walkDist > 0 && state.velocity > 0.02)) renderDraw();   // stamp the estimate live
    requestAnimationFrame(tick);
  }

  /* ── init: a default S-path so the comparison shows immediately ── */
  function defaultPath() { const P = []; for (let i = 0; i <= 40; i++) { const t = i / 40; P.push({ x: -2.6 + 5.2 * t, y: 1.25 * Math.sin(t * Math.PI * 1.6) }); } return P; }
  new ResizeObserver(() => { renderDraw(); renderPlots(); }).observe(drawCanvas);
  buildGrid();
  rawPts = defaultPath(); commitPath();
  requestAnimationFrame(tick);
})();
