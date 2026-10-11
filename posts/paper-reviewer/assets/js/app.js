// Page controller for the paper reviewer: setup form, run orchestration,
// PDF highlights + issue list, review card, and exports.
import { Anthropic, makeClient, proofread, review, translateReview, manualProofreadPrompt, manualReviewPrompt, parseManual, bridgeTask, verifyRevision, bridgeVerifyTask, parseVerify, ReviewError, VENUES, ISSUE_TYPES, DECISIONS, SEVERITIES } from './claude.js';
import { openPdf, renderPages, locateIssues, rectToPercent, exportAnnotated, buildIndex, findQuote, extractWords, diffWords, changeBoxes } from './pdf-tools.js';
import { newRunId, saveRun, getRun, deleteRun, clearRuns, listRuns, historyAvailable } from './history.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

const root = document.querySelector('[data-reviewer-app]');
const $ = (sel) => root.querySelector(sel);

const SEV_RGB = { CRITICAL: [0.90, 0.28, 0.30], MAJOR: [0.96, 0.55, 0.15], MINOR: [0.98, 0.80, 0.15], STYLE: [0.36, 0.60, 0.98] };
const SEV_KO = { CRITICAL: '치명적', MAJOR: '중요', MINOR: '사소', STYLE: '스타일' };
const MAX_BYTES = 24 * 1024 * 1024;
const KEY_STORE = 'paper-reviewer:key';

// UI strings that JS writes. The page's own copy lives in
// _data/paper_reviewer.yml; review/issue content follows the EN/KO toggle.
const UI_LANG = root.dataset.uiLang === 'en' ? 'en' : 'ko';
const UI = {
  ko: {
    other: '기타 · 직접 입력',
    notPdf: 'PDF 파일만 올릴 수 있어요.',
    tooBig: (mb) => `파일이 너무 커요 (${mb} MB). 24 MB 이하로 줄여주세요.`,
    pages: (n) => `${n} 페이지`,
    badPdf: 'PDF를 열 수 없어요. 암호가 걸려 있거나 손상된 파일일 수 있어요.',
    sRender: 'PDF 페이지 렌더링', sProof: ['교정', 'Claude API'], sLocate: 'PDF 위치 찾기',
    sReview: (v, m) => [`${v} ${m} 리뷰`, 'Claude API'], sTrans: '리뷰 한국어 번역', sUsage: '토큰 사용량',
    reading: '논문 읽는 중…', found: (n) => `이슈 ${n}개 발견`, issues: (n) => `이슈 ${n}개`,
    located: (a, b) => `${a} / ${b} 위치 확인`, writing: '리뷰 작성 중…', chars: (n) => `${n.toLocaleString()}자 작성`,
    usage: (u) => `입력 ${u.input.toLocaleString()} · 캐시 쓰기 ${u.cacheWrite.toLocaleString()} · 캐시 읽기 ${u.cacheRead.toLocaleString()} · 출력 ${u.output.toLocaleString()}`,
    e401: 'API 키가 올바르지 않아요 (401).', e403: '이 키로는 이 모델을 쓸 수 없어요 (403).', e404: '모델을 찾을 수 없어요 (404).',
    e429: '요청 한도를 넘었어요 (429). 잠시 후 다시 시도하세요.', e400: '요청 오류 (400)', eNet: '네트워크 연결에 실패했어요.', eApi: 'API 오류',
    waitProof: '교정 결과를 기다리는 중…', waitReview: '리뷰를 기다리는 중…', noReview: '아직 리뷰가 없어요.',
    waitKo: '한국어 번역 중… 영어 리뷰는 EN에서 먼저 볼 수 있어요.', noKo: '한국어 리뷰가 없어요. EN에서 영어 리뷰를 보세요.',
    pdfFail: 'PDF를 만들지 못했어요',
    copied: '복사했어요', copyFail: '복사가 막혔어요. .md로 저장하세요.',
    'no-json': '붙여넣은 내용에서 JSON을 찾지 못했어요.', 'bad-json': 'JSON 형식이 깨져 있어요. 답변 전체를 다시 복사해보세요.',
    'wrong-shape': '이 작업의 결과 형식이 아니에요. 교정과 리뷰 칸이 바뀌지 않았는지 확인하세요.',
    loadedProof: (n, f) => `이슈 ${n}개 중 ${f}개 위치 표시`, loadedReview: (d) => `불러옴: ${d}`,
    chars2: (n) => `프롬프트 ${n.toLocaleString()}자`,
    bridgeOn: (v) => `연결됨 · ${v}`, bridgeOff: '연결 안 됨', bridgeTry: '연결 확인 중…',
    bridgeFail: '브리지에 연결하지 못했어요. 터미널에서 명령이 실행 중인지 확인하세요.', bridgeBadCode: '연결 코드 형식이 아니에요 (예: 43117-xxxx).',
    bridgeToken: '연결 코드가 맞지 않아요. 터미널에 출력된 링크나 코드를 다시 쓰세요.', bridgeBusy: '브리지가 다른 작업을 처리 중이에요. 잠시 후 다시 시도하세요.',
    bridgeLost: '작업 중에 브리지 연결이 끊겼어요.', bridgeNoData: 'Claude Code가 결과 JSON을 돌려주지 않았어요.',
    sBridgeProof: ['교정', '내 Claude Code'], sBridgeReview: (v, m) => [`${v} ${m} 리뷰 EN·KR`, '내 Claude Code'],
    bReading: (pg) => `PDF 읽는 중${pg ? ` (p.${pg})` : ''}`, bThinking: '생각하는 중', bWriting: '결과 작성 중', bStarting: 'Claude Code 시작 중',
    revStatus: { fixed: '고쳐짐', likely: '고쳐짐(추정)', changed: '바뀜', still: '그대로', unknown: '판단 불가', partially_fixed: '일부 고쳐짐', not_fixed: '안 고쳐짐', cannot_tell: '판단 불가' },
    revDiff: (a, r) => `추가 ${a.toLocaleString()} · 삭제 ${r.toLocaleString()} 단어`, revLocal: '빠른 비교', revClaude: 'Claude 검수',
    revRunClaude: 'Claude로 검수', revRerunClaude: '다시 검수', revClaudeBusy: 'Claude 검수 중', revManualOnly: 'Claude 검수는 API key 또는 내 Claude Code 모드에서 쓸 수 있어요.',
    revNew: (n) => `수정하며 새로 생긴 문제 ${n}개`, revNoNew: '새로 생긴 문제는 없어요.', revCompiling: '컴파일 중…', revCompiled: (e) => `${e}로 컴파일했어요.`,
    revCompileFail: '컴파일에 실패했어요. 아래 로그를 확인하세요.', revNeedBridge: '먼저 내 Claude Code 브리지에 연결해 주세요.', revOldBridge: '브리지가 예전 버전이에요. 새 명령으로 다시 실행해 주세요.',
    revNoTex: '브리지가 실행 중인 컴퓨터에 latexmk/pdflatex가 없어요.', revBadDir: '폴더는 절대 경로로 적어주세요 (예: /home/me/paper).', revNotFound: '폴더나 메인 파일을 찾을 수 없어요.', revBadMain: '메인 파일은 폴더 안의 .tex 파일이어야 해요.',
    srcMeta: (n, m, c) => `LaTeX 소스 · ${n} · ${m} · 파일 ${c}개`, zipBad: 'zip 파일을 읽을 수 없어요.', zipNoMain: 'zip 안에서 메인 .tex 파일(\\documentclass)을 찾지 못했어요.',
    zipNeedsPdf: 'LaTeX 소스를 받았어요. 컴파일된 PDF도 같이 올리거나, 내 Claude Code 브리지에 연결하면 자동으로 컴파일해요.', zipCompiling: 'LaTeX 소스를 컴파일하는 중…',
    zipCompiled: (e) => `소스에서 컴파일함 (${e})`, zipCompileFail: (e) => `소스 컴파일 실패${e ? ` (${e})` : ''}. PDF를 직접 올려주세요.`, bReadingSrc: (f) => `소스 읽는 중 (${f})`,
    zpRead: 'zip 읽는 중', zpSend: '브리지로 보내는 중', zpUnzip: (n) => `압축 해제 · 파일 ${n}개`, zpMain: (m) => `메인 파일: ${m}`,
    zpTex: (r, n, p) => `${r} ${n}회차${p ? ` · ${p}쪽` : ''}`, zpOpen: 'PDF 여는 중', zpDone: (n) => `PDF 준비 완료 · ${n}쪽`, zpCompare: '비교하는 중',
    revSummaryTitle: '검수 요약', revWas: '이전', rvAnother: '다른 리뷰어로', rvRun: '이 리뷰어로 받기', rvBusy: '리뷰 받는 중', rvStart: '리뷰 요청 중', rvDone: (l) => `${l} 리뷰 완료`, rvManual: '붙여넣기 모드에서는 쓸 수 없어요.', done: '고침', doneHint: '고쳤으면 체크하세요. PDF에서 표시가 사라지고, 수정본 검수 때 먼저 확인해요.', revMarked: '고침 체크', flowTitle: { ok: '전체 흐름 문제 없음', minor_problems: '전체 흐름: 사소한 문제', major_problems: '전체 흐름: 큰 문제' },
    histIssues: (n) => `이슈 ${n}개`, histOpen: '열려 있음', histDelete: '이 기록 삭제',
    resetConfirm: '저장된 기록과 지금 결과를 모두 지울까요? 되돌릴 수 없어요.',
    modeName: { bridge: '내 Claude Code', api: 'API', manual: '붙여넣기' }, modelDefault: '기본 모델',
    refusal: 'Claude가 이 요청을 거절했어요 (refusal).', 'max-tokens': '출력 한도에 걸려 답변이 잘렸어요. 더 짧은 PDF로 시도해보세요.',
  },
  en: {
    other: 'Other · type it',
    notPdf: 'Only PDF files are supported.',
    tooBig: (mb) => `That file is too large (${mb} MB). Keep it under 24 MB.`,
    pages: (n) => `${n} pages`,
    badPdf: "Couldn't open this PDF. It may be encrypted or damaged.",
    sRender: 'Rendering PDF pages', sProof: ['Proofreading', 'Claude API'], sLocate: 'Locating issues in the PDF',
    sReview: (v, m) => [`${v} ${m} review`, 'Claude API'], sTrans: 'Translating the review to Korean', sUsage: 'Token usage',
    reading: 'Reading the paper…', found: (n) => `${n} issues so far`, issues: (n) => `${n} issues`,
    located: (a, b) => `${a} / ${b} located`, writing: 'Writing the review…', chars: (n) => `${n.toLocaleString()} chars`,
    usage: (u) => `input ${u.input.toLocaleString()} · cache write ${u.cacheWrite.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · output ${u.output.toLocaleString()}`,
    e401: 'Invalid API key (401).', e403: "This key can't use this model (403).", e404: 'Model not found (404).',
    e429: 'Rate limited (429). Try again in a moment.', e400: 'Bad request (400)', eNet: 'Network connection failed.', eApi: 'API error',
    waitProof: 'Waiting for proofreading results…', waitReview: 'Waiting for the review…', noReview: 'No review yet.',
    waitKo: 'Translating to Korean… the English review is already under EN.', noKo: 'No Korean review. See the English one under EN.',
    pdfFail: "Couldn't build the PDF",
    copied: 'Copied', copyFail: 'Copy was blocked. Save it as .md instead.',
    'no-json': "Couldn't find JSON in what you pasted.", 'bad-json': 'The JSON is malformed. Try copying the whole answer again.',
    'wrong-shape': "This isn't the result for this task. Check you didn't swap the proofreading and review boxes.",
    loadedProof: (n, f) => `${f} of ${n} issues located`, loadedReview: (d) => `Loaded: ${d}`,
    chars2: (n) => `${n.toLocaleString()}-char prompt`,
    bridgeOn: (v) => `Connected · ${v}`, bridgeOff: 'Not connected', bridgeTry: 'Checking connection…',
    bridgeFail: "Couldn't reach the bridge. Make sure the command is still running in your terminal.", bridgeBadCode: "That doesn't look like a pairing code (e.g. 43117-xxxx).",
    bridgeToken: "The pairing code doesn't match. Use the link or code printed in the terminal.", bridgeBusy: 'The bridge is busy with other jobs. Try again shortly.',
    bridgeLost: 'Lost the connection to the bridge mid-run.', bridgeNoData: 'Claude Code returned no JSON result.',
    sBridgeProof: ['Proofreading', 'your Claude Code'], sBridgeReview: (v, m) => [`${v} ${m} review EN·KR`, 'your Claude Code'],
    bReading: (pg) => `Reading the PDF${pg ? ` (p.${pg})` : ''}`, bThinking: 'Thinking', bWriting: 'Writing the result', bStarting: 'Starting Claude Code',
    revStatus: { fixed: 'Fixed', likely: 'Likely fixed', changed: 'Changed', still: 'Unchanged', unknown: "Can't tell", partially_fixed: 'Partly fixed', not_fixed: 'Not fixed', cannot_tell: "Can't tell" },
    revDiff: (a, r) => `${a.toLocaleString()} words added · ${r.toLocaleString()} removed`, revLocal: 'Quick compare', revClaude: 'Claude check',
    revRunClaude: 'Check with Claude', revRerunClaude: 'Check again', revClaudeBusy: 'Claude is checking', revManualOnly: 'The Claude check works in API key or Claude Code mode.',
    revNew: (n) => `${n} new problems introduced by the edits`, revNoNew: 'No new problems introduced.', revCompiling: 'Compiling…', revCompiled: (e) => `Compiled with ${e}.`,
    revCompileFail: 'Compilation failed. See the log below.', revNeedBridge: 'Connect the Claude Code bridge first.', revOldBridge: 'Your bridge is an older version. Restart it with the new command.',
    revNoTex: 'latexmk/pdflatex is not installed on the bridge machine.', revBadDir: 'Use an absolute folder path (e.g. /home/me/paper).', revNotFound: "Couldn't find the folder or main file.", revBadMain: 'The main file must be a .tex file inside the folder.',
    srcMeta: (n, m, c) => `LaTeX source · ${n} · ${m} · ${c} files`, zipBad: "Couldn't read the zip file.", zipNoMain: 'No main .tex file (with \\documentclass) found in the zip.',
    zipNeedsPdf: 'Got the LaTeX source. Also upload the compiled PDF, or connect the Claude Code bridge to compile it automatically.', zipCompiling: 'Compiling the LaTeX source…',
    zipCompiled: (e) => `Compiled from source (${e})`, zipCompileFail: (e) => `Source compile failed${e ? ` (${e})` : ''}. Please upload the PDF.`, bReadingSrc: (f) => `Reading source (${f})`,
    zpRead: 'Reading the zip', zpSend: 'Sending to the bridge', zpUnzip: (n) => `Unpacking · ${n} files`, zpMain: (m) => `Main file: ${m}`,
    zpTex: (r, n, p) => `${r} pass ${n}${p ? ` · page ${p}` : ''}`, zpOpen: 'Opening the PDF', zpDone: (n) => `PDF ready · ${n} pages`, zpCompare: 'Comparing',
    revSummaryTitle: 'Summary', revWas: 'Was', rvAnother: 'Another reviewer', rvRun: 'Get this review', rvBusy: 'Reviewing', rvStart: 'Requesting the review', rvDone: (l) => `${l} review ready`, rvManual: 'Not available in Paste mode.', done: 'Fixed', doneHint: 'Tick when fixed. It disappears from the PDF and is checked first when you verify a revision.', revMarked: 'Marked fixed', flowTitle: { ok: 'Overall flow: no problems', minor_problems: 'Overall flow: minor problems', major_problems: 'Overall flow: major problems' },
    histIssues: (n) => `${n} issues`, histOpen: 'Open now', histDelete: 'Delete this run',
    resetConfirm: 'Delete all saved runs and the current result? This cannot be undone.',
    modeName: { bridge: 'Claude Code', api: 'API', manual: 'Paste' }, modelDefault: 'default model',
    refusal: 'Claude declined this request (refusal).', 'max-tokens': 'The answer hit the output limit and was cut off. Try a shorter PDF.',
  },
}[UI_LANG];

