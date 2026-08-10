/* Drive the GO2 and build a top-down trajectory.
   Reads the per-leg body velocity that go2-viewer publishes as telemetry,
   fuses the stance legs, and dead-reckons a kinematic path (∫ ᴮv dt) against
   the world-frame ground truth. No IMU / no absolute reference → it drifts. */
(function () {
  const app = document.querySelector('[data-kinematics-app]');
  if (!app) return;
  const canvas = app.querySelector('[data-traj-canvas]');
  const ctx = canvas ? canvas.getContext('2d') : null;
  const $ = (q) => app.querySelector(q);
  const cssv = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);

  const state = {
    command: 0, velocity: 0, turnCommand: 0, yawRate: 0,
    heading: 0, worldX: 0, worldZ: 0, phase: 0, paused: false, last: performance.now(),
  };
  app.go2State = state;

  const HEADING_BIAS = 0.02;   // rad/s of un-observable heading drift in the dead-reckoning estimate
  const est = { kinX: 0, kinY: 0, estYaw: 0, vb: 0, truth: [], kin: [], moved: false };

  /* ── controls ── */
  function setCommand(v) {
    state.command = Math.max(-1.2, Math.min(1.2, v));
    const sp = $('[data-speed]'), out = $('[data-speed-output]');
    if (sp) sp.value = state.command;
    if (out) out.textContent = state.command.toFixed(2) + ' m/s';
  }
  function reset() {
    Object.assign(state, { command: 0, velocity: 0, turnCommand: 0, yawRate: 0, heading: 0, worldX: 0, worldZ: 0, phase: 0 });
    Object.assign(est, { kinX: 0, kinY: 0, estYaw: 0, vb: 0, truth: [], kin: [], moved: false });
    setCommand(0);
  }
  function clearPaths() { est.kinX = state.worldX; est.kinY = -state.worldZ; est.estYaw = state.heading; est.truth = []; est.kin = []; }

  app.querySelectorAll('[data-drive]').forEach((b) => b.addEventListener('click', () => setCommand(Number(b.dataset.drive) * 0.4)));
  app.querySelectorAll('[data-turn]').forEach((b) => {
    const on = () => { state.turnCommand = Number(b.dataset.turn) * 0.7; };
    const off = () => { state.turnCommand = 0; };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off);
    b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
  });
  const speed = $('[data-speed]');
  if (speed) speed.addEventListener('input', (e) => setCommand(Number(e.target.value)));
  const clearBtn = $('[data-traj-clear]');
  if (clearBtn) clearBtn.addEventListener('click', clearPaths);

  // keyboard only while the lab is hovered / focused (so it doesn't fight the chain explorer)
  const lab = canvas ? canvas.closest('.kin-lab') : null;
  let hot = false;
  if (lab) { lab.addEventListener('pointerenter', () => { hot = true; }); lab.addEventListener('pointerleave', () => { hot = false; }); }
  window.addEventListener('keydown', (e) => {
    if (!hot && !(lab && lab.contains(document.activeElement))) return;
    const t = document.activeElement && document.activeElement.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA') return;
    if (e.key === 'ArrowUp') { e.preventDefault(); setCommand(state.command + 0.1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCommand(state.command - 0.1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); state.turnCommand = 0.7; }
    else if (e.key === 'ArrowRight') { e.preventDefault(); state.turnCommand = -0.7; }
    else if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); state.paused = !state.paused; }
    else if (e.key.toLowerCase() === 'r') { reset(); }
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') state.turnCommand = 0; });

  /* fuse the stance legs' body-velocity estimates (from go2-viewer telemetry) */
  function fusedVb() {
    const tel = app.go2Telemetry;
    if (!tel || !tel.legs) return null;
    const c = tel.legs.filter((l) => l.contact && Number.isFinite(l.vb));
    if (!c.length) return null;
    return c.reduce((s, l) => s + l.vb, 0) / c.length;
  }

  /* ── main loop ── */
  function tick(now) {
    const dt = Math.min(0.04, (now - state.last) / 1000); state.last = now;
    if (!state.paused && dt > 0) {
      state.velocity += (state.command - state.velocity) * Math.min(1, dt * 3.5);
      state.yawRate += (state.turnCommand - state.yawRate) * Math.min(1, dt * 8);
      state.heading += state.yawRate * dt;
      state.worldX += Math.cos(state.heading) * state.velocity * dt;
      state.worldZ -= Math.sin(state.heading) * state.velocity * dt;
      state.phase += dt * (2.2 + Math.abs(state.velocity) * 3.4);

      const moving = Math.abs(state.velocity) > 0.02;
      const vb = fusedVb();
      if (moving && vb != null) {
        est.vb += (vb - est.vb) * Math.min(1, dt * 6);
        est.estYaw += (state.yawRate + HEADING_BIAS) * dt;        // heading drifts (no absolute ref)
        est.kinX += Math.cos(est.estYaw) * est.vb * dt;
        est.kinY += Math.sin(est.estYaw) * est.vb * dt;
        est.truth.push([state.worldX, -state.worldZ]);
        est.kin.push([est.kinX, est.kinY]);
        if (est.truth.length > 4000) { est.truth.shift(); est.kin.shift(); }
        est.moved = true;
      }
      updateReadout(moving);
    }
    draw();
    requestAnimationFrame(tick);
  }

  function updateReadout(moving) {
    const st = $('[data-status]');
    if (st) st.textContent = state.paused ? '정지(pause)' : (!moving ? '정지' : (state.velocity > 0 ? '전진' : '후진')) +
      (Math.abs(state.yawRate) > 0.05 ? (state.yawRate > 0 ? ' · 좌회전' : ' · 우회전') : '');
    const sg = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
    const tt = $('[data-traj-truth]'); if (tt) tt.textContent = 'x ' + sg(state.worldX) + ' · y ' + sg(-state.worldZ);
    const tk = $('[data-traj-kin]'); if (tk) tk.textContent = 'x ' + sg(est.kinX) + ' · y ' + sg(est.kinY);
    const td = $('[data-traj-drift]');
    if (td) td.textContent = 'drift ' + Math.hypot(est.kinX - state.worldX, est.kinY + state.worldZ).toFixed(2) + ' m';
  }

  /* ── top-down plot ── */
  function sizeCanvas() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  function draw() {
    if (!ctx) return;
    const r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * (Math.min(devicePixelRatio || 1, 2))) ) sizeCanvas();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height, pad = 26;
    ctx.clearRect(0, 0, w, h);

    const ink = cssv('--text-primary', '#16222E'), sub = cssv('--text-muted', '#6B7B88'), grid = cssv('--border', '#D3DCE3');
    const truthC = '#8b949e', kinC = '#4d8bff';

    // fit both paths (+ current points) into view
    const pts = [[state.worldX, -state.worldZ], [est.kinX, est.kinY]].concat(est.truth, est.kin);
    let minX = -0.6, maxX = 0.6, minY = -0.6, maxY = 0.6;
    pts.forEach((p) => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
    const spanX = maxX - minX, spanY = maxY - minY, cxw = (minX + maxX) / 2, cyw = (minY + maxY) / 2;
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const px = (x) => w / 2 + (x - cxw) * scale;
    const py = (y) => h / 2 - (y - cyw) * scale;

    // grid (1 m or auto step)
    const raw = 2 / scale * 40, pow = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / pow, step = (n < 2 ? 1 : n < 5 ? 2 : 5) * pow;
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    const x0 = cxw - w / (2 * scale), x1 = cxw + w / (2 * scale), y0 = cyw - h / (2 * scale), y1 = cyw + h / (2 * scale);
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { ctx.beginPath(); ctx.moveTo(px(x), 0); ctx.lineTo(px(x), h); ctx.stroke(); }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { ctx.beginPath(); ctx.moveTo(0, py(y)); ctx.lineTo(w, py(y)); ctx.stroke(); }
    ctx.setLineDash([]);
    // origin cross
    ctx.strokeStyle = sub; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(px(0), 0); ctx.lineTo(px(0), h); ctx.moveTo(0, py(0)); ctx.lineTo(w, py(0)); ctx.stroke();
    ctx.fillStyle = sub; ctx.font = "500 9px 'JetBrains Mono',monospace";
    ctx.fillText('grid ' + step.toFixed(step < 1 ? 1 : 0) + ' m', 8, 13);
    ctx.fillText('x →', w - 24, py(0) - 6); ctx.fillText('y ↑', px(0) + 6, 12);

    const path = (arr, color, width) => {
      if (arr.length < 2) return;
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      arr.forEach((p, i) => { const X = px(p[0]), Y = py(p[1]); if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); });
      ctx.stroke();
    };
    path(est.truth, truthC, 2);
    path(est.kin, kinC, 2.4);
    // current markers
    const head = (x, y, ang, color) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px(x), py(y), 4, 0, Math.PI * 2); ctx.fill();
    };
    head(state.worldX, -state.worldZ, state.heading, truthC);
    head(est.kinX, est.kinY, est.estYaw, kinC);

    if (!est.moved) {
      ctx.fillStyle = sub; ctx.font = "500 12px 'JetBrains Mono',monospace"; ctx.textAlign = 'center';
      ctx.fillText('로봇을 몰면 경로가 쌓입니다 (↑ 또는 forward)', w / 2, h / 2);
      ctx.textAlign = 'start';
    }
  }

  if (canvas) new ResizeObserver(sizeCanvas).observe(canvas);
  sizeCanvas();
  setCommand(0);
  requestAnimationFrame(tick);
})();
