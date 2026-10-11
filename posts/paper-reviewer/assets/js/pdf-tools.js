// PDF side of the paper reviewer: render pages, find each issue's quote in
// the text layer to get its rectangles, and write highlight annotations back
// into a downloadable PDF.
import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import { PDFDocument, PDFHexString, PDFString } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

export async function openPdf(bytes) {
  // pdf.js transfers the buffer to its worker, so hand it a copy.
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

// ── Text index ─────────────────────────────────────────────────────────────
// Matching runs on a "key" string that keeps only lowercase letters and
// digits (after NFKD, so ligatures like "ﬁ" become "fi"). That makes the
// model's quote match regardless of line-break hyphens, spacing, quote
// styles, or how pdf.js split the text into items. Each key character maps
// back to (item, char) so the match can be turned into rectangles.

const KEEP = /[\p{L}\p{N}]/u;

// Fine key for revision verdicts: keeps case, digits and punctuation (so a
// fixed hyphen, capital, or thousands separator counts as a change) and only
// drops whitespace. Typographic quotes/dashes are folded to ASCII.
const FOLD = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-', '\u2010': '-', '\u2011': '-' };
function fineChars(ch) {
  return Array.from((FOLD[ch] ?? ch).normalize('NFKC')).filter(c => !/\s/.test(c));
}
function toFine(s) { return Array.from(s).flatMap(fineChars).join(''); }

function toKey(s) {
  let out = '';
  for (const ch of s) {
    for (const c of ch.normalize('NFKD').toLowerCase()) if (KEEP.test(c) && !/\p{M}/u.test(c)) out += c;
  }
  return out;
}

async function indexPage(page) {
  const { items, styles } = await page.getTextContent();
  let key = '';
  const map = []; // key index -> [itemIdx, charIdx]
  items.forEach((it, i) => {
    if (!it.str) return;
    const chars = Array.from(it.str);
    chars.forEach((ch, j) => {
      for (const c of ch.normalize('NFKD').toLowerCase()) {
        if (KEEP.test(c) && !/\p{M}/u.test(c)) { key += c; map.push([i, j]); }
      }
    });
  });
  let fine = '';
  const fineMap = [];
  items.forEach((it, i) => {
    if (!it.str) return;
    Array.from(it.str).forEach((ch, j) => { for (const c of fineChars(ch)) { fine += c; fineMap.push([i, j]); } });
  });
  return { items, styles, key, map, fine, fineMap };
}

function findSpan(index, qkey, strict = false) {
  if (!qkey) return null;
  let at = index.key.indexOf(qkey);
  if (at >= 0) return [at, at + qkey.length];
  if (strict) return null;
  // Fall back to the longest prefix or suffix that still occurs (the model
  // sometimes drifts by a word at either end of the quote).
  const min = Math.max(10, Math.ceil(qkey.length * 0.5));
  for (let len = qkey.length - 1; len >= min; len--) {
    at = index.key.indexOf(qkey.slice(0, len));
    if (at >= 0) return [at, at + len];
    const tail = qkey.slice(qkey.length - len);
    at = index.key.indexOf(tail);
    if (at >= 0) return [at, at + len];
  }
  return null;
}

// Offsets inside a text item are measured with the item's font family on a
// canvas, which tracks proportional glyph widths far better than counting
// characters. Only the ratio is used, so the exact font does not matter much.
const measureCtx = document.createElement('canvas').getContext('2d');
function charOffset(chars, c, family) {
  if (c <= 0) return 0;
  if (c >= chars.length) return 1;
  measureCtx.font = `100px ${family || 'serif'}`;
  const full = measureCtx.measureText(chars.join('')).width;
  return full > 0 ? measureCtx.measureText(chars.slice(0, c).join('')).width / full : c / chars.length;
}

// Rectangles in PDF user space ([x0, y0, x1, y1], y up), one per line.
function spanRects(index, [a, b]) {
  const perItem = new Map();
  for (let k = a; k < b; k++) {
    const [i, j] = index.map[k];
    const r = perItem.get(i);
    if (r) { r[0] = Math.min(r[0], j); r[1] = Math.max(r[1], j + 1); } else perItem.set(i, [j, j + 1]);
  }
  const rects = [];
  for (const [i, [c0, c1]] of perItem) {
    const it = index.items[i];
    const [sa, sb, , , e, f] = it.transform;
    if (Math.abs(sb) > 1e-3) continue; // rotated text: skip
    const chars = Array.from(it.str);
    const family = index.styles[it.fontName]?.fontFamily;
    const h = it.height || Math.abs(sa);
    const w = it.width;
    rects.push([e + w * charOffset(chars, c0, family), f - h * 0.25, e + w * charOffset(chars, c1, family), f + h * 0.9]);
  }
  // Merge pieces that sit on the same baseline.
  rects.sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  const merged = [];
  for (const r of rects) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last[1] - r[1]) < (r[3] - r[1]) * 0.5 && r[0] - last[2] < (r[3] - r[1]) * 2) {
      last[0] = Math.min(last[0], r[0]); last[2] = Math.max(last[2], r[2]); last[3] = Math.max(last[3], r[3]);
    } else merged.push([...r]);
  }
  return merged;
}