const state = {
  file: null,       // { name, bytes: Uint8Array }
  doc: null,        // pdf.js document
  pages: [],        // rendered pages
  mode: 'harsh',
  lang: UI_LANG,
  runMode: 'bridge',  // 'bridge' | 'api' | 'manual'
  proof: null,      // proofreading result (issues carry .loc)
  reviewEn: null,
  reviewKo: null,
  venue: '',
  filters: { sev: new Set(SEVERITIES), type: null }, // type: null = all
  selected: null,
  showTags: true,
  running: false,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
};

// ── Setup form ─────────────────────────────────────────────────────────────

// Venue chips, grouped. The last chip reveals a free-text field.
const VENUE_ROWS = [['Vision', ['cv']], ['ML · AI', ['ml', 'ai']], ['Robotics', ['robotics']], ['Journals', ['letter', 'journal']]];
const venueBox = $('[data-venue]');
const venueCustom = $('[data-venue-custom]');
let venuePick = 'CVPR';
venueBox.innerHTML = VENUE_ROWS.map(([label, groups]) => `
  <div class="pr-venue-group"><span>${label}</span><div>${VENUES.filter(v => groups.includes(v.group)).map(v =>
    `<button type="button" class="pr-venue${v.id === venuePick ? ' is-active' : ''}" data-v="${v.id}">${v.id}</button>`).join('')}</div></div>`).join('') +
  `<div class="pr-venue-group"><span>Other</span><div><button type="button" class="pr-venue" data-v="__custom">${UI.other}</button></div></div>`;
venueBox.addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  venuePick = b.dataset.v;
  venueBox.querySelectorAll('[data-v]').forEach(x => x.classList.toggle('is-active', x === b));
  venueCustom.hidden = venuePick !== '__custom';
  if (!venueCustom.hidden) venueCustom.focus();
  updateRun();
});
venueCustom.addEventListener('input', updateRun);

function segmented(el, onPick) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    el.querySelectorAll('button').forEach(x => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-checked', on); });
    onPick(b.dataset.value);
  });
}
segmented($('[data-mode]'), v => { state.mode = v; });
segmented($('[data-lang]'), v => { state.lang = v; renderAll(); });
root.querySelectorAll('[data-lang] button').forEach(b => { const on = b.dataset.value === UI_LANG; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', on); });
segmented($('[data-run-mode]'), v => {
  state.runMode = v;
  root.querySelectorAll('[data-pane]').forEach(el => { el.hidden = el.dataset.pane !== v; });
  const lbl = $('[data-run-label]');
  lbl.textContent = lbl.dataset[`label${v[0].toUpperCase()}${v.slice(1)}`];
  if (v === 'bridge' && !bridge.connected) pingBridge();
  updateRun();
});
function pickRunMode(v) { root.querySelector(`[data-run-mode] [data-value="${v}"]`).click(); }

const keyInput = $('[data-key]');
const remember = $('[data-remember]');
try {
  const saved = localStorage.getItem(KEY_STORE);
  if (saved) { keyInput.value = saved; remember.checked = true; } else keyInput.value = sessionStorage.getItem(KEY_STORE) || '';
} catch { /* storage blocked */ }
function persistKey() {
  try {
    if (remember.checked) { localStorage.setItem(KEY_STORE, keyInput.value); sessionStorage.removeItem(KEY_STORE); }
    else { localStorage.removeItem(KEY_STORE); sessionStorage.setItem(KEY_STORE, keyInput.value); }
  } catch { /* storage blocked */ }
}
keyInput.addEventListener('input', () => { persistKey(); updateRun(); });
remember.addEventListener('change', persistKey);
$('[data-do-proof]').addEventListener('change', updateRun);
$('[data-do-review]').addEventListener('change', updateRun);

const drop = $('[data-drop]');
const fileInput = $('[data-file]');
fileInput.addEventListener('change', () => takeFiles([...fileInput.files]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('is-over');
  takeFiles([...e.dataTransfer.files]);
});

// PDF and/or LaTeX source zip, in any order.
async function takeFiles(files) {
  const zip = files.find(f => /\.zip$/i.test(f.name) || /zip/.test(f.type));
  const pdf = files.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdf && !zip) { state.source = null; renderSourceMeta(); }
  if (pdf) await takeFile(pdf);
  if (zip) await takeZip(zip.name, new Uint8Array(await zip.arrayBuffer()));
  if (!pdf && !zip && files[0]) await takeFile(files[0]);
}

// ── LaTeX source zip ───────────────────────────────────────────────────────
// Read in the browser (for the API path, which sends the .tex text) and sent
// as-is to the bridge, which unpacks it for Claude Code and can compile it.
const MAX_SOURCE_CHARS = 600000;
async function readSourceZip(name, bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir && !p.startsWith('__MACOSX/') && !/(^|\/)\._/.test(p));
  const texPaths = paths.filter(p => /\.tex$/i.test(p));
  const texFiles = [];
  for (const p of texPaths) texFiles.push({ path: p, text: await zip.files[p].async('string') });
  const depth = (p) => p.split('/').length;
  const main = texFiles.filter(f => /(^|\/)main\.tex$/i.test(f.path)).sort((a, b) => depth(a.path) - depth(b.path))[0]?.path
    ?? texFiles.filter(f => /\\documentclass/.test(f.text)).sort((a, b) => depth(a.path) - depth(b.path))[0]?.path ?? null;
  return { name, bytes, main, texFiles, count: paths.length };
}
function sourceText(src) {
  if (!src?.texFiles.length) return '';
  const files = [...src.texFiles].sort((a, b) => (a.path === src.main ? -1 : b.path === src.main ? 1 : a.path.localeCompare(b.path)));
  let out = '';
  for (const f of files) {
    const chunk = `=== ${f.path} ===\n${f.text}\n\n`;
    if (out.length + chunk.length > MAX_SOURCE_CHARS) { out += `=== (remaining files omitted: too long) ===\n`; break; }
    out += chunk;
  }
  return out;
}

const srcMetaEl = $('[data-source-meta]');
function renderSourceMeta() {
  const src = state.source;
  srcMetaEl.hidden = !src;
  if (src) srcMetaEl.querySelector('span').textContent = UI.srcMeta(src.name, src.main, src.count);
}
srcMetaEl.querySelector('button').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); state.source = null; renderSourceMeta(); });

async function takeZip(name, bytes) {
  const metaEl = $('[data-file-meta]');
  if (!state.doc) progressBar($('[data-drop-progress]')).set(0.06, UI.zpRead);
  const bar = $('[data-drop-progress]')._bar;
  try { state.source = await readSourceZip(name, bytes); } catch { state.source = null; metaEl.textContent = UI.zipBad; bar?.active && bar.fail(UI.zipBad); renderSourceMeta(); return; }
  if (!state.source.main) { metaEl.textContent = UI.zipNoMain; state.source = null; bar?.active && bar.fail(UI.zipNoMain); renderSourceMeta(); return; }
  renderSourceMeta();
  if (!state.doc) await compileSource();
  else if (bar?.active) bar.done(UI.srcMeta(state.source.name, state.source.main, state.source.count));
}

// Small progress bar (dropzone / revision panel): eases toward the current
// stage's cap and shows the stage label with elapsed seconds.
// Reuses the bar already running on `el`, so one load is one continuous bar.
function progressBar(el) {
  if (el._bar?.active) return el._bar;
  const fill = el.querySelector('.pr-progress-fill'), text = el.querySelector('[data-p-text]'), pct = el.querySelector('[data-p-pct]');
  let p = 0, cap = 0, label = '', t0 = performance.now(), timer;
  el.hidden = false; el.classList.remove('is-done', 'is-fail');
  const paint = () => {
    p += (cap - p) * 0.12;
    fill.style.width = `${(p * 100).toFixed(1)}%`;
    pct.textContent = `${Math.floor(p * 100)}%`;
    text.textContent = `${label} · ${Math.round((performance.now() - t0) / 1000)}s`;
  };
  timer = setInterval(paint, 120);
  const bar = {
    active: true,
    set(c, l) { cap = Math.max(cap, c); if (l) label = l; paint(); },
    done(l) { bar.active = false; cap = p = 1; label = l; paint(); clearInterval(timer); el.classList.add('is-done'); setTimeout(() => { if (el.classList.contains('is-done')) el.hidden = true; }, 5000); },
    fail(l) { bar.active = false; clearInterval(timer); label = l; paint(); el.classList.add('is-fail'); },
  };
  el._bar = bar;
  return bar;
}

