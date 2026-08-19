/* Multiple contact feet + a gyro (IMU) → each stance leg independently reports a body velocity
   ᴮvᵢ = −(ω×sᵢ + Jᵢq̇ᵢ); we ARITHMETIC-MEAN them (slip/encoder noise averages out).
   Left: per-leg ᴮv in the ① 3D chain view. Right: the same, top-down. */
(function () {
  const root = document.querySelector('[data-imu-mean]');
  if (!root) return;

  /* ── vec3 + chain (same URDF machinery as ①) ── */
  const ad = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sb = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nrm = (a) => Math.hypot(a[0], a[1], a[2]);
  const rodr = (v, k, t) => { const c = Math.cos(t), s = Math.sin(t), kv = cr(k, v), kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2]; return ad(ad(sc(v, c), sc(kv, s)), sc(k, kd * (1 - c))); };
  const FOOT_OFF = [0, 0, -0.213], BODY = [0.38, 0.17, 0.10];
  // a leg's URDF chain, mounted at its body corner (sign flips the y offsets for right legs)
  const legChain = (mx, my, sgn) => [{ org: [mx, my, 0], axis: [1, 0, 0] }, { org: [0, sgn * 0.0955, 0], axis: [0, 1, 0] }, { org: [0, 0, -0.213], axis: [0, 1, 0] }];
  function chain(CH, q) {
    const P = [], A = []; let o = [0, 0, 0], R = (v) => v;
    for (let j = 0; j < 3; j++) { o = ad(o, R(CH[j].org)); const a = R(CH[j].axis); P.push(o); A.push(a); const Rp = R, qj = q[j]; R = (v) => rodr(Rp(v), a, qj); }
    return { P, A, s: ad(o, R(FOOT_OFF)) };
  }

  /* ── 4 legs (stance pose), each with a fixed slip bias so the mean visibly helps ── */
  const QST = [0, 0.5, -1.05];
  const LEGS = [
    { id: 'FL', CH: legChain(0.1934, 0.0465, 1), col: '#22a5c4', bias: [0.06, 0.05, 0] },
    { id: 'FR', CH: legChain(0.1934, -0.0465, -1), col: '#2bb59a', bias: [-0.05, 0.03, 0] },
    { id: 'RL', CH: legChain(-0.1934, 0.0465, 1), col: '#a084ff', bias: [0.035, -0.06, 0] },
    { id: 'RR', CH: legChain(-0.1934, -0.0465, -1), col: '#e0a341', bias: [-0.07, -0.02, 0] },
  ];
  LEGS.forEach((L) => { const k = chain(L.CH, QST); L.P = k.P; L.s = k.s; });
  const TRUE_V = [0.55, 0.10, 0];        // true body velocity the gyro-aided legs recover
  const OM = [0, 0, 0.6];                // gyro-provided ω (context)
  const SLIP = [0.62, -0.5, 0];          // a slipping foot reports a badly-wrong ᴮv (outlier)
  const S = { on: { FL: true, FR: true, RL: true, RR: true }, slip: {}, method: 'mean' };
  const legVel = (L) => ad(ad(TRUE_V, L.bias), S.slip[L.id] ? SLIP : [0, 0, 0]);

  /* ── fusion of the stance legs' ᴮvᵢ (ω is known, so each foot yields a full ᴮv) ── */
  const median1 = (a) => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const medianVec = (vs) => [0, 1, 2].map((k) => median1(vs.map((v) => v[k])));
  const meanVec = (vs) => sc(vs.reduce((a, v) => ad(a, v), [0, 0, 0]), 1 / vs.length);
  function robustVec(vs) {                 // median → residual → reject outliers → mean of inliers
    if (vs.length < 3) return medianVec(vs);
    const m = medianVec(vs), res = vs.map((v) => nrm(sb(v, m)));
    const mad = median1(res) || 1e-3, thr = Math.max(0.06, 2.5 * mad);
    const inl = vs.filter((v, i) => res[i] <= thr);
    return { v: meanVec(inl.length ? inl : vs), keep: vs.map((v, i) => res[i] <= thr) };
  }
  const METHODS = [{ id: 'mean', label: '산술 평균', fn: (vs) => ({ v: meanVec(vs) }) }, { id: 'median', label: '중앙값', fn: (vs) => ({ v: medianVec(vs) }) }, { id: 'robust', label: '로버스트', fn: robustVec }];
  const methodOf = (id) => METHODS.find((m) => m.id === id);
  function fuse(method) {
    const on = LEGS.filter((L) => S.on[L.id]); if (!on.length) return { v: null, n: 0, on, keep: [] };
    const r = methodOf(method).fn(on.map(legVel));
    return { v: r.v, n: on.length, on, keep: r.keep || on.map(() => true) };
  }

  /* ── svg helpers ── */
  const cssv = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);
  const palette = () => ({ ink: cssv('--text-primary', '#16222E'), sub: cssv('--text-muted', '#6B7B88'), pap: cssv('--bg-card', '#fff'), dim: cssv('--border-hover', '#B8C6D0'), bv: '#3fb950', om: '#f0883e' });
  const ln = (a, b, s, w, d) => `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${s}" stroke-width="${w}"${d ? ` stroke-dasharray="${d}"` : ''} stroke-linecap="round"/>`;
  const tx = (x, y, s, f, str, an) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${s}" fill="${f}"${an ? ` text-anchor="${an}"` : ''} font-family="'JetBrains Mono',monospace">${str}</text>`;
  const dotc = (p, r, f, s, sw) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r}" fill="${f}"${s ? ` stroke="${s}" stroke-width="${sw || 2}"` : ''}/>`;
  const footpad = (p, r, f, s) => `<rect x="${(p[0] - r).toFixed(1)}" y="${(p[1] - r * 0.7).toFixed(1)}" width="${(2 * r).toFixed(1)}" height="${(1.4 * r).toFixed(1)}" rx="2" fill="${f}"${s ? ` stroke="${s}" stroke-width="1.6"` : ''}/>`;
  function arrow(a, b, color, w, op) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); if (L < 2) return '';
    const ux = dx / L, uy = dy / L, h = Math.min(9, L * 0.4), bx = b[0] - ux * h, by = b[1] - uy * h;
    return `<g opacity="${op == null ? 1 : op}">` + ln([a[0], a[1]], [bx, by], color, w) + `<path d="M${b[0].toFixed(1)},${b[1].toFixed(1)} L${(bx - uy * h * 0.4).toFixed(1)},${(by + ux * h * 0.4).toFixed(1)} L${(bx + uy * h * 0.4).toFixed(1)},${(by - ux * h * 0.4).toFixed(1)} Z" fill="${color}"/></g>`;
  }
  const mkProj = (az, el, scl, cx, cy) => (v) => { const sx = -v[0] * Math.sin(az) + v[1] * Math.cos(az), d = v[0] * Math.cos(az) + v[1] * Math.sin(az), sy = v[2] * Math.cos(el) - d * Math.sin(el); return [cx + sx * scl, cy - sy * scl]; };

  /* ── skeleton ── */
  root.innerHTML =
    '<div class="imu-bar" data-imu-bar></div>' +
    '<div class="imu-grid">' +
      '<div class="imu-panel"><div class="imu-plabel"><span>A</span> 다리별 ᴮvᵢ · 3D</div><svg class="ce-svg" data-imu-3d viewBox="0 0 560 360" preserveAspectRatio="xMidYMid meet"></svg></div>' +
      '<div class="imu-panel"><div class="imu-plabel"><span>B</span> 융합 결과 · top-down</div><svg class="ce-svg" data-imu-td viewBox="0 0 560 360" preserveAspectRatio="xMidYMid meet"></svg></div>' +
    '</div>' +
    '<div class="ce-eq" data-imu-info></div>';
  const bar = root.querySelector('[data-imu-bar]');
  const svg3d = root.querySelector('[data-imu-3d]');
  const svgtd = root.querySelector('[data-imu-td]');
  const info = root.querySelector('[data-imu-info]');
  const V3 = (v, c, d = 2) => `<span style="color:${c};font-variant-numeric:tabular-nums">[${v.map((x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d)).join(' ')}]</span>`;

  const slipCol = '#e5484d';

  /* ── left: 3D chain view ── */
  const VIEW = 0.34;
  function render3d() {
    const C = palette(), pr = mkProj(0.86, 0.34, 460, 250, 150);
    const p0 = pr([0, 0, 0]);
    let g = '';
    const [ha, hb, hc] = BODY.map((x) => x / 2);
    const bw = [[-ha, -hb, -hc], [ha, -hb, -hc], [ha, hb, -hc], [-ha, hb, -hc], [-ha, -hb, hc], [ha, -hb, hc], [ha, hb, hc], [-ha, hb, hc]];
    [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([i, k]) => { g += ln(pr(bw[i]), pr(bw[k]), C.dim, 1); });
    [[[0.1, 0, 0], 'x'], [[0, 0.1, 0], 'y'], [[0, 0, 0.1], 'z']].forEach(([v, l]) => { const e = pr(v); g += ln(p0, e, C.sub, 1) + tx(e[0] + 3, e[1], 8, C.sub, l); });
    // legs — neutral links (context) so the colored velocity arrows stand out; feet keep the leg colour
    LEGS.forEach((L) => {
      const on = S.on[L.id], legc = on ? C.ink : C.dim, w = on ? 2.2 : 1.2;
      const pts = [[0, 0, 0], L.P[0], L.P[1], L.P[2], L.s];
      for (let i = 0; i < 4; i++) g += ln(pr(pts[i]), pr(pts[i + 1]), legc, w);
      for (let i = 1; i <= 3; i++) g += dotc(pr(pts[i]), 2.6, C.pap, legc, 1.4);
      const sl = on && S.slip[L.id];
      g += footpad(pr(L.s), 5, on ? (sl ? slipCol : L.col) : C.pap, on ? (sl ? slipCol : L.col) : C.dim);
      const fl = pr(L.s); g += tx(fl[0] + 6, fl[1] + 13, 8.5, on ? (sl ? slipCol : L.col) : C.sub, L.id + (sl ? ' ⚠' : ''));
    });
    g += dotc(p0, 3.5, C.ink);
    // per-leg ᴮvᵢ arrows from each hip; a slipping foot's arrow is red
    LEGS.forEach((L) => { if (!S.on[L.id]) return; const h = pr(L.P[0]); g += arrow(h, pr(ad(L.P[0], sc(legVel(L), VIEW))), S.slip[L.id] ? slipCol : L.col, 2.2, S.slip[L.id] ? 1 : 0.85); });
    // fused body velocity (selected method) from the body origin
    const { v: fv } = fuse(S.method);
    if (fv) { const b = pr(sc(fv, VIEW)); g += arrow(p0, b, C.bv, 3.8) + tx(b[0] + 6, b[1] - 4, 12, C.bv, 'ᴮv̂'); }
    svg3d.innerHTML = g + tx(10, 15, 9, C.sub, '각 발 ᴮvᵢ(색,힙) → 융합 ᴮv̂(굵은 초록) · 빨강=미끄러짐');
  }

  /* ── right: top-down ── */
  function rendertd() {
    const C = palette(), cx = 280, cy = 172, SC = 360;
    const P = (s) => [cx - s[1] * SC, cy - s[0] * SC];
    const O = P([0, 0, 0]), svec = (v, k) => [O[0] - v[1] * k, O[1] - v[0] * k];
    let g = '';
    const bx = BODY[0] / 2, by = BODY[1] / 2;
    const cs = [[bx, by], [bx, -by], [-bx, -by], [-bx, by]].map((c) => P([c[0], c[1], 0]));
    g += `<polygon points="${cs.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="${C.pap}" stroke="${C.dim}" stroke-width="1.6"/>`;
    const fr = P([bx, 0, 0]); g += tx(fr[0], fr[1] - 6, 8, C.sub, 'front', 'middle');
    LEGS.forEach((L) => {
      const fp = P(L.s), on = S.on[L.id], sl = on && S.slip[L.id], col = on ? (sl ? slipCol : L.col) : C.dim;
      g += `<g data-foot="${L.id}" style="cursor:pointer">`;
      g += ln(P([L.s[0], L.s[1] * 0.5, 0]), fp, on ? C.ink : C.dim, on ? 2 : 1.2, on ? null : '3 3');
      g += dotc(fp, on ? 8 : 5.5, on ? col : C.pap, col, 2);
      const lx = L.s[1] > 0 ? fp[0] - 26 : fp[0] + 11, ly = L.s[0] > 0 ? fp[1] - 9 : fp[1] + 18;
      g += tx(lx, ly, 9.5, col, L.id + (sl ? ' ⚠' : '')) + `<circle cx="${fp[0].toFixed(1)}" cy="${fp[1].toFixed(1)}" r="17" fill="transparent"/></g>`;
      if (on) { g += arrow(O, svec(legVel(L), 150), sl ? slipCol : L.col, 1.8, sl ? 0.95 : 0.7); }
    });
    g += dotc(O, 3, C.ink);
    const { v: fv } = fuse(S.method);
    if (fv) { const b = svec(fv, 150); g += arrow(O, b, C.bv, 3.6) + tx(b[0] + 6, b[1], 11, C.bv, 'ᴮv̂'); }
    svgtd.innerHTML = g + tx(10, 15, 9, C.sub, '발을 눌러 미끄러짐(outlier) 토글');
  }

  function renderInfo() {
    const C = palette(), on = LEGS.filter((L) => S.on[L.id]);
    if (!on.length) { info.innerHTML = `<div class="ce-eq-body"><div class="ce-note">발을 하나 이상 켜세요.</div></div>`; return; }
    const vs = on.map(legVel);
    const rows = on.map((L) => `<div class="ce-pt"><b style="color:${S.slip[L.id] ? slipCol : L.col}">${L.id}${S.slip[L.id] ? ' ⚠' : ''}</b>  ᴮv=${V3(legVel(L), S.slip[L.id] ? slipCol : L.col)}</div>`).join('');
    const results = METHODS.map((m) => { const v = m.fn(vs).v; return { id: m.id, label: m.label, v, err: nrm(sb(v, TRUE_V)) }; });
    const resRows = results.map((r) => `<div class="ce-pt" style="${r.id === S.method ? 'font-weight:700' : 'opacity:.65'}">${r.id === S.method ? '▸ ' : '&nbsp;&nbsp;'}${r.label} = ${V3(r.v, r.id === S.method ? C.bv : C.sub)} · 오차 <b style="color:${r.err < 0.06 ? C.bv : slipCol}">${r.err.toFixed(3)}</b></div>`).join('');
    const anySlip = on.some((L) => S.slip[L.id]);
    info.innerHTML = `<div class="ce-eq-main" style="color:${C.ink}">자이로 ω=${V3(OM, C.om)} → 접촉 ${on.length}발이 각자 ᴮv를 냄</div>` +
      `<div class="ce-eq-body">${rows}<div class="ce-pt" style="margin-top:6px;color:${C.sub}">── 융합 방법별 결과 (참값 ${V3(TRUE_V, C.sub)}) ──</div>${resRows}` +
      `<div class="ce-note">${anySlip
        ? '한 발이 미끄러짐(빨강 outlier) → <b>산술 평균</b>은 그리로 끌려가지만, <b>중앙값/로버스트</b>는 그 발을 눌러/버려 견딘다. 위에서 방법을 바꿔 오차를 비교해 보라.'
        : '지금은 잡음만 있어 세 방법이 비슷. <b>발을 눌러 미끄러뜨리면(outlier)</b> 방법별 차이가 드러난다.'}</div></div>`;
  }

  function renderAll() { render3d(); rendertd(); renderInfo(); }
  // click a contacting foot (either panel) → toggle its slip (outlier)
  [svg3d, svgtd].forEach((s) => s.addEventListener('click', (e) => { const gEl = e.target.closest('[data-foot]'); if (gEl && S.on[gEl.dataset.foot]) { S.slip[gEl.dataset.foot] = !S.slip[gEl.dataset.foot]; renderAll(); } }));
  // method selector
  const mlabel = document.createElement('span'); mlabel.className = 'ce-controls-hint'; mlabel.textContent = '융합:'; bar.appendChild(mlabel);
  METHODS.forEach((m) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ce-cnt-btn' + (m.id === S.method ? ' is-active' : ''); b.textContent = m.label; b.dataset.m = m.id;
    b.addEventListener('click', () => { S.method = m.id; bar.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('is-active', x.dataset.m === m.id)); renderAll(); });
    bar.appendChild(b);
  });
  const clabel = document.createElement('span'); clabel.className = 'ce-controls-hint'; clabel.textContent = '· 접촉:'; bar.appendChild(clabel);
  [['1발', { FL: 1 }], ['2발', { FL: 1, RR: 1 }], ['3발', { FL: 1, FR: 1, RL: 1 }], ['4발', { FL: 1, FR: 1, RL: 1, RR: 1 }]].forEach(([label, set]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ce-cnt-btn'; b.textContent = label;
    b.addEventListener('click', () => { S.on = { FL: false, FR: false, RL: false, RR: false, ...set }; S.slip = {}; renderAll(); });
    bar.appendChild(b);
  });
  const hint = document.createElement('span'); hint.className = 'ce-controls-hint'; hint.textContent = '발 클릭 = 미끄러짐 토글';
  bar.appendChild(hint);

  new MutationObserver(() => renderAll()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderAll()); } catch (_) { } }
  renderAll();
})();