// Adds `loc = { page, rects }` (or `loc = null`) to every issue. Tries the
// page the model gave, then its neighbours, then the whole document.
export async function buildIndex(doc) {
  const indices = [];
  for (let p = 1; p <= doc.numPages; p++) indices.push(await indexPage(await doc.getPage(p)));
  return indices;
}

// Finds a quote in an index built by buildIndex(); returns { page, rects } or null.
// `strict` requires the whole quote (no prefix/suffix fallback), for verdicts.
export function findQuote(indices, quote, page, strict = false) {
  if (strict) return findFine(indices, quote, page);
  const qkey = toKey(quote || '');
  if (qkey.length < 3) return null;
  const n = indices.length;
  const order = (page >= 1 && page <= n)
    ? [page, page + 1, page - 1, ...indices.map((_, i) => i + 1).filter(x => Math.abs(x - page) > 1)].filter(x => x >= 1 && x <= n)
    : indices.map((_, i) => i + 1);
  for (const p of order) {
    const span = findSpan(indices[p - 1], qkey, strict);
    if (span) {
      const rects = spanRects(indices[p - 1], span);
      if (rects.length) return { page: p, rects };
    }
  }
  return null;
}

function findFine(indices, quote, page) {
  const q = toFine(quote || '');
  if (q.length < 3) return null;
  const n = indices.length;
  const order = (page >= 1 && page <= n) ? [page, ...indices.map((_, i) => i + 1).filter(x => x !== page)] : indices.map((_, i) => i + 1);
  for (const p of order) {
    const ix = indices[p - 1];
    const at = ix.fine.indexOf(q);
    if (at < 0) continue;
    const rects = spanRects({ ...ix, map: ix.fineMap }, [at, at + q.length]);
    if (rects.length) return { page: p, rects };
  }
  return null;
}

export async function locateIssues(doc, issues) {
  const indices = await buildIndex(doc);
  const order = (p) => {
    const all = indices.map((_, i) => i + 1);
    if (!(p >= 1 && p <= doc.numPages)) return all;
    return [p, p + 1, p - 1, ...all.filter(x => Math.abs(x - p) > 1)].filter(x => x >= 1 && x <= doc.numPages);
  };
  for (const issue of issues) {
    issue.loc = null;
    const qkey = toKey(issue.quote || '');
    if (qkey.length < 3) continue;
    for (const p of order(issue.page)) {
      const span = findSpan(indices[p - 1], qkey);
      if (span) {
        const rects = spanRects(indices[p - 1], span);
        if (rects.length) { issue.loc = { page: p, rects }; break; }
      }
    }
  }
  return issues;
}

// ── Rendering ──────────────────────────────────────────────────────────────