// Sends a source zip to the bridge and follows the streamed build progress.
// Resolves { ok, bytes?, engine, main, log, error }.
async function compileZipStream(src, bar) {
  bar.set(0.12, UI.zpSend);
  const res = await fetch(bridgeUrl('/compile-zip'), { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ zipBase64: toBase64(src.bytes), main: src.main, stream: true }) });
  if (!(res.headers.get('content-type') || '').includes('ndjson')) {
    const data = await res.json();
    return data.ok ? { ...data, bytes: Uint8Array.from(atob(data.pdfBase64), c => c.charCodeAt(0)) } : { ...data, ok: false };
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      if (ev.type === 'stage' && ev.stage === 'unzip') bar.set(0.2, UI.zpUnzip(ev.files));
      else if (ev.type === 'stage' && ev.stage === 'main') bar.set(0.25, UI.zpMain(ev.main));
      else if (ev.type === 'tex') {
        const base = ev.rule === 'pdflatex' ? 0.25 + Math.min(ev.run, 3) * 0.2 : 0.3 + Math.min(ev.run, 3) * 0.2;
        bar.set(Math.min(0.9, base - 0.15 + Math.min(ev.pages, 30) * 0.004), UI.zpTex(ev.rule, ev.run, ev.pages));
      } else if (ev.type === 'result') result = ev;
    }
  }
  if (!result) return { ok: false, error: 'lost' };
  return result.ok ? { ...result, bytes: Uint8Array.from(atob(result.pdfBase64), c => c.charCodeAt(0)) } : result;
}

// No PDF yet: let the bridge build one from the zip.
async function compileSource() {
  const metaEl = $('[data-file-meta]');
  if (!state.source || state.doc) return;
  if (!bridge.connected || (bridge.version || 1) < 3) { metaEl.textContent = UI.zipNeedsPdf; const b = $('[data-drop-progress]')._bar; if (b?.active) b.fail(UI.zipNeedsPdf); return; }
  metaEl.textContent = UI.zipCompiling;
  const bar = progressBar($('[data-drop-progress]'));
  bar.set(0.08, UI.zpRead);
  try {
    const data = await compileZipStream(state.source, bar);
    if (!data.ok) { bar.fail(UI.zipCompileFail(data.error || '')); metaEl.textContent = UI.zipCompileFail(data.error || ''); return; }
    bar.set(0.95, UI.zpOpen);
    state.file = { name: data.main.split('/').pop().replace(/\.tex$/i, '.pdf'), bytes: data.bytes };
    state.doc = await openPdf(data.bytes);
    drop.classList.add('has-file');
    $('[data-file-name]').textContent = state.file.name;
    metaEl.textContent = `${UI.zipCompiled(data.engine)} · ${UI.pages(state.doc.numPages)}`;
    bar.done(UI.zpDone(state.doc.numPages));
  } catch { bar.fail(UI.bridgeFail); metaEl.textContent = UI.bridgeFail; }
  updateRun();
}

// "PDF too large?" helper: one copyable line that installs Ghostscript and
// re-saves the PDF at /printer quality, filled in with the visitor's file name.
const GS_ARGS = '-sDEVICE=pdfwrite -dCompatibilityLevel=1.7 -dPDFSETTINGS=/printer -dPrinted=false -dNOPAUSE -dQUIET -dBATCH';
const shrink = { os: /Mac/i.test(navigator.userAgent) ? 'mac' : /Win/i.test(navigator.userAgent) ? 'win' : 'linux', file: 'paper.pdf' };
function shrinkCommand() {
  const q = (n) => `"${n.replace(/"/g, '')}"`;
  const out = shrink.file.replace(/\.pdf$/i, '') + '-small.pdf';
  const gs = `${GS_ARGS} -sOutputFile=${q(out)} ${q(shrink.file)}`;
  return {
    mac: `brew install ghostscript && gs ${gs}`,
    linux: `sudo apt-get install -y ghostscript && gs ${gs}`,
    win: `winget install -e --id ArtifexSoftware.GhostScript; & (Get-ChildItem "C:\\Program Files\\gs\\*\\bin\\gswin64c.exe" | Select-Object -Last 1).FullName ${gs}`,
  }[shrink.os];
}
function renderShrink() {
  $('[data-shrink-cmd]').textContent = shrinkCommand();
  root.querySelectorAll('[data-shrink-os] button').forEach(b => { const on = b.dataset.value === shrink.os; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', on); });
}
function setShrinkFile(name, open) {
  shrink.file = name;
  renderShrink();
  if (open) setShrinkOpen(true);
}
function setShrinkOpen(open) {
  $('[data-shrink]').hidden = !open;
  $('[data-shrink-toggle]').setAttribute('aria-expanded', open);
}
$('[data-shrink-toggle]').addEventListener('click', () => setShrinkOpen($('[data-shrink]').hidden));
$('[data-shrink-os]').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]');
  if (b) { shrink.os = b.dataset.value; renderShrink(); }
});
$('[data-shrink-copy]').addEventListener('click', async (e) => {
  const icon = e.currentTarget.querySelector('i');
  try { await navigator.clipboard.writeText(shrinkCommand()); icon.className = 'fas fa-check'; } catch { /* select manually */ }
  setTimeout(() => { icon.className = 'fas fa-copy'; }, 1500);
});
renderShrink();

async function takeFile(f) {
  const nameEl = $('[data-file-name]'), metaEl = $('[data-file-meta]');
  if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) { metaEl.textContent = UI.notPdf; return; }
  if (f.size > MAX_BYTES) { metaEl.textContent = UI.tooBig((f.size / 1048576).toFixed(1)); setShrinkFile(f.name, true); return; }
  setShrinkFile(f.name, false);
  state.file = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  drop.classList.add('has-file');
  nameEl.textContent = f.name;
  metaEl.textContent = `${(f.size / 1048576).toFixed(1)} MB`;
  try {
    state.doc = await openPdf(state.file.bytes);
    metaEl.textContent += ` · ${UI.pages(state.doc.numPages)}`;
  } catch {
    state.file = null; state.doc = null;
    metaEl.textContent = UI.badPdf;
  }
  updateRun();
}

function venueName() {
  return venuePick === '__custom' ? venueCustom.value.trim() : venuePick;
}

function updateRun() {
  const doSomething = $('[data-do-proof]').checked || $('[data-do-review]').checked;
  const notReady = (state.runMode === 'api' && !keyInput.value.trim()) || (state.runMode === 'bridge' && !bridge.connected);
  $('[data-run]').disabled = state.running || !state.doc || notReady || !doSomething || !venueName();
  // The review bar's button depends on the same running state.
  if (!state.reviewBusy) renderReviewBar();
}

// ── Status list ────────────────────────────────────────────────────────────

// Each step carries a progress value. Where the real fraction is known (pages
// rendered, pages Claude has read) it is set directly; otherwise the bar eases
// toward `cap` with time constant `tau` seconds. The easing is memoryless, so
// re-calling set() with new text never makes the bar jump back.
const statusEl = $('[data-status]');
const progressEl = $('[data-progress]');
const steps = new Map(); // id -> { li, st, floor, cap, tau, t }
const COUNTED = new Set(['render', 'proof', 'locate', 'review', 'trans']);

function stepValue(sp, now = performance.now()) {
  if (sp.st === 'done') return 1;
  if (sp.st !== 'run' || sp.cap <= sp.floor) return sp.floor;
  return sp.floor + (sp.cap - sp.floor) * (1 - Math.exp(-(now - sp.t) / 1000 / sp.tau));
}

function paintProgress() {
  const now = performance.now();
  let sum = 0, n = 0;
  for (const [id, sp] of steps) {
    const v = stepValue(sp, now);
    sp.li.querySelector('.pr-step-bar i').style.width = `${(v * 100).toFixed(1)}%`;
    if (COUNTED.has(id)) { sum += v; n++; }
  }
  const total = n ? sum / n : 0;
  progressEl.querySelector('.pr-progress-fill').style.width = `${(total * 100).toFixed(1)}%`;
  progressEl.querySelector('[data-progress-pct]').textContent = `${Math.floor(total * 100)}%`;
  progressEl.classList.toggle('is-done', total >= 1);
}
let progressTimer = 0;
function startProgress() {
  steps.clear();
  progressEl.hidden = false;
  clearInterval(progressTimer);
  progressTimer = setInterval(paintProgress, 200);
  paintProgress();
}
function stopProgress() { clearInterval(progressTimer); paintProgress(); }

function step(id, label) {
  let li = statusEl.querySelector(`[data-step="${id}"]`);
  if (!li) {
    li = document.createElement('li');
    li.dataset.step = id;
    li.innerHTML = '<i></i><span class="pr-step-label"></span><span class="pr-step-detail"></span><span class="pr-step-bar"><i></i></span>';
    statusEl.append(li);
  }
  // label: 'text' or ['text', 'where it runs'] (second part on its own line)
  const [main, sub] = Array.isArray(label) ? label : [label];
  li.querySelector('.pr-step-label').innerHTML = esc(main) + (sub ? `<small>${esc(sub)}</small>` : '');
  const sp = { li, st: 'wait', floor: 0, cap: 0, tau: 30, t: performance.now() };
  steps.set(id, sp);
  // opts: { p: minimum progress now, cap: where easing heads, tau: seconds }
  const set = (st, detail = '', opts = {}) => {
    const now = performance.now();
    const cur = stepValue(sp, now);
    if (st === 'run') {
      sp.floor = Math.max(cur, opts.p ?? 0);
      sp.cap = Math.max(sp.floor, opts.cap ?? Math.max(sp.cap, 0.9));
      sp.tau = opts.tau ?? sp.tau;
    } else sp.floor = st === 'done' ? 1 : cur;
    sp.st = st; sp.t = now;
    li.className = `is-${st}`;
    li.querySelector('i').className = { wait: 'far fa-circle', run: 'fas fa-circle-notch fa-spin', done: 'fas fa-circle-check', fail: 'fas fa-circle-exclamation' }[st];
    li.querySelector('.pr-step-detail').textContent = detail;
    paintProgress();
  };
  set('wait');
  return set;
}

