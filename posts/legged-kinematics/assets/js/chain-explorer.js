/* URDF chain → body velocity — interactive guided explorer (vanilla, SVG).
   A step player walks one full cycle: build each joint position (forward
   kinematics recursion), then the lever arm, per-joint Jacobian contributions,
   transport term, and finally the body-frame velocity. Cards accumulate on the
   right; drag to rotate; sliders drive joint angles / rates / body rate. */
(function () {
  const root = document.querySelector('[data-chain-explorer]');
  if (!root) return;
  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || location.href;

  /* ── GO2-class front-left leg chain (approx. unitree go2_description) ── */
  const CHAIN = [
    { name: 'hip', org: [0.1934, 0.0465, 0], axis: [1, 0, 0] },
    { name: 'thigh', org: [0, 0.0955, 0], axis: [0, 1, 0] },
    { name: 'calf', org: [0, 0, -0.213], axis: [0, 1, 0] },
  ];
  const FOOT_OFF = [0, 0, -0.213];
  const BODY = [0.38, 0.17, 0.10];

  /* ── vec3 ── */
  const ad = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sb = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nrm = (a) => Math.hypot(a[0], a[1], a[2]);
  const rodr = (v, k, t) => {
    const c = Math.cos(t), s = Math.sin(t);
    const kv = cr(k, v), kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
    return ad(ad(sc(v, c), sc(kv, s)), sc(k, kd * (1 - c)));
  };

  /* joint angles → joint positions p_j, axes a_j (base frame), foot s, and the
     rotated offset vectors used to build each position */
  function chain(q) {
    const P = [], A = [], OFF = [];
    let o = [0, 0, 0];
    let R = (v) => v;
    for (let j = 0; j < 3; j++) {
      OFF.push(R(CHAIN[j].org));       // this joint's URDF offset, rotated by joints above
      o = ad(o, OFF[j]);
      const a = R(CHAIN[j].axis);
      P.push(o); A.push(a);
      const Rp = R, qj = q[j];
      R = (v) => rodr(Rp(v), a, qj);
    }
    const footOff = R(FOOT_OFF);
    const s = ad(o, footOff);
    return { P, A, s, OFF, footOff };
  }

  /* ── projection (orthographic, draggable az/el) ── */
  const mkProj = (az, el, scl, cx, cy) => (v) => {
    const sx = -v[0] * Math.sin(az) + v[1] * Math.cos(az);
    const d = v[0] * Math.cos(az) + v[1] * Math.sin(az);
    const sy = v[2] * Math.cos(el) - d * Math.sin(el);
    return [cx + sx * scl, cy - sy * scl];
  };

  const cssv = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);
  function palette() {
    return {
      ink: cssv('--text-primary', '#16222E'), sub: cssv('--text-muted', '#6B7B88'),
      grid: cssv('--border', '#D3DCE3'), pap: cssv('--bg-card', '#FFFFFF'), dim: cssv('--border-hover', '#B8C6D0'),
      j: ['#22a5c4', '#2bb59a', '#a084ff'], s: '#8496A3', Jq: '#4d8bff', om: '#f0883e', bv: '#3fb950', off: '#e0a341',
    };
  }

  /* ── step sequence ── */
  const STEPS = [
    { mode: 'fk', j: 0, title: 'p₁ · base → hip' },
    { mode: 'fk', j: 1, title: 'p₂ · p₁ 회전 + 오프셋' },
    { mode: 'fk', j: 2, title: 'p₃ · p₂ 회전 + 오프셋' },
    { mode: 'foot', title: '발 s · 체인 완성' },
    { mode: 'lever', title: 'lever arm s(q)' },
    { mode: 'jac', j: 2, title: '관절3(calf) 속도 기여' },
    { mode: 'jac', j: 1, title: '관절2(thigh) 속도 기여' },
    { mode: 'jac', j: 0, title: '관절1(hip) 속도 기여' },
    { mode: 'sum', title: 'J q̇ · 합' },
    { mode: 'transport', title: 'ω × s · transport' },
    { mode: 'bodyvel', title: 'ᴮv · body velocity' },
  ];

  /* ── state ── */
  // forward-walking stance frame (from go2-walk.json) → ᴮv points forward
  const DEF_Q = [-0.181, 0.989, -1.081], DEF_DQ = [0.272, 0.330, 3.359], DEF_OM = [0, 0, 0];
  const S = { q: DEF_Q.slice(), dq: DEF_DQ.slice(), om: DEF_OM.slice(), step: 0, cam: [0.75, 0.30], zoom: 1, trans: [0, 0] };
  const VIEW = 0.30;
  const inputs = [[], [], []];

  /* ── svg string helpers ── */
  const f = (n, d = 3) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(d);
  const ln = (a, b, stroke, w, dash) =>
    `<line x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" x2="${b[0].toFixed(2)}" y2="${b[1].toFixed(2)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="round"/>`;
  const tx = (x, y, size, fill, str, anchor) =>
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-size="${size}" fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ''} font-family="'JetBrains Mono',monospace">${str}</text>`;
  const dot = (p, r, fill, stroke, sw) =>
    `<circle cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw || 2}"` : ''}/>`;
  const foot = (p, r, fill, stroke, sw) =>   // foot pad: a rounded rectangle, distinct from joint circles
    `<rect x="${(p[0] - r).toFixed(2)}" y="${(p[1] - r * 0.7).toFixed(2)}" width="${(2 * r).toFixed(2)}" height="${(1.4 * r).toFixed(2)}" rx="2" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw || 2}"` : ''}/>`;
  function arrow(a, b, color, w, op) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 2) return '';
    const ux = dx / L, uy = dy / L, h = Math.min(9, L * 0.35);
    const bx = b[0] - ux * h, by = b[1] - uy * h;
    return `<g opacity="${op == null ? 1 : op}">` + ln([a[0], a[1]], [bx, by], color, w) +
      `<path d="M${b[0].toFixed(2)},${b[1].toFixed(2)} L${(bx - uy * h * 0.4).toFixed(2)},${(by + ux * h * 0.4).toFixed(2)} L${(bx + uy * h * 0.4).toFixed(2)},${(by - ux * h * 0.4).toFixed(2)} Z" fill="${color}"/></g>`;
  }
  const V3 = (v, c, d = 3) => `<span class="ce-v3" style="color:${c}">[${f(v[0], d)} ${f(v[1], d)} ${f(v[2], d)}]</span>`;

  /* ── skeleton ── */
  root.innerHTML =
    '<div class="ce-controls" data-ce-controls></div>' +
    '<div class="ce-player" data-ce-player></div>' +
    '<div class="ce-main">' +
      '<svg class="ce-svg" data-ce-svg viewBox="0 0 560 360" preserveAspectRatio="xMidYMid meet"></svg>' +
      '<div class="ce-cards" data-ce-cards></div>' +
    '</div>' +
    '<div class="ce-sliders" data-ce-sliders></div>';

  const elControls = root.querySelector('[data-ce-controls]');
  const elPlayer = root.querySelector('[data-ce-player]');
  const svg = root.querySelector('[data-ce-svg]');
  const elCards = root.querySelector('[data-ce-cards]');
  const elSliders = root.querySelector('[data-ce-sliders]');

  /* player controls (manual stepping only) */
  elPlayer.innerHTML =
    '<button class="ce-pl-btn" data-pl="prev" type="button" aria-label="이전 (←)">◀</button>' +
    '<button class="ce-pl-btn" data-pl="next" type="button" aria-label="다음 (Space·→)">▶</button>' +
    '<span class="ce-pl-count" data-pl-count></span>' +
    '<span class="ce-pl-dots" data-pl-dots></span>';
  const plCount = elPlayer.querySelector('[data-pl-count]');
  const plDots = elPlayer.querySelector('[data-pl-dots]');
  function goStep(i) { S.step = Math.max(0, Math.min(STEPS.length - 1, i)); update(); }
  STEPS.forEach((s, i) => {
    const d = document.createElement('button');
    d.className = 'ce-pl-dot'; d.type = 'button'; d.title = (i + 1) + '. ' + s.title;
    d.addEventListener('click', () => goStep(i));
    plDots.appendChild(d);
  });
  elPlayer.querySelector('[data-pl="prev"]').addEventListener('click', () => goStep(S.step - 1));
  elPlayer.querySelector('[data-pl="next"]').addEventListener('click', () => goStep(S.step + 1));
  let hot = false;   // keyboard only acts while the explorer is hovered / focused (avoids clashing with other page widgets)
  root.addEventListener('pointerenter', () => { hot = true; });
  root.addEventListener('pointerleave', () => { hot = false; });
  window.addEventListener('keydown', (e) => {
    if (!hot && !root.contains(document.activeElement)) return;
    const el = document.activeElement, tag = el && el.tagName, inRange = tag === 'INPUT' && el.type === 'range';
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space' || e.key === ' ') { if (tag === 'INPUT' && !inRange) return; e.preventDefault(); goStep(S.step + 1); }
    else if (e.key === 'ArrowRight') { if (inRange) return; e.preventDefault(); goStep(S.step + 1); }
    else if (e.key === 'ArrowLeft') { if (inRange) return; e.preventDefault(); goStep(S.step - 1); }
  });

  /* sliders */
  const P0 = palette();
  const sliderGroups = [
    { title: '관절각 q', arr: S.q, labs: ['q₁', 'q₂', 'q₃'], min: -2.6, max: 2.6, cols: P0.j },
    { title: '관절각속도 q̇', arr: S.dq, labs: ['q̇₁', 'q̇₂', 'q̇₃'], min: -4, max: 4, cols: P0.j },
    { title: '자이로 ω', arr: S.om, labs: ['ωx', 'ωy', 'ωz'], min: -2.5, max: 2.5, cols: [P0.om, P0.om, P0.om] },
  ];
  const valSpans = [];
  sliderGroups.forEach((gp, gi) => {
    const wrap = document.createElement('div');
    wrap.className = 'ce-sgroup';
    wrap.innerHTML = `<div class="ce-sgroup-title">${gp.title}</div>`;
    valSpans[gi] = [];
    for (let j = 0; j < 3; j++) {
      const row = document.createElement('div'); row.className = 'ce-srow';
      const lab = document.createElement('span'); lab.className = 'ce-slab'; lab.textContent = gp.labs[j]; lab.style.color = gp.cols[j];
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = gp.min; inp.max = gp.max; inp.step = '0.02'; inp.value = gp.arr[j];
      inp.className = 'ce-srange'; inp.style.accentColor = gp.cols[j];
      const val = document.createElement('span'); val.className = 'ce-sval'; val.textContent = f(gp.arr[j], 2);
      inp.addEventListener('input', (e) => { gp.arr[j] = parseFloat(e.target.value); update(); });
      row.append(lab, inp, val); wrap.appendChild(row);
      valSpans[gi][j] = val; inputs[gi][j] = inp;
    }
    elSliders.appendChild(wrap);
  });

  /* drag to rotate */
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    const rect = svg.getBoundingClientRect();
    // left = rotate · middle/right = pan
    drag = { x: e.clientX, y: e.clientY, cam: S.cam.slice(), trans: S.trans.slice(), rect, mode: (e.button === 1 || e.button === 2) ? 'pan' : 'rot' };
    if (drag.mode === 'pan') e.preventDefault();
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'pan') {
      S.trans = [drag.trans[0] + (e.clientX - drag.x) * (560 / drag.rect.width), drag.trans[1] + (e.clientY - drag.y) * (360 / drag.rect.height)];
    } else {
      S.cam = [drag.cam[0] + (e.clientX - drag.x) * 0.008, Math.max(-0.6, Math.min(1.3, drag.cam[1] + (e.clientY - drag.y) * 0.006))];
    }
    update();
  });
  const stopDrag = () => { drag = null; };
  svg.addEventListener('pointerup', stopDrag); svg.addEventListener('pointerleave', stopDrag);
  svg.addEventListener('contextmenu', (e) => e.preventDefault());          // allow right-drag pan
  svg.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); }); // no middle-click autoscroll
  /* wheel = zoom toward cursor · double-click = reset view */
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width * 560, my = (e.clientY - rect.top) / rect.height * 360;
    const bx = (mx - S.trans[0]) / S.zoom, by = (my - S.trans[1]) / S.zoom;   // cursor in un-zoomed coords
    S.zoom = Math.max(0.6, Math.min(8, S.zoom * Math.exp(-e.deltaY * 0.0016)));
    S.trans = [mx - S.zoom * bx, my - S.zoom * by];                            // keep cursor point fixed
    update();
  }, { passive: false });
  svg.addEventListener('dblclick', () => { S.zoom = 1; S.trans = [0, 0]; update(); });

  /* ── main update ── */
  function update() {
    const C = palette();
    const { P, A, s, OFF, footOff } = chain(S.q);
    const cols = [0, 1, 2].map((j) => cr(A[j], sb(s, P[j])));
    const parts = [0, 1, 2].map((j) => sc(cols[j], S.dq[j]));
    const Jq = parts.reduce(ad, [0, 0, 0]);
    const tra = cr(S.om, s);
    const bv = sc(ad(tra, Jq), -1);
    const step = STEPS[S.step], mode = step.mode;

    const W = 560, H = 360;
    const pr = mkProj(S.cam[0], S.cam[1], 470, W * 0.44, H * 0.30);
    const p0 = pr([0, 0, 0]);
    const pts = [[0, 0, 0], P[0], P[1], P[2], s];

    let g = '';
    /* body wireframe */
    const [ha, hb, hc] = BODY.map((x) => x / 2);
    const bw = [[-ha, -hb, -hc], [ha, -hb, -hc], [ha, hb, -hc], [-ha, hb, -hc], [-ha, -hb, hc], [ha, -hb, hc], [ha, hb, hc], [-ha, hb, hc]];
    [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([i, k]) => { g += ln(pr(bw[i]), pr(bw[k]), C.dim, 1); });
    /* base frame */
    [[[0.09, 0, 0], 'x'], [[0, 0.09, 0], 'y'], [[0, 0, 0.09], 'z']].forEach(([v, l]) => { const e = pr(v); g += ln(p0, e, C.sub, 1) + tx(e[0] + 3, e[1], 8, C.sub, l); });
    g += dot(p0, 3.5, C.ink);

    const fk = mode === 'fk' || mode === 'foot';
    const curIdx = mode === 'foot' ? 3 : (mode === 'fk' ? step.j : 3);

    if (fk) {
      /* faint ghost of the whole leg (base→p1→p2→p3→foot) so the foot link is always visible */
      for (let i = 0; i < 4; i++) g += ln(pr(pts[i]), pr(pts[i + 1]), C.dim, 1.5);
      for (let i = 1; i <= 3; i++) g += dot(pr(pts[i]), 3, C.pap, C.dim, 1.5);
      g += foot(pr(s), 4.5, C.pap, C.dim, 1.5);
      /* established links up to the current joint (index curIdx) */
      for (let i = 0; i < curIdx; i++) g += ln(pr(pts[i]), pr(pts[i + 1]), C.ink, 3.5);
      /* rotation axis that orients the current offset (joint curIdx, at pts[curIdx]) */
      if (curIdx >= 1) {
        const jr = curIdx - 1;
        g += arrow(pr(ad(P[jr], sc(A[jr], -0.04))), pr(ad(P[jr], sc(A[jr], 0.07))), C.j[jr], 1.6, 0.9);
      }
      /* the current offset arrow prev → cur */
      const a = pr(pts[curIdx]), b = pr(pts[curIdx + 1]);
      g += arrow(a, b, C.off, 3.4);
      g += tx((a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - 4, 9.5, C.off, mode === 'foot' ? 'R·FOOT_OFF' : (curIdx === 0 ? 'org₁' : `R·org${curIdx + 1}`));
      /* joints placed so far */
      for (let i = 1; i <= curIdx; i++) g += dot(pr(pts[i]), 4, C.pap, C.j[i - 1], 2);
      const cp = pts[curIdx + 1];
      if (mode === 'foot') g += foot(pr(cp), 6.5, C.bv, C.pap, 1.6) + tx(pr(cp)[0] + 10, pr(cp)[1], 10, C.bv, 's');
      else g += dot(pr(cp), 5, C.j[curIdx], C.pap, 1.5) + tx(pr(cp)[0] + 8, pr(cp)[1] - 5, 10, C.j[curIdx], `p${curIdx + 1}`);
    } else {
      /* full chain */
      for (let j = 0; j < 3; j++) {
        const a = pr(P[j]), b = pr(j === 2 ? s : P[j + 1]);
        const act = mode === 'jac' && step.j === j;
        const op = mode === 'jac' && step.j !== j ? 0.25 : 1;
        g += `<line x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" x2="${b[0].toFixed(2)}" y2="${b[1].toFixed(2)}" stroke="${act ? C.j[j] : C.ink}" stroke-width="${act ? 5 : 3.5}" stroke-linecap="round" opacity="${op}"/>`;
      }
      g += ln(pr(P[0]), p0, C.dim, 2);
      for (let j = 0; j < 3; j++) {
        const showAx = mode === 'sum' || (mode === 'jac' && step.j === j);
        if (showAx) g += arrow(pr(ad(P[j], sc(A[j], -0.045))), pr(ad(P[j], sc(A[j], 0.075))), C.j[j], 1.8, mode === 'sum' && step.j !== j ? 0.6 : 1);
        g += dot(pr(P[j]), 4, C.pap, C.j[j], 2);
      }
      g += foot(pr(s), 6, C.ink);

      if (mode === 'lever') {
        g += ln(p0, pr(s), C.s, 1.6, '4 3');
        g += tx((p0[0] + pr(s)[0]) / 2 + 6, (p0[1] + pr(s)[1]) / 2, 10, C.s, `s(q) ‖·‖=${nrm(s).toFixed(3)}`);
      } else if (mode === 'jac') {
        const j = step.j, pj = pr(P[j]), sp = pr(s), col = pr(ad(s, sc(cols[j], VIEW)));
        g += ln(pj, sp, C.j[j], 1.3, '3 3') + tx((pj[0] + sp[0]) / 2 + 5, (pj[1] + sp[1]) / 2 - 4, 9, C.j[j], `s − p${j + 1}`);
        g += arrow(sp, col, C.j[j], 2.8) + tx(col[0] + 6, col[1], 9.5, C.j[j], `J:,${j + 1}`);
      } else if (mode === 'sum') {
        let cur = s;
        for (let j = 0; j < 3; j++) { const a = pr(cur); cur = ad(cur, sc(parts[j], VIEW)); const b = pr(cur); g += arrow(a, b, C.j[j], 2.4) + tx(b[0] + 5, b[1] - 3, 8.5, C.j[j], `q̇${j + 1}·J:,${j + 1}`); }
        const b = pr(ad(s, sc(Jq, VIEW))); g += arrow(pr(s), b, C.Jq, 3.2) + tx(b[0] + 6, b[1] + 10, 10, C.Jq, 'J q̇');
      } else if (mode === 'transport') {
        g += arrow(pr(s), pr(ad(s, sc(Jq, VIEW))), C.Jq, 3, 0.8);
        const b = pr(ad(s, sc(tra, VIEW))); g += arrow(pr(s), b, C.om, 2.8) + tx(b[0] + 6, b[1], 10, C.om, 'ω × s');
      } else if (mode === 'bodyvel') {
        g += arrow(pr(s), pr(ad(s, sc(Jq, VIEW))), C.Jq, 2.4, 0.55);
        g += arrow(pr(s), pr(ad(s, sc(tra, VIEW))), C.om, 2.2, 0.55);
        const b = pr(ad([0, 0, 0], sc(bv, VIEW))); g += arrow(p0, b, C.bv, 3.6) + tx(b[0] + 6, b[1], 11, C.bv, 'ᴮv');
      }
    }
    // zoom/pan applied as a group transform so geometry AND text scale together
    svg.innerHTML = `<g transform="translate(${S.trans[0].toFixed(2)} ${S.trans[1].toFixed(2)}) scale(${S.zoom.toFixed(4)})">${g}</g>` +
      tx(10, 15, 9, C.sub, '드래그로 회전 · 전방 x, 좌 y, 상 z');

    /* ── right column: accumulating cards up to current step ── */
    let cards = '';
    for (let i = 0; i <= S.step; i++) cards += cardHTML(i, C, { P, A, s, OFF, footOff, cols, parts, Jq, tra, bv });
    elCards.innerHTML = cards;
    const active = elCards.querySelector('.ce-card.is-active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });

    /* player state */
    plCount.textContent = `${S.step + 1} / ${STEPS.length}`;
    plDots.querySelectorAll('.ce-pl-dot').forEach((d, i) => { d.classList.toggle('is-active', i === S.step); d.classList.toggle('is-done', i < S.step); });

    valSpans[0].forEach((v, j) => v.textContent = f(S.q[j], 2));
    valSpans[1].forEach((v, j) => v.textContent = f(S.dq[j], 2));
    valSpans[2].forEach((v, j) => v.textContent = f(S.om[j], 2));
  }

  /* card content for step i (uses current pose values) */
  function cardHTML(i, C, G) {
    const st = STEPS[i], m = st.mode;
    const cls = 'ce-card' + (i === S.step ? ' is-active' : '');
    let head = `<div class="ce-card-h"><span class="ce-card-n">${i + 1}</span>${st.title}</div>`;
    let b = '';
    if (m === 'fk' && st.j === 0) {
      b = `<div class="ce-note">hip 앞엔 회전 관절이 없어서 URDF 오프셋이 그대로 위치. 관절각과 무관.</div>` +
        `<div>p₁ = org₁ = ${V3(G.P[0], C.j[0])}</div>`;
    } else if (m === 'fk') {
      const j = st.j;
      b = `<div class="ce-note">위쪽 관절들의 누적 회전으로 URDF 오프셋을 돌려 이전 위치에 더한다.</div>` +
        `<div>p${j + 1} = p${j} + R·org${j + 1}</div>` +
        `<div>R·org${j + 1} = ${V3(G.OFF[j], C.off)}</div>` +
        `<div class="ce-pt">p${j + 1} = ${V3(G.P[j], C.j[j])}</div>`;
    } else if (m === 'foot') {
      b = `<div class="ce-note">마지막 링크 오프셋까지 더하면 발 위치. 체인 완성.</div>` +
        `<div>s = p₃ + R·FOOT_OFF</div>` +
        `<div class="ce-pt">s = ${V3(G.s, C.bv)}  ‖s‖=${nrm(G.s).toFixed(3)}</div>`;
    } else if (m === 'lever') {
      b = `<div class="ce-note">base(body 원점)에서 발까지의 벡터 = lever arm. ω×s 크기를 정하고, 자이로 bias가 새어드는 통로.</div>` +
        `<div>s(q) = ${V3(G.s, C.s)}  ‖s‖=${nrm(G.s).toFixed(4)} m</div>`;
    } else if (m === 'jac') {
      const j = st.j, partial = [0, 1, 2].filter((k) => k >= j).reduce((a, k) => ad(a, G.parts[k]), [0, 0, 0]);
      b = `<div>a${j + 1} × (s−p${j + 1}) = J:,${j + 1} ${V3(G.cols[j], C.j[j])}</div>` +
        `<div>× q̇${j + 1}=${f(S.dq[j], 2)} → ${V3(G.parts[j], C.j[j])}</div>` +
        `<div class="ce-pt">누적 Jq̇ = ${V3(partial, C.Jq)}</div>`;
    } else if (m === 'sum') {
      b = `<div>J q̇ = Σ q̇ⱼ·J:,ⱼ</div><div class="ce-pt">= ${V3(G.Jq, C.Jq)}</div>`;
    } else if (m === 'transport') {
      b = `<div>ω ${V3(S.om, C.om, 2)} × s = ${V3(G.tra, C.om)}</div>` +
        `<div class="ce-note">q̇=0이어도 몸통이 돌면 발끝은 휩쓸린다.</div>`;
    } else if (m === 'bodyvel') {
      b = `<div>ᴮv = −( ω×s + Jq̇ )</div>` +
        `<div class="ce-pt">= ${V3(G.bv, C.bv)}  ‖·‖=${nrm(G.bv).toFixed(3)} m/s</div>` +
        `<div class="ce-note">우변에 R이 없다 — 자세를 몰라도 body-frame 속도가 나온다.</div>`;
    }
    return `<div class="${cls}">${head}<div class="ce-card-b">${b}</div></div>`;
  }

  /* ── controls: reset (walking playback lives in the trajectory section) ── */
  const resetBtn = document.createElement('button'); resetBtn.className = 'ce-reset-btn'; resetBtn.type = 'button'; resetBtn.textContent = '↺ reset';
  const hint = document.createElement('span'); hint.className = 'ce-controls-hint'; hint.textContent = 'Space·→ 다음 스텝 · ← 이전 · 드래그 회전 · 휠 확대 · 휠클릭 이동 · 더블클릭 리셋';
  elControls.append(resetBtn, hint);
  function setPose(q, dq, om) {
    for (let j = 0; j < 3; j++) {
      S.q[j] = q[j]; S.dq[j] = Math.max(-4, Math.min(4, dq[j])); S.om[j] = om[j];
      inputs[0][j].value = Math.max(-2.6, Math.min(2.6, q[j])); inputs[1][j].value = S.dq[j]; inputs[2][j].value = om[j];
    }
  }
  // reset = restore the forward-walking pose AND return to step 1
  resetBtn.addEventListener('click', () => { setPose(DEF_Q, DEF_DQ, DEF_OM); goStep(0); });

  // re-render so SVG colors track light/dark theme changes (leg uses --text-primary)
  new MutationObserver(() => update()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => update()); } catch (_) { } }

  goStep(0);
})();