// Renders every page into `container` as a canvas plus an overlay layer.
// Overlay boxes are positioned in percent of the page box, so they stay
// aligned however the canvas is scaled by CSS.
export async function renderPages(doc, container, { onPage } = {}) {
  container.replaceChildren();
  const pages = [];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = (1000 / base.width) * dpr;
    const vp = page.getViewport({ scale });
    const wrap = document.createElement('div');
    wrap.className = 'pr-page';
    wrap.dataset.page = p;
    wrap.style.aspectRatio = `${base.width} / ${base.height}`;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const layer = document.createElement('div');
    layer.className = 'pr-layer';
    const tag = document.createElement('span');
    tag.className = 'pr-page-no';
    tag.textContent = p;
    wrap.append(canvas, layer, tag);
    container.append(wrap);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    pages.push({ p, wrap, layer, base });
    onPage?.(p, doc.numPages);
  }
  return pages;
}

// Converts a user-space rect into percent offsets within the page box.
export function rectToPercent(base, r) {
  const [x0, y0, x1, y1] = base.convertToViewportRectangle(r);
  const left = Math.min(x0, x1), top = Math.min(y0, y1);
  return {
    left: (left / base.width) * 100,
    top: (top / base.height) * 100,
    width: (Math.abs(x1 - x0) / base.width) * 100,
    height: (Math.abs(y1 - y0) / base.height) * 100,
  };
}

// ── Export ─────────────────────────────────────────────────────────────────

const AUTHOR = 'Paper Reviewer (Claude)';

// `notes` is a list of { issue, color: [r,g,b] (0–1), subject, text } in the order to
// write them. Located issues become Highlight annotations with the note as
// their comment; unlocated ones with a known page become sticky notes in the
// top margin of that page.
export async function exportAnnotated(bytes, notes) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = pdf.context;
  const pages = pdf.getPages();
  const stickyCount = new Map();
  const now = PDFString.fromDate(new Date());

  for (const { issue, color, subject, text } of notes) {
    // Subj is the title Acrobat and Preview show for each entry in their comment list.
    const meta = { Contents: PDFHexString.fromText(text), Subj: PDFHexString.fromText(subject || ''), T: PDFHexString.fromText(AUTHOR), M: now };
    if (issue.loc) {
      const page = pages[issue.loc.page - 1];
      const rs = issue.loc.rects;
      const rect = [Math.min(...rs.map(r => r[0])), Math.min(...rs.map(r => r[1])), Math.max(...rs.map(r => r[2])), Math.max(...rs.map(r => r[3]))];
      const quad = rs.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]);
      // Explicit appearance stream so every viewer draws the highlight the
      // same way, even ones that do not synthesize one from QuadPoints.
      const ops = `/GS0 gs ${color.map(c => c.toFixed(3)).join(' ')} rg ` + rs.map(([x0, y0, x1, y1]) => `${x0.toFixed(2)} ${y0.toFixed(2)} ${(x1 - x0).toFixed(2)} ${(y1 - y0).toFixed(2)} re`).join(' ') + ' f';
      const ap = ctx.register(ctx.stream(ops, {
        Type: 'XObject', Subtype: 'Form', BBox: rect,
        Resources: { ExtGState: { GS0: { Type: 'ExtGState', ca: 0.38, BM: 'Multiply' } } },
      }));
      const annot = ctx.register(ctx.obj({
        Type: 'Annot', Subtype: 'Highlight', Rect: rect, QuadPoints: quad, C: color, F: 4, ...meta,
        AP: { N: ap },
      }));
      page.node.addAnnot(annot);
    } else if (issue.page >= 1 && issue.page <= pages.length) {
      const page = pages[issue.page - 1];
      const { width, height } = page.getSize();
      const k = stickyCount.get(issue.page) ?? 0;
      stickyCount.set(issue.page, k + 1);
      const x = width - 28 - (k % 6) * 22, y = height - 28 - Math.floor(k / 6) * 22;
      const annot = ctx.register(ctx.obj({
        Type: 'Annot', Subtype: 'Text', Rect: [x, y, x + 18, y + 18], Name: 'Comment', C: color, F: 4, ...meta,
      }));
      page.node.addAnnot(annot);
    }
  }
  return pdf.save();
}