function explain(err) {
  if (err instanceof ReviewError) return UI[err.message] ?? err.message;
  if (err instanceof Anthropic.AuthenticationError) return UI.e401;
  if (err instanceof Anthropic.PermissionDeniedError) return UI.e403;
  if (err instanceof Anthropic.NotFoundError) return UI.e404;
  if (err instanceof Anthropic.RateLimitError) return UI.e429;
  if (err instanceof Anthropic.BadRequestError) return `${UI.e400}: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return UI.eNet;
  if (err instanceof Anthropic.APIError) return `${UI.eApi}${err.status ? ` (${err.status})` : ''}: ${err.message}`;
  return err?.message || String(err);
}

function addUsage(u) {
  if (!u) return;
  state.usage.input += u.input_tokens || 0;
  state.usage.cacheRead += u.cache_read_input_tokens || 0;
  state.usage.cacheWrite += u.cache_creation_input_tokens || 0;
  state.usage.output += u.output_tokens || 0;
}

// ── Run ────────────────────────────────────────────────────────────────────

$('[data-run]').addEventListener('click', () => ({ api: run, bridge: runBridge, manual: startManual })[state.runMode]());

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Clears previous results and starts rendering the PDF; returns the
// rendering promise.
function resetResults({ doProof, venue, mode }) {
  Object.assign(state, { proof: null, reviewEn: null, reviewKo: null, venue: `${venue} · ${mode}`, selected: null });
  const model = state.runMode === 'api' ? $('[data-model]').value : state.runMode === 'bridge' ? $('[data-bridge-model]').value : '';
  state.run = { id: newRunId(), createdAt: Date.now(), runMode: state.runMode, model };
  clearRevision(); state.revisions = []; state.reviews = []; state.reviewId = null; state.reviewError = ''; state.reviewVenue = null; state.reviewForm = null;
  state.usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  state.filters = { sev: new Set(SEVERITIES), type: null };
  statusEl.replaceChildren(); statusEl.hidden = false;
  startProgress();
  $('[data-results]').hidden = false;
  setTab(doProof ? 'proof' : 'review');
  renderAll();
  const sRender = step('render', UI.sRender);
  sRender('run', '', { cap: 0 });
  return renderPages(state.doc, $('[data-viewer]'), { onPage: (p, n) => sRender('run', `${p} / ${n}`, { p: p / n, cap: p / n }) })
    .then(pages => { state.pages = pages; sRender('done', UI.pages(pages.length)); drawHighlights(); })
    .catch(err => sRender('fail', explain(err)));
}

async function run() {
  const doProof = $('[data-do-proof]').checked, doReview = $('[data-do-review]').checked;
  const model = $('[data-model]').value;
  const venue = venueName();
  const mode = state.mode;
  const client = makeClient(keyInput.value.trim());
  const pdfBase64 = toBase64(state.file.bytes);

  state.running = true; updateRun();
  $('[data-manual]').hidden = true;
  const rendering = resetResults({ doProof, venue, mode });
  const sProof = doProof ? step('proof', UI.sProof) : null;
  const sLocate = doProof ? step('locate', UI.sLocate) : null;
  const sReview = doReview ? step('review', UI.sReview(venue, mode)) : null;
  const sTrans = doReview ? step('trans', UI.sTrans) : null;

  // The review waits for the proofreading stream to start so it can read the
  // PDF from the prompt cache instead of paying for it twice.
  let releaseReview;
  const cacheReady = new Promise(r => { releaseReview = r; });
  if (!doProof) releaseReview();

  const proofJob = doProof && (async () => {
    sProof('run', UI.reading, { cap: 0.3, tau: 25 });
    try {
      const { data, usage } = await proofread(client, {
        model, pdfBase64, source: state.source ? { main: state.source.main, text: sourceText(state.source) } : null,
        onEvent: () => releaseReview(),
        onText: (t) => sProof('run', UI.found((t.match(/"severity"/g) || []).length), { p: 0.3, cap: 0.92, tau: 90 }),
      });
      addUsage(usage);
      sProof('done', UI.issues(data.issues.length));
      sLocate('run', '', { cap: 0.9, tau: 1 });
      await locateIssues(state.doc, data.issues);
      const found = data.issues.filter(i => i.loc).length;
      sLocate('done', UI.located(found, data.issues.length));
      state.proof = data;
      await rendering;
      renderAll();
    } catch (err) {
      sProof('fail', explain(err));
      sLocate?.('fail', '');
    } finally { releaseReview(); }
  })();

  const reviewJob = doReview && (async () => {
    await cacheReady;
    sReview('run', UI.writing, { cap: 0.3, tau: 25 });
    try {
      const { data, usage } = await review(client, { model, pdfBase64, venue, mode, onText: (t) => sReview('run', UI.chars(t.length), { p: 0.3, cap: 0.92, tau: 60 }) });
      addUsage(usage);
      const ver = addReview(state.venue, data, null);
      sReview('done', DECISIONS[data.decision]?.en ?? data.decision);
      renderAll();
      sTrans('run', '', { cap: 0.92, tau: 20 });
      const ko = await translateReview(client, { model, reviewEn: data });
      addUsage(ko.usage);
      ver.ko = ko.data; if (state.reviewId === ver.id) state.reviewKo = ko.data;
      sTrans('done');
      renderAll();
    } catch (err) {
      if (!state.reviewEn) { sReview('fail', explain(err)); sTrans('fail', ''); } else sTrans('fail', explain(err));
    }
  })();

  await Promise.all([rendering, proofJob, reviewJob]);
  const u = state.usage;
  step('usage', UI.sUsage)('done', UI.usage(u));
  stopProgress();
  state.running = false; updateRun();
}

// ── Local Claude Code bridge ───────────────────────────────────────────────
// bridge.mjs runs on the visitor's machine and drives their own signed-in
// Claude Code. The page pairs with it through a token in the URL fragment
// (#bridge=TOKEN&port=PORT, opened by the script) or a pasted code.

const BRIDGE_STORE = 'paper-reviewer:bridge';
const MODEL_STORE = 'paper-reviewer:bridge-model';
try { $('[data-bridge-model]').value = localStorage.getItem(MODEL_STORE) || ''; } catch { /* storage blocked */ }
$('[data-bridge-model]').addEventListener('change', (e) => { try { localStorage.setItem(MODEL_STORE, e.target.value); } catch { /* storage blocked */ } });
const bridge = { port: 0, token: '', connected: false };
const bridgeUrl = (path) => `http://127.0.0.1:${bridge.port}${path}`;

$('[data-bridge-cmd]').textContent =
  `curl -fsSL ${location.origin}/posts/paper-reviewer/bridge.mjs | PR_PAGE="${location.origin}${location.pathname}" node --input-type=module`;
$('[data-bridge-copy]').addEventListener('click', async (e) => {
  const icon = e.currentTarget.querySelector('i');
  try { await navigator.clipboard.writeText($('[data-bridge-cmd]').textContent); icon.className = 'fas fa-check'; } catch { /* select manually */ }
  setTimeout(() => { icon.className = 'fas fa-copy'; }, 1500);
});

function setBridgeStatus(kind, text) {
  $('[data-bridge-status]').className = `pr-bridge-status is-${kind}`;
  $('[data-bridge-text]').textContent = text;
  root.querySelector('.pr-bridge-pair').hidden = kind === 'on';
}

async function pingBridge() {
  if (!bridge.port || !bridge.token) { setBridgeStatus('off', UI.bridgeOff); return false; }
  setBridgeStatus('wait', UI.bridgeTry);
  try {
    const r = await fetch(bridgeUrl('/health'), { headers: { authorization: `Bearer ${bridge.token}` } });
    if (r.status === 401) throw new Error(UI.bridgeToken);
    if (!r.ok) throw new Error(UI.bridgeFail);
    const h = await r.json();
    bridge.connected = true; bridge.version = h.version || 1; bridge.tex = h.tex || null;
    if (state.source && !state.doc) setTimeout(compileSource, 0);
    setBridgeStatus('on', UI.bridgeOn(h.claude));
  } catch (err) {
    bridge.connected = false;
    setBridgeStatus('err', err.message && err.message !== 'Failed to fetch' ? err.message : UI.bridgeFail);
  }
  updateRun();
  return bridge.connected;
}

function pairBridge(port, token) {
  Object.assign(bridge, { port: Number(port), token, connected: false });
  try { sessionStorage.setItem(BRIDGE_STORE, JSON.stringify({ port: bridge.port, token })); } catch { /* storage blocked */ }
  return pingBridge();
}

$('[data-bridge-connect]').addEventListener('click', () => {
  const m = $('[data-bridge-code]').value.trim().match(/^(\d{2,5})-([A-Za-z0-9_-]{16,})$/);
  if (!m) { setBridgeStatus('err', UI.bridgeBadCode); return; }
  pairBridge(m[1], m[2]);
});

// Pairing link from the terminal: take the token, then drop it from the URL.
{
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('bridge') && h.get('port')) {
    history.replaceState(null, '', location.pathname + location.search);
    pickRunMode('bridge');
    pairBridge(h.get('port'), h.get('bridge'));
  } else {
    try {
      const saved = JSON.parse(sessionStorage.getItem(BRIDGE_STORE) || 'null');
      if (saved) { Object.assign(bridge, saved); pingBridge(); }
    } catch { /* storage blocked */ }
  }
}

// Runs one task on the bridge, reporting progress, and resolves with the
// validated result object.
// `custom` = { prompt, schema, bytes, parse } runs another task on another PDF.
async function callBridge(kind, opts, set, custom) {
  const { prompt, schema } = custom ?? await bridgeTask(kind, opts);
  const bytes = custom?.bytes ?? state.file.bytes;
  const zip = custom ? custom.zip : (kind === 'proof' && state.source ? state.source.bytes : null);
  const t0 = Date.now();
  let note = UI.bStarting;
  // Reading: 5–40% by the furthest page Claude has opened. Thinking eases to
  // ~88%, writing the JSON to ~97%.
  let phase = { p: 0, cap: 0.05, tau: 4 };
  const clock = () => { const s = Math.round((Date.now() - t0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const tick = () => set('run', `${note} · ${clock()}`, phase);
  const pagesRead = (spec) => {
    const nums = String(spec ?? '').match(/\d+/g);
    return nums ? Math.max(...nums.map(Number)) : state.doc.numPages;
  };
  tick();
  const timer = setInterval(tick, 1000);
  try {
    let r;
    try {
      r = await fetch(bridgeUrl('/run'), {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, schema, pdfBase64: toBase64(bytes), label: kind, model: $('[data-bridge-model]').value || undefined, zipBase64: zip ? toBase64(zip) : undefined }),
      });
    } catch { throw new ReviewError(UI.bridgeFail); }
    if (r.status === 401) throw new ReviewError(UI.bridgeToken);
    if (r.status === 429) throw new ReviewError(UI.bridgeBusy);
    if (!r.ok) throw new ReviewError(`${UI.bridgeFail} (${r.status})`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '', result = null;
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { throw new ReviewError(UI.bridgeLost); }
      if (chunk.done) break;
      buf += chunk.value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        if (ev.type === 'progress') {
          if (ev.kind === 'read') {
            const f = ev.file ? Math.min(0.9, phase.p / 0.4 + 0.05) : Math.min(1, pagesRead(ev.pages) / state.doc.numPages);
            note = ev.file ? UI.bReadingSrc(ev.file) : UI.bReading(ev.pages); phase = { p: Math.max(phase.p, 0.05 + 0.35 * f), cap: 0.05 + 0.35 * f + 0.02, tau: 10 };
          } else if (ev.kind === 'writing') { note = UI.bWriting; phase = { p: 0.9, cap: 0.97, tau: 20 }; }
          else { note = UI.bThinking; phase = { p: 0.4, cap: 0.88, tau: 90 }; }
          tick();
        }
        else if (ev.type === 'result') result = ev;
        else if (ev.type === 'error') throw new ReviewError(ev.message);
      }
    }
    if (!result) throw new ReviewError(UI.bridgeLost);
    if (!result.ok) throw new ReviewError(result.text || result.subtype);
    const raw = result.data ? JSON.stringify(result.data) : (result.text.match(/\{[\s\S]*\}/) || [''])[0];
    if (!raw) throw new ReviewError(UI.bridgeNoData);
    return custom?.parse ? custom.parse(JSON.parse(raw)) : parseManual(raw, kind);
  } finally { clearInterval(timer); }
}

async function runBridge() {
  if (!(await pingBridge())) return;
  const doProof = $('[data-do-proof]').checked, doReview = $('[data-do-review]').checked;
  const venue = venueName(), mode = state.mode;
  state.running = true; updateRun();
  $('[data-manual]').hidden = true;
  const rendering = resetResults({ doProof, venue, mode });
  const sProof = doProof ? step('proof', UI.sBridgeProof) : null;
  const sLocate = doProof ? step('locate', UI.sLocate) : null;
  const sReview = doReview ? step('review', UI.sBridgeReview(venue, mode)) : null;

  const proofJob = doProof && (async () => {
    try {
      const data = await callBridge('proof', state.source ? { srcMain: state.source.main } : null, sProof);
      sProof('done', UI.issues(data.issues.length));
      sLocate('run', '', { cap: 0.9, tau: 1 });
      await locateIssues(state.doc, data.issues);
      sLocate('done', UI.located(data.issues.filter(i => i.loc).length, data.issues.length));
      state.proof = data;
      await rendering;
      renderAll();
    } catch (err) { sProof('fail', explain(err)); sLocate('fail', ''); }
  })();

  const reviewJob = doReview && (async () => {
    try {
      const data = await callBridge('review', { venue, mode }, sReview);
      addReview(state.venue, data.en, data.ko);
      sReview('done', DECISIONS[data.en.decision]?.[UI_LANG] ?? data.en.decision);
      renderAll();
    } catch (err) { sReview('fail', explain(err)); }
  })();

  await Promise.all([rendering, proofJob, reviewJob]);
  stopProgress();
  state.running = false; updateRun();
}

// ── No-API mode ────────────────────────────────────────────────────────────
// Builds the prompts for claude.ai / Claude Code and reads the pasted answers.

const manualEl = $('[data-manual]');
const prompts = {};

async function startManual() {
  const doProof = $('[data-do-proof]').checked, doReview = $('[data-do-review]').checked;
  const venue = venueName(), mode = state.mode;
  manualEl.querySelector('[data-manual-task="proof"]').hidden = !doProof;
  manualEl.querySelector('[data-manual-task="review"]').hidden = !doReview;
  manualEl.querySelectorAll('[data-manual-msg]').forEach(el => { el.textContent = ''; el.className = 'pr-manual-msg'; });
  manualEl.querySelectorAll('[data-paste]').forEach(el => { el.value = ''; });
  if (doProof) prompts.proof = await manualProofreadPrompt();
  if (doReview) prompts.review = manualReviewPrompt({ venue, mode });
  for (const kind of ['proof', 'review']) {
    if (prompts[kind]) manualEl.querySelector(`[data-manual-task="${kind}"] [data-manual-meta]`).textContent = UI.chars2(prompts[kind].length);
  }
  manualEl.hidden = false;
  resetResults({ doProof, venue, mode }).then(stopProgress);
  manualEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function manualMsg(task, text, ok) {
  const el = task.querySelector('[data-manual-msg]');
  el.textContent = text;
  el.className = `pr-manual-msg ${ok ? 'is-ok' : 'is-err'}`;
}

manualEl.addEventListener('click', async (e) => {
  const task = e.target.closest('[data-manual-task]');
  if (!task) return;
  const kind = task.dataset.manualTask;
  if (e.target.closest('[data-copy]')) {
    const label = e.target.closest('[data-copy]').querySelector('span');
    const orig = label.dataset.orig ??= label.textContent;
    try { await navigator.clipboard.writeText(prompts[kind]); label.textContent = UI.copied; }
    catch { manualMsg(task, UI.copyFail, false); }
    setTimeout(() => { label.textContent = orig; }, 1600);
  } else if (e.target.closest('[data-save-prompt]')) {
    download(`paper-reviewer-${kind}-prompt.md`, prompts[kind], 'text/markdown');
  } else if (e.target.closest('[data-load]')) {
    await loadManual(task, kind, task.querySelector('[data-paste]').value);
  }
});
manualEl.addEventListener('change', async (e) => {
  if (!e.target.matches('[data-paste-file]') || !e.target.files[0]) return;
  const task = e.target.closest('[data-manual-task]');
  const text = await e.target.files[0].text();
  task.querySelector('[data-paste]').value = text;
  e.target.value = '';
  await loadManual(task, task.dataset.manualTask, text);
});

async function loadManual(task, kind, text) {
  try {
    const data = parseManual(text, kind);
    if (kind === 'proof') {
      await locateIssues(state.doc, data.issues);
      state.proof = data;
      manualMsg(task, UI.loadedProof(data.issues.length, data.issues.filter(i => i.loc).length), true);
      setTab('proof');
    } else {
      addReview(state.venue, data.en, data.ko);
      manualMsg(task, UI.loadedReview(DECISIONS[data.en.decision]?.[UI_LANG] ?? data.en.decision), true);
      setTab('review');
    }
    renderAll();
    $('[data-results]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    manualMsg(task, explain(err), false);
  }
}

// ── History ────────────────────────────────────────────────────────────────
// Every run is saved in this browser (IndexedDB) as results arrive, and the
// latest one reopens on the next visit. Only "Reset" clears it.

const historyEl = $('[data-history]');
const historyList = $('[data-history-list]');
let persistTimer = 0;

function persistRun() {
  if (state.restoring || !state.run || !state.file || (!state.proof && !state.reviewEn) || !historyAvailable()) return;
  if (state.rev?.entry) { state.rev.entry.claude = state.rev.claude; state.rev.entry.summary = revisionSummary(state.rev); }
  state.lastPersist = Date.now();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const r = state.run;
    try {
      await saveRun({
        ...r, updatedAt: Date.now(), fileName: state.file.name, pdf: state.file.bytes, venue: state.venue,
        proof: state.proof, reviewEn: state.reviewEn, reviewKo: state.reviewKo, reviews: state.reviews || [], reviewId: state.reviewId || null,
        source: state.source ? { name: state.source.name, zip: state.source.bytes } : null,
        revisions: (state.revisions || []).map(v => ({ id: v.id, createdAt: v.createdAt, name: v.name, pdf: v.bytes, claude: v.claude,
          source: v.source ? { name: v.source.name, zip: v.source.bytes } : null, summary: v.summary || null })),
        issueCount: state.proof?.issues.length ?? null, decision: state.reviewEn?.decision ?? null,
      });
      renderHistory();
    } catch { /* storage full or blocked: results still work, just not saved */ }
  }, 300);
}

async function renderHistory() {
  if (!historyAvailable()) return;
  let runs = [];
  try { runs = await listRuns(); } catch { return; }
  historyEl.hidden = runs.length === 0;
  const fmt = new Intl.DateTimeFormat(UI_LANG === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  historyList.innerHTML = runs.map(r => {
    const d = r.decision ? DECISIONS[r.decision] : null;
    const model = r.model ? r.model.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1') : UI.modelDefault;
    return `<li class="pr-hist${state.run?.id === r.id ? ' is-current' : ''}" data-run="${r.id}">
      <button type="button" class="pr-hist-open">
        <span class="pr-hist-file"><i class="fas fa-file-pdf"></i> ${esc(r.fileName)}</span>
        <span class="pr-hist-meta">${esc(fmt.format(r.updatedAt))} · ${esc(r.venue)} · ${esc(UI.modeName[r.runMode] ?? r.runMode)}${r.runMode === 'manual' ? '' : ` · ${esc(model)}`}</span>
        <span class="pr-hist-tags">${r.issueCount != null ? `<em>${UI.histIssues(r.issueCount)}</em>` : ''}${d ? `<em class="pr-tone-${d.tone}">${esc(d[UI_LANG])}</em>` : ''}${state.run?.id === r.id ? `<em class="is-now">${UI.histOpen}</em>` : ''}</span>
      </button>
      <button type="button" class="pr-hist-del" data-run-del="${r.id}" aria-label="${UI.histDelete}" title="${UI.histDelete}"><i class="fas fa-xmark"></i></button>
      ${(r.revisions || []).length ? `<ul class="pr-hist-revs">${[...r.revisions].reverse().map(v => {
        const sm = v.summary;
        const tags = sm ? Object.entries(sm.counts).filter(([k]) => ['fixed', 'likely', 'partially_fixed', 'not_fixed', 'still'].includes(k))
          .map(([k, n]) => `<em class="st-${k}">${UI.revStatus[k]} ${n}</em>`).join('') : '';
        const now = state.rev?.entry?.id === v.id;
        return `<li><button type="button" class="pr-hist-rev${now ? ' is-current' : ''}" data-run-rev="${r.id}" data-rev-id="${v.id}">
          <span class="pr-hist-rev-name"><i class="fas fa-code-compare"></i> ${esc(v.name)}</span>
          <span class="pr-hist-meta">${esc(fmt.format(v.createdAt || r.updatedAt))}${sm ? ` · +${sm.added}/−${sm.removed}` : ''}${sm?.claude ? ` · ${UI.revClaude}` : ''}</span>
          ${tags ? `<span class="pr-hist-tags">${tags}</span>` : ''}
        </button></li>`;
      }).join('')}</ul>` : ''}
    </li>`;
  }).join('');
}

async function openRun(id, { scroll = true, revId = null } = {}) {
  const r = await getRun(id);
  if (!r) return;
  state.file = { name: r.fileName, bytes: r.pdf };
  state.doc = await openPdf(r.pdf);
  state.source = r.source ? await readSourceZip(r.source.name, r.source.zip).catch(() => null) : null;
  renderSourceMeta();
  drop.classList.add('has-file');
  $('[data-file-name]').textContent = r.fileName;
  $('[data-file-meta]').textContent = `${(r.pdf.byteLength / 1048576).toFixed(1)} MB · ${UI.pages(state.doc.numPages)}`;
  Object.assign(state, { run: { id: r.id, createdAt: r.createdAt, runMode: r.runMode, model: r.model }, venue: r.venue,
    proof: r.proof, reviewEn: r.reviewEn, reviewKo: r.reviewKo, selected: null, filters: { sev: new Set(SEVERITIES), type: null },
    reviews: r.reviews || (r.reviewEn ? [{ id: newRunId(), venue: r.venue, en: r.reviewEn, ko: r.reviewKo, createdAt: r.createdAt }] : []), reviewId: null });
  if (state.reviews.length) selectReview(r.reviewId && state.reviews.some(v => v.id === r.reviewId) ? r.reviewId : state.reviews[state.reviews.length - 1].id);
  statusEl.hidden = true; progressEl.hidden = true; $('[data-manual]').hidden = true;
  $('[data-results]').hidden = false;
  setTab(r.proof ? 'proof' : 'review');
  state.pages = await renderPages(state.doc, $('[data-viewer]'));
  // Reopening only shows a saved run; it must not re-save it (that would bump its time).
  state.restoring = true; renderAll(); state.restoring = false;
  clearRevision();
  const saved = r.revisions || (r.revision ? [{ id: newRunId(), createdAt: r.updatedAt, ...r.revision }] : []);
  state.revisions = [];
  for (const v of saved) {
    state.revisions.push({ id: v.id, createdAt: v.createdAt, name: v.name, bytes: v.pdf, claude: v.claude, summary: v.summary,
      source: v.source ? await readSourceZip(v.source.name, v.source.zip).catch(() => null) : null });
  }
  const pick = state.revisions.find(v => v.id === revId) ?? state.revisions[state.revisions.length - 1];
  if (pick) await loadRevision(pick.name, pick.bytes, { save: false, entry: pick });
  if (revId && pick) setTab('revise');
  renderHistory(); updateRun();
  if (scroll) $('[data-results]').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

historyList.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-run-del]');
  if (del) {
    await deleteRun(del.dataset.runDel);
    if (state.run?.id === del.dataset.runDel) state.run = null;
    renderHistory();
    return;
  }
  const rev = e.target.closest('[data-run-rev]');
  if (rev && !state.running) return openRun(rev.dataset.runRev, { revId: rev.dataset.revId });
  const li = e.target.closest('[data-run]');
  if (li && !state.running) openRun(li.dataset.run);
});

$('[data-history-reset]').addEventListener('click', async () => {
  if (state.running || !confirm(UI.resetConfirm)) return;
  await clearRuns();
  Object.assign(state, { run: null, file: null, doc: null, pages: [], proof: null, reviewEn: null, reviewKo: null, selected: null, source: null, revisions: [] });
  renderSourceMeta();
  $('[data-viewer]').replaceChildren();
  $('[data-results]').hidden = true; statusEl.hidden = true; progressEl.hidden = true; $('[data-manual]').hidden = true;
  drop.classList.remove('has-file');
  $('[data-file-name]').textContent = drop.dataset.emptyName;
  $('[data-file-meta]').textContent = drop.dataset.emptyMeta;
  fileInput.value = '';
  clearRevision();
  renderAll(); renderHistory(); updateRun();
});

// Reopen the latest run on load.
if (historyAvailable() && !new URLSearchParams(location.search).has('mock')) {
  listRuns().then(runs => runs[0] && openRun(runs[0].id, { scroll: false })).catch(() => {});
  renderHistory();
}

// ── Revision check ─────────────────────────────────────────────────────────
// Compare a revised PDF (uploaded, or compiled from LaTeX by the bridge) with
// the proofread one: word diff on both, a quick per-issue verdict from text
// search, and an optional Claude check that also finds newly introduced issues.

const revEl = {
  need: $('[data-rev-need]'), summary: $('[data-rev-summary]'), grid: $('[data-rev-grid]'), list: $('[data-rev-list]'),
  oldView: $('[data-rev-old]'), newView: $('[data-rev-new]'), name: $('[data-rev-name]'), msg: $('[data-rev-msg]'), log: $('[data-rev-log]'),
  dir: $('[data-rev-dir]'), main: $('[data-rev-main]'),
};
try { revEl.dir.value = localStorage.getItem('paper-reviewer:texdir') || ''; revEl.main.value = localStorage.getItem('paper-reviewer:texmain') || 'main.tex'; } catch { /* storage blocked */ }

function clearRevision() {
  state.rev = null;
  revEl.summary.hidden = true; revEl.grid.hidden = true;
  revEl.list.innerHTML = ''; revEl.oldView.replaceChildren(); revEl.newView.replaceChildren();
  revEl.msg.textContent = ''; revEl.log.hidden = true;
  renderRevisionNeed();
}
function renderRevisionNeed() { revEl.need.hidden = !!state.proof; $('[data-rev-source]').hidden = !state.proof; }

function revMessage(text, ok) { revEl.msg.textContent = text; revEl.msg.className = `pr-rev-msg ${ok === undefined ? '' : ok ? 'is-ok' : 'is-err'}`; }

// Quick verdict for one previous issue, from where its quote and suggestion
// can (or cannot) be found in the revision.
function localVerdict(issue, idx) {
  if (!issue.quote) return { status: 'unknown', loc: null };
  const q = findQuote(idx, issue.quote, issue.page, true);
  const sugText = issue.suggestion && issue.suggestion.length < 220 ? issue.suggestion : '';
  const sg = sugText ? findQuote(idx, sugText, issue.page, true) : null;
  // A structural issue can't be judged from its heading text still being there.
  if (q) return { status: issue.type === 'structure' ? 'unknown' : 'still', loc: q };
  if (sg) return { status: 'likely', loc: sg };
  return { status: 'changed', loc: null };
}