// ── Revision diff ──────────────────────────────────────────────────────────
// Words with their page and user-space rectangle, in reading order as pdf.js
// reports it. `key` is the normalised form used for comparison.
export async function extractWords(doc) {
  const words = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items, styles } = await page.getTextContent();
    for (const it of items) {
      if (!it.str || Math.abs(it.transform[1]) > 1e-3) continue;
      const chars = Array.from(it.str);
      const family = styles[it.fontName]?.fontFamily;
      const [sa, , , , e, f] = it.transform;
      const h = it.height || Math.abs(sa);
      let i = 0;
      while (i < chars.length) {
        while (i < chars.length && /\s/.test(chars[i])) i++;
        const start = i;
        while (i < chars.length && !/\s/.test(chars[i])) i++;
        if (i === start) continue;
        const text = chars.slice(start, i).join('');
        const key = toKey(text);
        if (!key) continue;
        words.push({ page: p, text, key, rect: [e + it.width * charOffset(chars, start, family), f - h * 0.25, e + it.width * charOffset(chars, i, family), f + h * 0.9] });
      }
    }
  }
  return words;
}

// Word-level diff (Myers). Marks a[i].op = 'same'|'del' and b[j].op = 'same'|'add'.
// Falls back to a multiset comparison when the edit distance gets very large.
export function diffWords(a, b, maxD = 4000) {
  a.forEach(w => { w.op = 'del'; }); b.forEach(w => { w.op = 'add'; });
  let s = 0;
  while (s < a.length && s < b.length && a[s].key === b[s].key) { a[s].op = b[s].op = 'same'; s++; }
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1].key === b[eb - 1].key) { a[--ea].op = b[--eb].op = 'same'; }
  const A = a.slice(s, ea), B = b.slice(s, eb), N = A.length, M = B.length;
  if (!N || !M) return summarize(a, b);
  const max = N + M, off = max + 1, trace = [];
  let v = new Int32Array(2 * max + 3), found = false;
  outer: for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x].key === B[y].key) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = true; break outer; }
    }
  }
  if (!found) {
    const count = new Map();
    B.forEach(w => count.set(w.key, (count.get(w.key) || 0) + 1));
    A.forEach(w => { const c = count.get(w.key) || 0; if (c) { w.op = 'same'; count.set(w.key, c - 1); } });
    const back = new Map();
    A.forEach(w => { if (w.op === 'same') back.set(w.key, (back.get(w.key) || 0) + 1); });
    B.forEach(w => { const c = back.get(w.key) || 0; if (c) { w.op = 'same'; back.set(w.key, c - 1); } });
    return summarize(a, b);
  }
  // Walk back through the trace to mark the matched (snake) words.
  let x = N, y = M;
  for (let d = trace.length - 1; d > 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d], k = x - y;
    const prevK = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1;
    const px = vv[off + prevK], py = px - prevK;
    while (x > px && y > py) { A[--x].op = 'same'; B[--y].op = 'same'; }
    x = px; y = py;
  }
  while (x > 0 && y > 0) { A[--x].op = 'same'; B[--y].op = 'same'; }
  return summarize(a, b);
}

function summarize(a, b) {
  return { removed: a.filter(w => w.op === 'del').length, added: b.filter(w => w.op === 'add').length, total: b.length };
}

// Groups consecutive changed words on the same page/line into boxes.
export function changeBoxes(words, op) {
  const boxes = [];
  for (const w of words) {
    if (w.op !== op) continue;
    const last = boxes[boxes.length - 1];
    const [x0, y0, x1, y1] = w.rect;
    if (last && last.page === w.page && Math.abs(last.rect[1] - y0) < (y1 - y0) * 0.5 && x0 - last.rect[2] < (y1 - y0) * 1.2) {
      last.rect[2] = Math.max(last.rect[2], x1); last.rect[3] = Math.max(last.rect[3], y1); last.text += ' ' + w.text;
    } else boxes.push({ page: w.page, rect: [x0, y0, x1, y1], text: w.text });
  }
  return boxes;
}