const MAX_REVISIONS = 5;
// Each loaded revision is an entry in state.revisions (kept with the run in
// History); state.rev is the one on screen.
async function loadRevision(name, bytes, { save = true, source = null, entry = null } = {}) {
  if (!entry) {
    entry = { id: newRunId(), createdAt: Date.now(), name, bytes, source, claude: null, summary: null };
    state.revisions = [...(state.revisions || []), entry].slice(-MAX_REVISIONS);
  }
  const claude = entry.claude;
  source = entry.source;
  if (!state.proof || !state.doc) return;
  const doc = await openPdf(bytes);
  const [oldWords, newWords] = await Promise.all([extractWords(state.doc), extractWords(doc)]);
  const stats = diffWords(oldWords, newWords);
  const idx = await buildIndex(doc);
  const verdicts = new Map(state.proof.issues.map(i => [i.id, localVerdict(i, idx)]));
  state.rev = { entry, name, bytes, doc, idx, stats, verdicts, claude, source, oldBoxes: changeBoxes(oldWords, 'del'), newBoxes: changeBoxes(newWords, 'add'), ...inlineChanges(oldWords, newWords) };
  if (claude) await locateIssues(doc, claude.new_issues);
  revEl.grid.hidden = false; revEl.summary.hidden = false; revEl.name.textContent = name;
  const [oldPages, newPages] = [await renderPages(state.doc, revEl.oldView), await renderPages(doc, revEl.newView)];
  state.rev.oldPages = oldPages; state.rev.newPages = newPages;
  drawRevision(); renderRevision();
  if (save) persistRun();
  renderHistory();
}

// Short summary stored with each revision for the History list.
function revisionSummary(r) {
  const counts = {};
  for (const i of state.proof.issues) {
    const c = r.claude?.verdicts.find(v => v.id === i.id);
    const k = c ? c.status : r.verdicts.get(i.id)?.status;
    counts[k] = (counts[k] || 0) + 1;
  }
  return { added: r.stats.added, removed: r.stats.removed, counts, claude: !!r.claude, flow: r.claude?.flow_check?.verdict ?? null };
}

// Walks both word lists in step (matched words appear in the same order on
// both sides) to place each run of deleted words at the spot in the revision
// where it was removed, and to remember what an added run replaced.
function inlineChanges(oldWords, newWords) {
  const dels = [], replaced = new Map();
  let i = 0, j = 0, run = [];
  const flush = () => {
    if (!run.length) return;
    const anchor = newWords[j] ?? newWords[j - 1];
    const text = run.map(w => w.text).join(' ');
    if (anchor) {
      if (anchor.op === 'add') replaced.set(anchor, text);
      else dels.push({ page: anchor.page, rect: anchor.rect, before: !!newWords[j], text });
    }
    run = [];
  };
  while (i < oldWords.length || j < newWords.length) {
    if (i < oldWords.length && oldWords[i].op === 'del') { run.push(oldWords[i++]); continue; }
    if (j < newWords.length && newWords[j].op === 'add') { flush(); j++; continue; }
    flush(); i++; j++;
  }
  flush();
  // Hover text for added boxes: what each replaced.
  const addBoxes = [];
  for (const w of newWords) {
    if (w.op !== 'add') continue;
    const last = addBoxes[addBoxes.length - 1];
    const [x0, y0, x1, y1] = w.rect;
    if (last && last.page === w.page && Math.abs(last.rect[1] - y0) < (y1 - y0) * 0.5 && x0 - last.rect[2] < (y1 - y0) * 1.2) {
      last.rect[2] = Math.max(last.rect[2], x1); last.rect[3] = Math.max(last.rect[3], y1);
      if (replaced.has(w)) last.was = [last.was, replaced.get(w)].filter(Boolean).join(' ');
    } else addBoxes.push({ page: w.page, rect: [x0, y0, x1, y1], was: replaced.get(w) || '' });
  }
  return { delMarks: dels, addBoxes };
}

function drawRevision() {
  const r = state.rev;
  const paint = (pages, boxes, cls) => {
    for (const pg of pages) pg.layer.replaceChildren();
    for (const b of boxes) {
      const pg = pages[b.page - 1]; if (!pg) continue;
      const box = rectToPercent(pg.base, b.rect);
      const el = document.createElement('span');
      el.className = `pr-diff ${cls}`;
      Object.assign(el.style, { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` });
      if (b.was) el.title = `${UI.revWas}: ${b.was}`;
      pg.layer.append(el);
    }
  };
  paint(r.oldPages, r.oldBoxes, 'is-del');
  paint(r.newPages, r.addBoxes, 'is-add');
  // Deleted runs as thin red markers with a struck-through note, in the revision.
  for (const d of r.delMarks) {
    const pg = r.newPages[d.page - 1]; if (!pg) continue;
    const box = rectToPercent(pg.base, d.rect);
    const mark = document.createElement('span');
    mark.className = 'pr-del-mark';
    mark.title = `− ${d.text}`;
    Object.assign(mark.style, { left: `${d.before ? box.left : box.left + box.width}%`, top: `${box.top}%`, height: `${box.height}%` });
    const note = document.createElement('span');
    note.textContent = d.text.length > 28 ? d.text.slice(0, 27) + '…' : d.text;
    mark.append(note);
    pg.layer.append(mark);
  }
  // Claude's new issues on top of the revision.
  for (const i of r.claude?.new_issues || []) {
    if (!i.loc) continue;
    const pg = r.newPages[i.loc.page - 1]; if (!pg) continue;
    i.loc.rects.forEach((rect, k) => {
      const box = rectToPercent(pg.base, rect);
      const hl = document.createElement('span');
      hl.className = `pr-hl sev-${i.severity}`;
      hl.dataset.newIssue = i.id;
      Object.assign(hl.style, { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` });
      if (k === 0) { const tag = document.createElement('span'); tag.className = 'pr-hl-tag'; tag.textContent = `N${i.id} ${typeLabel(i.type)}`; hl.append(tag); }
      pg.layer.append(hl);
    });
  }
}

function renderRevision() {
  const r = state.rev; if (!r) return;
  const ko = state.lang === 'ko';
  const st = (s) => UI.revStatus[s] ?? s;
  const counts = {};
  for (const i of state.proof.issues) {
    const c = r.claude?.verdicts.find(v => v.id === i.id);
    const key = c ? c.status : r.verdicts.get(i.id)?.status;
    counts[key] = (counts[key] || 0) + 1;
  }
  const busy = !!r.claudeBusy;
  const canClaude = state.runMode !== 'manual';
  const order = ['fixed', 'likely', 'partially_fixed', 'changed', 'still', 'not_fixed', 'unknown', 'cannot_tell'];
  revEl.summary.innerHTML = `
    <div class="pr-rev-stats">
      <span class="pr-rev-chip"><i class="fas fa-code-compare"></i> ${UI.revDiff(r.stats.added, r.stats.removed)}</span>
      ${order.filter(k => counts[k]).map(k => `<span class="pr-rev-chip st-${k}">${st(k)} <b>${counts[k]}</b></span>`).join('')}
      <span class="pr-rev-src">${r.claude ? UI.revClaude : UI.revLocal}</span>
    </div>
    <div class="pr-rev-actions">
      <button type="button" class="pr-btn pr-btn--solid" data-rev-claude ${busy || !canClaude ? 'disabled' : ''}><i class="fas ${busy ? 'fa-circle-notch fa-spin' : 'fa-wand-magic-sparkles'}"></i> ${busy ? `${UI.revClaudeBusy}${r.claudeNote ? ` · ${esc(r.claudeNote)}` : ''}` : r.claude ? UI.revRerunClaude : UI.revRunClaude}</button>
      ${canClaude ? '' : `<span class="pr-rev-hint">${UI.revManualOnly}</span>`}
      ${r.claudeError ? `<span class="pr-rev-hint is-err">${esc(r.claudeError)}</span>` : ''}
    </div>
    ${r.claude ? `<p class="pr-rev-claude-sum"><b>${UI.revSummaryTitle}</b> ${esc(ko ? r.claude.summary_ko : r.claude.summary_en)}</p>` : ''}
    ${r.claude?.flow_check ? `<div class="pr-flow flow-${r.claude.flow_check.verdict}"><b>${UI.flowTitle[r.claude.flow_check.verdict] ?? r.claude.flow_check.verdict}</b>${(ko ? r.claude.flow_check.notes_ko : r.claude.flow_check.notes_en).length ? `<ul>${(ko ? r.claude.flow_check.notes_ko : r.claude.flow_check.notes_en).map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>` : ''}`;
  const items = [...state.proof.issues].sort((a, b) => (b.done ? 1 : 0) - (a.done ? 1 : 0) || a.id - b.id).map(i => {
    const lv = r.verdicts.get(i.id);
    const cv = r.claude?.verdicts.find(v => v.id === i.id);
    return `<li class="pr-rev-item sev-${i.severity}" data-rev-issue="${i.id}">
      <div class="pr-issue-head"><span class="pr-issue-no">${i.id}</span><span class="pr-issue-type">${esc(typeLabel(i.type))}</span>
        ${i.done ? `<span class="pr-rev-badge is-marked"><i class="fas fa-check"></i> ${UI.revMarked}</span>` : ''}
        <span class="pr-rev-badge st-${lv.status}" title="${UI.revLocal}">${st(lv.status)}</span>
        ${cv ? `<span class="pr-rev-badge st-${cv.status} is-claude" title="${UI.revClaude}"><i class="fas fa-wand-magic-sparkles"></i> ${st(cv.status)}</span>` : ''}</div>
      <p class="pr-issue-desc">${esc(desc(i))}</p>
      ${i.quote ? `<p class="pr-issue-quote">“${esc(i.quote)}”</p>` : ''}
      ${cv ? `<p class="pr-rev-note">${esc(ko ? cv.note_ko : cv.note_en)}</p>` : ''}
    </li>`;
  });
  const fresh = r.claude ? (r.claude.new_issues.length ? `<li class="pr-rev-sep">${UI.revNew(r.claude.new_issues.length)}</li>` + r.claude.new_issues.map(i => `
    <li class="pr-rev-item sev-${i.severity} is-new" data-rev-newissue="${i.id}">
      <div class="pr-issue-head"><span class="pr-issue-no">N${i.id}</span><span class="pr-issue-type">${esc(typeLabel(i.type))}</span><span class="pr-issue-sev">${sevLabel(i.severity)}</span>
        <span class="pr-issue-page">${i.loc ? `p.${i.loc.page}` : ''}</span></div>
      <p class="pr-issue-desc">${esc(desc(i))}</p>
      ${i.quote ? `<p class="pr-issue-quote">“${esc(i.quote)}”</p>` : ''}
      ${i.suggestion ? `<p class="pr-issue-fix"><i class="fas fa-arrow-right"></i> ${esc(i.suggestion)}</p>` : ''}
    </li>`).join('') : `<li class="pr-rev-sep">${UI.revNoNew}</li>`) : '';
  revEl.list.innerHTML = items.join('') + fresh;
}

function scrollRevTo(loc) {
  if (!loc || !state.rev) return;
  const pg = state.rev.newPages[loc.page - 1]; if (!pg) return;
  const box = rectToPercent(pg.base, loc.rects[0]);
  const view = revEl.newView;
  view.scrollTo({ top: pg.wrap.offsetTop - view.offsetTop + pg.wrap.offsetHeight * box.top / 100 - view.clientHeight / 3, behavior: 'smooth' });
}

segmented($('[data-rev-view]'), v => { revEl.grid.classList.toggle('is-inline', v === 'inline'); });

revEl.list.addEventListener('click', (e) => {
  const old = e.target.closest('[data-rev-issue]');
  if (old) return scrollRevTo(state.rev?.verdicts.get(+old.dataset.revIssue)?.loc);
  const n = e.target.closest('[data-rev-newissue]');
  if (n) scrollRevTo(state.rev?.claude?.new_issues.find(i => i.id === +n.dataset.revNewissue)?.loc);
});

$('[data-rev-file]').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > MAX_BYTES) return revMessage(UI.tooBig((f.size / 1048576).toFixed(1)), false);
  revMessage('');
  try { await loadRevision(f.name, new Uint8Array(await f.arrayBuffer())); } catch { revMessage(UI.badPdf, false); }
});

$('[data-rev-zip]').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  revEl.log.hidden = true;
  let src;
  try { src = await readSourceZip(f.name, new Uint8Array(await f.arrayBuffer())); } catch { return revMessage(UI.zipBad, false); }
  if (!src.main) return revMessage(UI.zipNoMain, false);
  if (!bridge.connected && !(await pingBridge())) return revMessage(UI.revNeedBridge, false);
  if ((bridge.version || 1) < 3) return revMessage(UI.revOldBridge, false);
  revMessage('');
  const bar = progressBar($('[data-rev-progress]'));
  let data;
  try { data = await compileZipStream(src, bar); } catch { bar.fail(UI.bridgeFail); return revMessage(UI.bridgeFail, false); }
  if (!data.ok) {
    bar.fail(data.log ? UI.revCompileFail : UI.zipCompileFail(data.error || ''));
    if (data.log) { revEl.log.textContent = data.log; revEl.log.hidden = false; }
    return;
  }
  bar.set(0.95, UI.zpCompare);
  await loadRevision(`${f.name} → ${data.main.split('/').pop().replace(/\.tex$/i, '.pdf')}`, data.bytes, { source: src });
  bar.done(UI.revCompiled(data.engine));
});

$('[data-rev-compile]').addEventListener('click', async () => {
  const dir = revEl.dir.value.trim(), main = revEl.main.value.trim() || 'main.tex';
  try { localStorage.setItem('paper-reviewer:texdir', dir); localStorage.setItem('paper-reviewer:texmain', main); } catch { /* storage blocked */ }
  revEl.log.hidden = true;
  if (!bridge.connected && !(await pingBridge())) return revMessage(UI.revNeedBridge, false);
  if ((bridge.version || 1) < 2) return revMessage(UI.revOldBridge, false);
  revMessage(UI.revCompiling);
  let res, data;
  try {
    res = await fetch(bridgeUrl('/compile'), { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ dir, main }) });
    data = await res.json();
  } catch { return revMessage(UI.bridgeFail, false); }
  const errs = { 'no-tex': UI.revNoTex, 'dir-not-absolute': UI.revBadDir, 'not-found': UI.revNotFound, 'bad-main': UI.revBadMain };
  if (!res.ok) return revMessage(errs[data.error] || `${UI.eApi}: ${data.error}`, false);
  if (!data.ok) { revMessage(UI.revCompileFail, false); revEl.log.textContent = data.log; revEl.log.hidden = false; return; }
  const bytes = Uint8Array.from(atob(data.pdfBase64), c => c.charCodeAt(0));
  revMessage(UI.revCompiled(data.engine), true);
  await loadRevision(main.replace(/\.tex$/i, '.pdf'), bytes);
});

revEl.summary.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-rev-claude]')) return;
  const r = state.rev; if (!r || r.claudeBusy) return;
  r.claudeBusy = true; r.claudeError = ''; r.claudeNote = ''; renderRevision();
  try {
    let data;
    if (state.runMode === 'api') {
      const client = makeClient(keyInput.value.trim());
      ({ data } = await verifyRevision(client, { model: $('[data-model]').value, pdfBase64: toBase64(r.bytes), issues: state.proof.issues, source: r.source ? { main: r.source.main, text: sourceText(r.source) } : null }));
      data = parseVerify(data);
    } else {
      if (!bridge.connected && !(await pingBridge())) throw new ReviewError(UI.revNeedBridge);
      const set = (st, detail) => { r.claudeNote = detail; renderRevision(); };
      data = await callBridge('verify', null, set, { ...bridgeVerifyTask(state.proof.issues, r.source?.main), bytes: r.bytes, zip: r.source?.bytes ?? null, parse: parseVerify });
    }
    await locateIssues(r.doc, data.new_issues);
    r.claude = data;
    drawRevision();
    persistRun();
  } catch (err) {
    r.claudeError = explain(err);
  } finally {
    r.claudeBusy = false; r.claudeNote = ''; renderRevision();
  }
});

// ── Tabs ───────────────────────────────────────────────────────────────────

function setTab(name) {
  root.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on); });
  root.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== name; });
  if (name === 'proof') stackTags();
}
root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ── Rendering results ──────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const typeLabel = (t) => ISSUE_TYPES[t]?.[state.lang] ?? t;
const sevLabel = (s) => state.lang === 'ko' ? SEV_KO[s] : s;
const desc = (i) => state.lang === 'ko' ? i.description_ko : i.description_en;

function renderAll() {
  persistRun();
  renderRevisionNeed();
  if (state.rev) renderRevision();
  renderProofSummary();
  renderFilters();
  renderIssues();
  drawHighlights();
  renderReview();
  $('[data-export-pdf]').disabled = !state.proof;
  $('[data-export-md]').disabled = !state.reviewEn && !state.proof;
}

function visible(issue) {
  return state.filters.sev.has(issue.severity) && (!state.filters.type || state.filters.type === issue.type);
}

function renderProofSummary() {
  const el = $('[data-proof-summary]');
  if (!state.proof) { el.innerHTML = state.running ? `<p class="pr-muted">${UI.waitProof}</p>` : ''; return; }
  const { issues } = state.proof;
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, issues.filter(i => i.severity === s).length]));
  const located = issues.filter(i => i.loc).length;
  const common = state.lang === 'ko' ? state.proof.most_common_problems_ko : state.proof.most_common_problems_en;
  const quality = { GOOD: ['좋음', 'good'], 'NEEDS REVISION': ['수정 필요', 'mid'], 'MAJOR REVISION': ['대폭 수정 필요', 'bad'] }[state.proof.paper_quality] ?? [state.proof.paper_quality, 'mid'];
  el.innerHTML = `
    <div class="pr-quality pr-tone-${quality[1]}"><span>${state.lang === 'ko' ? '원고 상태' : 'Paper quality'}</span><strong${state.lang === 'ko' ? ' lang="ko" class="pr-ko-display"' : ''}>${esc(state.lang === 'ko' ? quality[0] : state.proof.paper_quality)}</strong></div>
    <div class="pr-counts">${SEVERITIES.map(s => `<div class="pr-count sev-${s}"><strong>${counts[s]}</strong><span>${sevLabel(s)}</span></div>`).join('')}
      <div class="pr-count"><strong>${located}/${issues.length}</strong><span>${state.lang === 'ko' ? '위치 표시' : 'located'}</span></div>
      <div class="pr-count is-done-count"><strong>${issues.filter(i => i.done).length}/${issues.length}</strong><span>${UI.done}</span></div></div>
    ${common?.length ? `<ul class="pr-common">${common.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}`;
}

function renderFilters() {
  const el = $('[data-filters]');
  if (!state.proof) { el.innerHTML = ''; return; }
  const types = [...new Set(state.proof.issues.map(i => i.type))];
  el.innerHTML = `
    <label class="pr-tag-toggle"><input type="checkbox" data-f-tags${state.showTags ? ' checked' : ''}> ${state.lang === 'ko' ? 'PDF에 라벨 표시' : 'Show labels on the PDF'}</label>
    <div class="pr-chips">${SEVERITIES.map(s => `<button type="button" class="pr-chip sev-${s}${state.filters.sev.has(s) ? ' is-on' : ''}" data-f-sev="${s}">${sevLabel(s)}</button>`).join('')}</div>
    <div class="pr-chips"><button type="button" class="pr-chip${!state.filters.type ? ' is-on' : ''}" data-f-type="">${state.lang === 'ko' ? '전체' : 'All'}</button>${types.map(t => `<button type="button" class="pr-chip${state.filters.type === t ? ' is-on' : ''}" data-f-type="${t}">${esc(typeLabel(t))}</button>`).join('')}</div>`;
}

$('[data-filters]').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.fSev) {
    const s = b.dataset.fSev, set = state.filters.sev;
    set.has(s) ? set.delete(s) : set.add(s);
  } else if ('fType' in b.dataset) state.filters.type = b.dataset.fType || null;
  renderFilters(); renderIssues(); drawHighlights();
});
$('[data-filters]').addEventListener('change', (e) => {
  if (!e.target.matches('[data-f-tags]')) return;
  state.showTags = e.target.checked;
  $('[data-viewer]').classList.toggle('no-tags', !state.showTags);
  stackTags();
});

function renderIssues() {
  const el = $('[data-issue-list]');
  if (!state.proof) { el.innerHTML = ''; return; }
  const shown = state.proof.issues.filter(visible);
  if (!shown.length) { el.innerHTML = `<li class="pr-muted">${state.lang === 'ko' ? '조건에 맞는 이슈가 없어요.' : 'No issues match the filters.'}</li>`; return; }
  el.innerHTML = shown.map(i => `
    <li class="pr-issue sev-${i.severity}${state.selected === i.id ? ' is-selected' : ''}${i.done ? ' is-done' : ''}" data-issue="${i.id}" tabindex="0">
      <div class="pr-issue-head">
        <span class="pr-issue-no">${i.id}</span>
        <span class="pr-issue-type">${esc(typeLabel(i.type))}</span>
        <span class="pr-issue-sev">${sevLabel(i.severity)}</span>
        <span class="pr-issue-page">${i.loc ? `p.${i.loc.page}` : `<em>${state.lang === 'ko' ? '위치 미확인' : 'not located'}</em>`}${i.source ? ` · <code>${esc(i.source)}</code>` : ''}</span>
        <label class="pr-done" title="${UI.doneHint}"><input type="checkbox" data-done="${i.id}"${i.done ? ' checked' : ''}> ${UI.done}</label>
      </div>
      <p class="pr-issue-desc">${esc(desc(i))}</p>
      ${i.quote ? `<p class="pr-issue-quote">“${esc(i.quote)}”</p>` : ''}
      ${i.suggestion ? `<p class="pr-issue-fix"><i class="fas fa-arrow-right"></i> ${esc(i.suggestion)}</p>` : ''}
    </li>`).join('');
}

function drawHighlights() {
  for (const pg of state.pages) pg.layer.replaceChildren();
  if (!state.proof || !state.pages.length) return;
  for (const i of state.proof.issues) {
    if (!i.loc || !visible(i) || i.done) continue;
    const pg = state.pages[i.loc.page - 1];
    if (!pg) continue;
    i.loc.rects.forEach((r, k) => {
      const box = rectToPercent(pg.base, r);
      const hl = document.createElement('button');
      hl.type = 'button';
      hl.className = `pr-hl sev-${i.severity}${state.selected === i.id ? ' is-selected' : ''}`;
      hl.dataset.issue = i.id;
      hl.title = `#${i.id} ${typeLabel(i.type)} · ${desc(i)}`;
      hl.setAttribute('aria-label', hl.title);
      Object.assign(hl.style, { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` });
      if (k === 0) {
        const tag = document.createElement('span');
        tag.className = 'pr-hl-tag';
        tag.textContent = `${i.id} ${typeLabel(i.type)}`;
        hl.append(tag);
      }
      pg.layer.append(hl);
    });
  }
  stackTags();
}

// Lifts tag labels that would overlap an earlier one on the same page. Tags
// have a fixed pixel size while the page scales, so this reruns on resize.
function stackTags() {
  for (const pg of state.pages) {
    const placed = [];
    for (const tag of pg.layer.querySelectorAll('.pr-hl-tag')) {
      tag.style.transform = '';
      const r = tag.getBoundingClientRect();
      if (!r.width) continue;
      let dy = 0;
      const hits = (y) => placed.some(q => r.left < q.right && r.right > q.left && r.top - y < q.bottom && r.bottom - y > q.top);
      for (let k = 0; k < 4 && hits(dy); k++) dy += r.height + 1;
      if (dy) tag.style.transform = `translateY(${-dy}px)`;
      placed.push({ left: r.left, right: r.right, top: r.top - dy, bottom: r.bottom - dy });
    }
  }
}
let stackTimer;
new ResizeObserver(() => { clearTimeout(stackTimer); stackTimer = setTimeout(stackTags, 120); }).observe($('[data-viewer]'));

function select(id, { scrollPdf, scrollList }) {
  state.selected = id;
  root.querySelectorAll('.is-selected').forEach(el => el.classList.remove('is-selected'));
  root.querySelectorAll(`[data-issue="${id}"]`).forEach(el => el.classList.add('is-selected'));
  if (scrollPdf) {
    const hl = root.querySelector(`.pr-hl[data-issue="${id}"]`);
    hl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    hl?.classList.remove('is-flash'); void hl?.offsetWidth; hl?.classList.add('is-flash');
  }
  if (scrollList) root.querySelector(`.pr-issue[data-issue="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('[data-issue-list]').addEventListener('change', (e) => {
  const box = e.target.closest('[data-done]');
  if (!box) return;
  const issue = state.proof.issues.find(i => i.id === +box.dataset.done);
  issue.done = box.checked;
  renderAll();
});
$('[data-issue-list]').addEventListener('click', (e) => {
  if (e.target.closest('.pr-done')) return;
  const li = e.target.closest('.pr-issue');
  if (li) select(+li.dataset.issue, { scrollPdf: true });
});
$('[data-issue-list]').addEventListener('keydown', (e) => {
  const li = e.target.closest('.pr-issue');
  if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(+li.dataset.issue, { scrollPdf: true }); }
});
$('[data-viewer]').addEventListener('click', (e) => {
  const hl = e.target.closest('.pr-hl');
  if (hl) select(+hl.dataset.issue, { scrollList: true });
});

// ── Review versions ────────────────────────────────────────────────────────
// Every review (from the main run or the "another reviewer" bar) is kept as a
// version; the bar switches between them and requests new ones.
function addReview(venueLabel, en, ko) {
  const v = { id: newRunId(), venue: venueLabel, en, ko, createdAt: Date.now() };
  state.reviews = [...(state.reviews || []), v];
  selectReview(v.id);
  return v;
}
function selectReview(id) {
  const v = state.reviews.find(x => x.id === id);
  if (!v) return;
  Object.assign(state, { reviewId: v.id, reviewEn: v.en, reviewKo: v.ko, reviewVenue: v.venue });
}

function renderReviewBar() {
  const el = $('[data-review-bar]');
  if (!state.file || (!state.reviews?.length && !state.proof)) { el.innerHTML = ''; return; }
  const cur = state.reviews?.find(v => v.id === state.reviewId);
  const [cv, cm] = (cur?.venue || state.venue || 'CVPR · harsh').split(' · ');
  state.reviewForm ??= { venue: cv, mode: cm === 'harsh' ? 'typical' : 'harsh' };
  const f = state.reviewForm, busy = state.reviewBusy;
  const venues = [...new Set([...VENUES.map(v => v.id), f.venue])];
  el.innerHTML = `
    <div class="pr-rv-versions">${(state.reviews || []).map(v => {
      const d = DECISIONS[v.en.decision];
      return `<button type="button" class="pr-rv-chip${v.id === state.reviewId ? ' is-on' : ''}" data-review-ver="${v.id}"><span>${esc(v.venue)}</span>${d ? `<em class="pr-tone-${d.tone}">${esc(d[UI_LANG])}</em>` : ''}</button>`;
    }).join('')}</div>
    <div class="pr-rv-new">
      <span class="pr-rv-label">${UI.rvAnother}</span>
      <select class="pr-input" data-rv-venue aria-label="Venue">${venues.map(v => `<option${v === f.venue ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <select class="pr-input" data-rv-mode aria-label="Reviewer"><option value="harsh"${f.mode === 'harsh' ? ' selected' : ''}>Harsh</option><option value="typical"${f.mode === 'typical' ? ' selected' : ''}>Typical</option></select>
      <button type="button" class="pr-btn pr-btn--solid" data-rv-run ${busy || state.running || state.runMode === 'manual' ? 'disabled' : ''}><i class="fas ${busy ? 'fa-circle-notch fa-spin' : 'fa-user-pen'}"></i> <span data-rv-label>${busy ? `${UI.rvBusy}${busy.note ? ` · ${esc(busy.note)}` : ''}` : UI.rvRun}</span></button>
      ${state.runMode === 'manual' ? `<span class="pr-rev-hint">${UI.rvManual}</span>` : ''}
      ${state.reviewError ? `<span class="pr-rev-hint is-err">${esc(state.reviewError)}</span>` : ''}
    </div>`;
}

$('[data-review-bar]').addEventListener('click', (e) => {
  const ver = e.target.closest('[data-review-ver]');
  if (ver) { selectReview(ver.dataset.reviewVer); renderAll(); return; }
  if (e.target.closest('[data-rv-run]')) runExtraReview();
});
$('[data-review-bar]').addEventListener('change', (e) => {
  state.reviewForm ??= {};
  if (e.target.matches('[data-rv-venue]')) state.reviewForm.venue = e.target.value;
  if (e.target.matches('[data-rv-mode]')) state.reviewForm.mode = e.target.value;
});

async function runExtraReview() {
  const { venue, mode } = state.reviewForm;
  const label = `${venue} · ${mode}`;
  state.reviewBusy = { note: '' }; state.reviewError = ''; renderReviewBar();
  // Time-eased estimate (like the main status steps), pushed into a bar that
  // lives outside the re-rendered review bar.
  const bar = progressBar($('[data-rv-progress]'));
  const ease = { floor: 0, cap: 0.08, tau: 4, t: performance.now() };
  const value = () => ease.floor + (ease.cap - ease.floor) * (1 - Math.exp(-(performance.now() - ease.t) / 1000 / ease.tau));
  const phase = (ph) => { const v = value(); Object.assign(ease, { floor: Math.max(v, ph.p ?? 0), cap: Math.max(v, ph.p ?? 0, ph.cap), tau: ph.tau ?? ease.tau, t: performance.now() }); };
  let text = UI.rvStart;
  const tick = setInterval(() => bar.set(value(), text), 400);
  // The bar adds its own elapsed time, so drop the bridge's "· m:ss" suffix there.
  const note = (t) => { text = t.replace(/ · \d+:\d{2}$/, ''); state.reviewBusy.note = t; const l = $('[data-rv-label]'); if (l) l.textContent = `${UI.rvBusy} · ${t}`; bar.set(value(), text); };
  note(UI.rvStart);
  try {
    if (state.runMode === 'api') {
      const client = makeClient(keyInput.value.trim()), model = $('[data-model]').value;
      phase({ cap: 0.3, tau: 20 });
      let streaming = false;
      const { data } = await review(client, { model, pdfBase64: toBase64(state.file.bytes), venue, mode,
        onText: (t) => { if (!streaming) { streaming = true; phase({ p: 0.3, cap: 0.88, tau: 50 }); } note(UI.chars(t.length)); } });
      const v = addReview(label, data, null);
      renderAll();
      phase({ p: 0.88, cap: 0.98, tau: 12 }); note(UI.sTrans);
      const ko = await translateReview(client, { model, reviewEn: data });
      v.ko = ko.data; if (state.reviewId === v.id) state.reviewKo = ko.data;
    } else {
      if (!bridge.connected && !(await pingBridge())) throw new ReviewError(UI.revNeedBridge);
      const data = await callBridge('review', { venue, mode }, (st, detail, ph) => { if (ph) phase(ph); note(detail); });
      addReview(label, data.en, data.ko);
    }
    clearInterval(tick);
    bar.done(UI.rvDone(label));
  } catch (err) {
    clearInterval(tick);
    state.reviewError = explain(err);
    bar.fail(state.reviewError);
  } finally {
    state.reviewBusy = null;
    renderAll();
  }
}

function renderReview() {
  renderReviewBar();
  const el = $('[data-review]');
  const r = state.lang === 'ko' ? state.reviewKo : state.reviewEn;
  if (!state.reviewEn) { el.innerHTML = `<p class="pr-muted">${state.running ? UI.waitReview : UI.noReview}</p>`; return; }
  if (!r) { el.innerHTML = `<p class="pr-muted">${state.running ? UI.waitKo : UI.noKo}</p>`; return; }
  const d = DECISIONS[r.decision] ?? { en: r.decision, ko: r.decision, tone: 'mid' };
  const ko = state.lang === 'ko';
  const list = (items) => `<ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  el.innerHTML = `
    <div class="pr-verdict pr-tone-${d.tone}">
      <div class="pr-verdict-main">
        <span class="pr-verdict-venue">${esc(state.reviewVenue || state.venue)}</span>
        <strong${ko ? ' lang="ko" class="pr-ko-display"' : ''}>${esc(ko ? d.ko : d.en)}</strong>
        <p>${esc(r.verdict)}</p>
      </div>
      <dl class="pr-verdict-meta"><div><dt>${ko ? '평점' : 'Rating'}</dt><dd>${esc(r.rating)}</dd></div><div><dt>${ko ? '확신도' : 'Confidence'}</dt><dd>${esc(r.confidence)}</dd></div></dl>
    </div>
    <div class="pr-review-grid">
      <section class="pr-rsec pr-rsec--wide"><h3>${ko ? '요약' : 'Summary'}</h3><p>${esc(r.summary)}</p></section>
      <section class="pr-rsec pr-rsec--good"><h3><i class="fas fa-plus"></i> ${ko ? '강점' : 'Strengths'}</h3>${list(r.strengths)}</section>
      <section class="pr-rsec pr-rsec--bad"><h3><i class="fas fa-minus"></i> ${ko ? '약점' : 'Weaknesses'}</h3>
        <ul>${r.weaknesses.map(w => `<li><span class="pr-wsev pr-wsev--${w.severity}">${w.severity === 'major' ? (ko ? '주요' : 'major') : (ko ? '경미' : 'minor')}</span><b>${esc(w.title)}</b> ${esc(w.detail)}</li>`).join('')}</ul></section>
      <section class="pr-rsec"><h3><i class="fas fa-question"></i> ${ko ? '저자에게 묻고 싶은 것' : 'Questions for the authors'}</h3>${list(r.questions)}</section>
      <section class="pr-rsec"><h3><i class="fas fa-wrench"></i> ${ko ? '개선 제안' : 'Suggestions'}</h3>${list(r.suggestions)}</section>
      <section class="pr-rsec pr-rsec--wide"><h3>${ko ? '판정 근거' : 'Why this decision'}</h3><p>${esc(r.decision_rationale)}</p></section>
    </div>`;
}

// ── Exports ────────────────────────────────────────────────────────────────

function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const baseName = () => state.file.name.replace(/\.pdf$/i, '');

$('[data-export-pdf]').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const notes = state.proof.issues.filter(i => visible(i) && !i.done).map(i => ({
      issue: i,
      color: SEV_RGB[i.severity],
      subject: `#${i.id} ${typeLabel(i.type)}`,
      text: `[#${i.id}] ${typeLabel(i.type)} · ${sevLabel(i.severity)}\n${desc(i)}${i.suggestion ? `\n→ ${i.suggestion}` : ''}`,
    }));
    const out = await exportAnnotated(state.file.bytes, notes);
    download(`${baseName()}.annotated.${state.lang}.pdf`, out, 'application/pdf');
  } catch (err) {
    alert(`${UI.pdfFail}: ${err.message}`);
  } finally { btn.disabled = false; }
});

function reviewMarkdown(r, ko) {
  if (!r) return '';
  const d = DECISIONS[r.decision];
  const h = ko
    ? ['요약', '강점', '약점', '저자에게 묻고 싶은 것', '개선 제안', '판정 근거', '판정', '평점', '확신도']
    : ['Summary', 'Strengths', 'Weaknesses', 'Questions for the authors', 'Suggestions', 'Why this decision', 'Decision', 'Rating', 'Confidence'];
  const bl = (xs) => xs.map(x => `- ${x}`).join('\n');
  return `**${h[6]}:** ${d ? (ko ? d.ko : d.en) : r.decision} · **${h[7]}:** ${r.rating} · **${h[8]}:** ${r.confidence}

> ${r.verdict}

### ${h[0]}
${r.summary}

### ${h[1]}
${bl(r.strengths)}

### ${h[2]}
${r.weaknesses.map(w => `- **[${w.severity}] ${w.title}** ${w.detail}`).join('\n')}

### ${h[3]}
${bl(r.questions)}

### ${h[4]}
${bl(r.suggestions)}

### ${h[5]}
${r.decision_rationale}
`;
}

$('[data-export-md]').addEventListener('click', () => {
  const parts = [`# Review: ${state.file.name}\n\n${state.venue} reviewer · ${new Date().toISOString().slice(0, 10)}\n`];
  if (state.reviewEn) parts.push(`## English\n\n${reviewMarkdown(state.reviewEn, false)}`);
  if (state.reviewKo) parts.push(`## 한국어\n\n${reviewMarkdown(state.reviewKo, true)}`);
  if (state.proof) {
    parts.push(`## Proofreading issues (${state.proof.issues.length})\n\n` + state.proof.issues.map(i =>
      `${i.id}. **${i.severity} · ${ISSUE_TYPES[i.type]?.en ?? i.type}** (${i.loc ? `p.${i.loc.page}` : 'not located'}) ${i.quote ? `“${i.quote}”` : ''}\n   - EN: ${i.description_en}\n   - KO: ${i.description_ko}${i.suggestion ? `\n   - Fix: ${i.suggestion}` : ''}`).join('\n'));
  }
  download(`${baseName()}.review.md`, parts.join('\n\n'), 'text/markdown');
});

// Test hook: load a saved result without calling the API (?mock=<json url>).
const mockUrl = new URLSearchParams(location.search).get('mock');
if (mockUrl) {
  window.paperReviewerMock = async (pdfUrl) => {
    const bytes = new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer());
    const mock = await (await fetch(mockUrl)).json();
    state.file = { name: pdfUrl.split('/').pop(), bytes };
    state.doc = await openPdf(bytes);
    $('[data-results]').hidden = false;
      state.venue = mock.venue ?? 'CVPR · harsh';
    state.pages = await renderPages(state.doc, $('[data-viewer]'));
    if (mock.proof) { await locateIssues(state.doc, mock.proof.issues); state.proof = mock.proof; }
    state.reviews = []; if (mock.reviewEn) addReview(state.venue, mock.reviewEn, mock.reviewKo ?? null);
    renderAll();
    return state;
  };
}

updateRun();
