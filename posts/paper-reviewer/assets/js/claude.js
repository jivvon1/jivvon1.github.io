// Claude API calls for the paper reviewer: proofreading, venue review, and
// the EN → KO translation of that review. Runs entirely in the browser with
// the visitor's own API key.
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm';

export { Anthropic };

const PROMPT_URL = new URL('../prompts/02_paper_proofreading.md', import.meta.url);

// Shared by every call so the system + PDF prefix is byte-identical and the
// review request can read the cache the proofreading request wrote.
const SYSTEM = 'You are an expert academic reviewer and proofreader for robotics, computer vision, and machine learning papers. Follow the task instructions in the user message exactly.';

export const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'STYLE'];

export const ISSUE_TYPES = {
  grammar:        { en: 'Grammar',        ko: '문법 오류' },
  spelling:       { en: 'Spelling',       ko: '철자 오류' },
  spacing:        { en: 'Spacing',        ko: '띄어쓰기' },
  capitalization: { en: 'Capitalization', ko: '대소문자' },
  punctuation:    { en: 'Punctuation',    ko: '구두점' },
  hyphenation:    { en: 'Hyphenation',    ko: '하이픈' },
  wording:        { en: 'Wording',        ko: '어색한 표현' },
  clarity:        { en: 'Clarity',        ko: '명확성' },
  claim:          { en: 'Overclaim',      ko: '과장·근거 부족' },
  structure:      { en: 'Structure',      ko: '구성·흐름' },
  figure_table:   { en: 'Figure / Table', ko: '그림·표' },
  notation:       { en: 'Notation',       ko: '표기' },
  consistency:    { en: 'Consistency',    ko: '일관성' },
  formatting:     { en: 'Formatting',     ko: '서식' },
};

export const DECISIONS = {
  strong_accept:  { en: 'Strong Accept',  ko: '강력 채택',  tone: 'good' },
  accept:         { en: 'Accept',         ko: '채택',       tone: 'good' },
  weak_accept:    { en: 'Weak Accept',    ko: '약한 채택',  tone: 'good' },
  minor_revision: { en: 'Minor Revision', ko: '소폭 수정',  tone: 'good' },
  borderline:     { en: 'Borderline',     ko: '경계',       tone: 'mid' },
  major_revision: { en: 'Major Revision', ko: '대폭 수정',  tone: 'mid' },
  weak_reject:    { en: 'Weak Reject',    ko: '약한 거절',  tone: 'bad' },
  reject:         { en: 'Reject',         ko: '거절',       tone: 'bad' },
  strong_reject:  { en: 'Strong Reject',  ko: '강력 거절',  tone: 'bad' },
};

// What reviewers at each kind of venue weigh most. Kept deliberately general:
// the model is asked to use the venue's actual review form when it knows it.
const VENUE_FOCUS = {
  cv: 'novelty over the most recent CVPR/ICCV/ECCV work, comparisons against current state of the art on standard benchmarks, thorough ablations that isolate each component, qualitative results that match the quantitative claims, and reproducibility',
  ml: 'novelty and significance of the core idea, soundness of theoretical claims and assumptions, rigor of the empirical evaluation (baselines, seeds, variance, compute), honest discussion of limitations, and reproducibility',
  ai: 'clarity of the problem and contribution, technical soundness, significance to the broader AI community, adequacy of experiments and baselines, and reproducibility',
  robotics: 'whether the problem matters for real robots, technical soundness, real-world (not only simulated) validation, comparison against strong recent baselines, failure-case analysis, runtime, and reproducibility (code, data, hardware details)',
  journal: 'completeness and depth expected of an archival journal: thorough literature coverage, rigorous and extensive experiments, clear positioning against prior work (including the authors\' own conference versions), and whether the paper is self-contained. Recommend accept, minor revision, major revision, or reject',
  letter: 'a focused, self-contained contribution within the strict page limit: novelty, technical soundness, convincing experiments (ideally real-world), and clarity. Recommend accept, minor revision, major revision, or reject',
  general: 'novelty, technical soundness, experimental validation, clarity, and significance',
};

export const VENUES = [
  { id: 'CVPR', group: 'cv' }, { id: 'ICCV', group: 'cv' }, { id: 'ECCV', group: 'cv' },
  { id: 'NeurIPS', group: 'ml' }, { id: 'ICLR', group: 'ml' }, { id: 'ICML', group: 'ml' },
  { id: 'AAAI', group: 'ai' },
  { id: 'ICRA', group: 'robotics' }, { id: 'IROS', group: 'robotics' }, { id: 'RSS', group: 'robotics' }, { id: 'CoRL', group: 'robotics' },
  { id: 'RA-L', group: 'letter' },
  { id: 'T-RO', group: 'journal' }, { id: 'IJRR', group: 'journal' }, { id: 'T-PAMI', group: 'journal' },
];

export function venueGroup(venue) {
  return VENUES.find(v => v.id === venue)?.group ?? 'general';
}

// ── Prompts ────────────────────────────────────────────────────────────────

let rulesPromise;
// Persona + severity levels + category A–I rules, verbatim from the vendored
// prompt. Its file-reading, two-phase, and output-format sections assume a
// LaTeX workspace, so they are replaced by the PDF-mode instructions below.
function loadRules() {
  rulesPromise ??= fetch(PROMPT_URL).then(r => {
    if (!r.ok) throw new Error(`Could not load proofreading prompt (${r.status})`);
    return r.text();
  }).then(md => {
    const slice = (from, to) => {
      const a = md.indexOf(from), b = md.indexOf(to, a + 1);
      if (a < 0 || b < 0) throw new Error(`Prompt section "${from}" not found`);
      return md.slice(a, b).trim();
    };
    return [slice('## Persona', '## Files to Read'), slice('## Severity Levels', '## Output Structure')].join('\n\n');
  });
  return rulesPromise;
}

// `src` (optional) says where the LaTeX source is; with it the full source
// checks apply and every issue also gets a file:line.
function proofreadTask(rules, src = '') {
  const head = src ? `# Task: proofread this paper (PDF + LaTeX source)

You have the compiled PDF and its LaTeX source. ${src}
Before running any checks, read the root file and every \\input{...} / \\include{...} file recursively, as the rules below describe. Apply all the rules, including the checks that need LaTeX source. Phase 2 (fixing) does not apply; only detect and report.

## Locating each issue

- \`page\` and \`quote\` still come from the PDF so the issue can be highlighted: \`page\` is the 1-based physical page of the PDF and \`quote\` a verbatim 3–12 word span from that page. If an issue exists only in the source with no visible text (a macro, label, or package problem), use quote "" and page 0.
- \`source\`: where it is in the LaTeX source, as "path/to/file.tex:LINE" (path relative to the project root).
- Report each occurrence as its own issue (each misspelling separately), numbered from 1 in reading order.` : '';
  return src ? `${head}
${FIELDS}

${rules}` : `# Task: proofread this paper (PDF-only mode)

You are given only the compiled PDF of the paper above, not its LaTeX source. The review rules further below were written for a LaTeX workspace; apply them adapted to the PDF:

- Skip checks that can only be verified in LaTeX source (macros such as \\ie / \\eg / \\etalcite / \\methodname, \\cref vs \\ref, non-breaking ~, \\hline vs booktabs, label names, \\input files, shortcuts.tex). Where a rule has a visible symptom in the rendered text, check that symptom instead: e.g. "Fig. 3" vs "Figure 3" inconsistency, a missing space between a number and its unit ("5m"), missing thousands separators, "i.e." without a following comma, "et al" without a period, a citation number used as a sentence subject.
- There are no line numbers. Locate every issue by page and a verbatim quote (rules below).
- Only detect and report. Phase 2 (fixing) does not apply.

## Locating each issue

- \`page\`: 1-based index of the physical page in the PDF file (not the printed page number).
- \`quote\`: copy, verbatim, a short contiguous span (about 3–12 words) from that page that contains the problem, exactly as it appears in the PDF, so software can find it with a plain string search. Do not paraphrase or correct it, do not add ellipses, and do not let the span cross a column, figure, or page boundary. Use the smallest span that covers the error and is unique on the page.
- For an issue that concerns a whole section or the whole paper, quote the relevant section heading (e.g. "Related Work") and use the page where it starts. If nothing fits, use quote "" and page 0.
- Report each occurrence as its own issue (each misspelling separately), numbered from 1 in reading order.

## Fields

- \`type\`: the most specific of: grammar, spelling (typos, duplicated words), spacing (missing or extra spaces, e.g. "5m", "method(Fig. 2)"), capitalization (wrong or inconsistent upper/lower case), punctuation, hyphenation, wording (awkward, wordy, nominalized, or filler phrasing), clarity, claim (overclaiming or unsupported claims), structure, figure_table, notation, consistency, formatting.
- \`category\`: the rule category letter A–I below that the issue falls under.
- \`description_en\`: what is wrong, in one concise sentence.
- \`description_ko\`: the same in natural, concise Korean, as a reviewer's margin note (e.g. "관사 누락: 'an' 필요", "주어-동사 수 불일치").
- \`suggestion\`: the corrected English text, or a concrete fix when it is not a text replacement.
- \`source\`: "" (no LaTeX source in this mode).

Be exhaustive: report every issue you find, not a sample.

---

${rules}`;
}

const FIELDS = `## Fields

- \`type\`: the most specific of: grammar, spelling (typos, duplicated words), spacing (missing or extra spaces, e.g. "5m", "method(Fig. 2)"), capitalization (wrong or inconsistent upper/lower case), punctuation, hyphenation, wording (awkward, wordy, nominalized, or filler phrasing), clarity, claim (overclaiming or unsupported claims), structure, figure_table, notation, consistency, formatting.
- \`category\`: the rule category letter A–I below that the issue falls under.
- \`description_en\`: what is wrong, in one concise sentence.
- \`description_ko\`: the same in natural, concise Korean, as a reviewer's margin note (e.g. "관사 누락: 'an' 필요", "주어-동사 수 불일치").
- \`suggestion\`: the corrected English text (or LaTeX), or a concrete fix when it is not a text replacement.

Be exhaustive: report every issue you find, not a sample.

---`;

function reviewTask({ venue, group, mode }) {
  const stance = mode === 'harsh'
    ? `Stance: harsh. Treat the paper as borderline at best until the evidence convinces you. Lead with the weaknesses most likely to sink it at ${venue}: limited novelty relative to recent prior work, missing or weak baselines, unconvincing ablations, claims the results do not back, and reproducibility gaps. Do not soften your language. Recommend rejection unless the contribution is clearly above the ${venue} bar. Stay fair: every criticism must point to concrete evidence in the paper, and do not invent flaws.`
    : `Stance: typical. Review as a conscientious, typical ${venue} reviewer: balanced and constructive, giving credit for real strengths, separating fatal flaws from fixable ones, and using the full range of the rating scale.`;
  return `I am a ${mode} ${venue} reviewer who is an expert in this field. Review this paper and tell me whether to accept or reject this paper with valid reasons.

${stance}

What ${venue} reviewers weigh most: ${VENUE_FOCUS[group]}.

Instructions:
- Read the whole paper, including figures, tables, and any appendix.
- Ground every point in the paper: name the section, figure, table, equation, or page it concerns. Do not attribute content to the paper that it does not contain.
- \`summary\`: what the paper claims and does, in your own words (3–5 sentences).
- \`strengths\` and \`weaknesses\`: specific and ordered by importance. Mark each weakness \`major\` (affects the decision) or \`minor\`.
- \`questions\`: what you would ask the authors in a rebuttal.
- \`suggestions\`: concrete changes that would most improve the paper's chance at ${venue}.
- \`rating\`: the overall rating on ${venue}'s own review-form scale if you know it, written as "<score> / <max> (<label>)"; otherwise use a 1–6 scale (1 strong reject … 6 strong accept).
- \`confidence\`: your reviewer confidence, written the same way (e.g. "4 / 5").
- \`decision\`: your final recommendation. \`decision_rationale\`: the two or three reasons that decide it.
- \`verdict\`: one sentence a busy author can read first.

Venue fit (\`venue_fit\`), judged separately from the accept/reject decision:
- Decide whether this paper suits ${venue}: its scope and audience, and its format and expectations. A full archival journal expects depth, completeness, and extensive experiments and comparisons; a conference expects a focused, timely contribution within the page limit; a letter expects a short, self-contained result; a workshop suits early or narrow work.
- \`verdict\`: \`good_fit\`, \`borderline_fit\`, or \`poor_fit\`. \`reason\`: two or three sentences that point to concrete evidence in the paper.
- \`recommendation\`: one or two sentences of advice. If ${venue} is a good fit, say so and what would make the submission strongest there. If it is not, name where to submit instead and say exactly why, including what the paper lacks for ${venue} or what makes the other venue a better match (for example: "a conference such as ICRA suits this better than a journal, because the evaluation covers only two datasets and lacks the ablations and comparisons a journal would expect").
- \`alternatives\`: always give 3–5 other venues, ranked best first (\`rank\` 1 = best), even when ${venue} is a good fit. Do not include ${venue} itself. For each: \`venue\` (its usual short name), \`kind\` (\`conference\`, \`journal\`, \`letter\`, or \`workshop\`), \`fit\` (\`strong\`, \`good\`, or \`possible\`), and a one-sentence \`reason\`.`;
}

function translateTask(reviewJson) {
  return `Translate every string value in the following paper review from English into natural, professional Korean, as a Korean expert reviewer would write it. Keep enum values (\`decision\`, \`severity\`, and \`verdict\`, \`kind\`, \`fit\` inside \`venue_fit\`) and \`rank\` numbers unchanged; keep venue names as they are. Keep method names, dataset names, metrics, venue names, and well-established technical terms in English where Korean researchers normally do. Keep the rating and confidence numbers unchanged. Do not add, drop, merge, or reorder any item.

${JSON.stringify(reviewJson, null, 2)}`;
}

// ── Output schemas ─────────────────────────────────────────────────────────

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const PROOFREAD_SCHEMA = obj({
  paper_quality: { type: 'string', enum: ['GOOD', 'NEEDS REVISION', 'MAJOR REVISION'] },
  most_common_problems_en: strArr,
  most_common_problems_ko: strArr,
  issues: {
    type: 'array',
    items: obj({
      id: { type: 'integer' },
      page: { type: 'integer' },
      quote: str,
      severity: { type: 'string', enum: SEVERITIES },
      type: { type: 'string', enum: Object.keys(ISSUE_TYPES) },
      category: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] },
      description_en: str,
      description_ko: str,
      suggestion: str,
      source: str,
    }),
  },
  polishing_suggestions_en: strArr,
  polishing_suggestions_ko: strArr,
});

const REVIEW_SCHEMA = obj({
  verdict: str,
  decision: { type: 'string', enum: Object.keys(DECISIONS) },
  rating: str,
  confidence: str,
  summary: str,
  strengths: strArr,
  weaknesses: { type: 'array', items: obj({ title: str, detail: str, severity: { type: 'string', enum: ['major', 'minor'] } }) },
  questions: strArr,
  suggestions: strArr,
  decision_rationale: str,
  venue_fit: obj({
    verdict: { type: 'string', enum: ['good_fit', 'borderline_fit', 'poor_fit'] },
    reason: str,
    recommendation: str,
    alternatives: { type: 'array', items: obj({
      rank: { type: 'integer' },
      venue: str,
      kind: { type: 'string', enum: ['conference', 'journal', 'letter', 'workshop'] },
      fit: { type: 'string', enum: ['strong', 'good', 'possible'] },
      reason: str,
    }) },
  }),
});

// ── Calls ──────────────────────────────────────────────────────────────────

export function makeClient(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// The PDF (and, when given, the LaTeX source as one text block) come first so
// requests share a cacheable prefix; the task text comes last.
function pdfContent(pdfBase64, task, sourceText = '') {
  const doc = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } };
  if (!sourceText) return [{ ...doc, cache_control: { type: 'ephemeral' } }, { type: 'text', text: task }];
  return [doc, { type: 'text', text: sourceText, cache_control: { type: 'ephemeral' } }, { type: 'text', text: task }];
}

const API_SRC = (main) => `The LaTeX source files follow the PDF in one block; each file starts with a line "=== path ===". The main file is ${main}.`;
const LOCAL_SRC = (main) => `The LaTeX source project is unpacked in ./source/ (main file: ./source/${main}). Use Glob to list its files and Read to open them.`;

export class ReviewError extends Error {}

// Streams one structured-output request. `onEvent` sees raw stream events
// (the first one means the prompt cache is readable); `onText` sees the
// accumulated JSON so far, for progress display.
async function runStructured(client, { model, effort, content, schema, onEvent, onText }) {
  const params = {
    model,
    max_tokens: 64000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  // Server-side refusal fallback: if the Opus 5 / 5.5 or Fable 5.1 classifiers decline,
  // the request is re-run on Anthropic's recommended fallback model.
  if (['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-1'].includes(model)) Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });

  const stream = client.beta.messages.stream(params);
  let text = '';
  if (onEvent) stream.on('streamEvent', onEvent);
  stream.on('text', delta => { text += delta; onText?.(text); });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') throw new ReviewError('refusal');
  if (msg.stop_reason === 'max_tokens') throw new ReviewError('max-tokens');
  const out = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    return { data: JSON.parse(out), usage: msg.usage };
  } catch {
    throw new ReviewError('bad-json');
  }
}

export async function proofread(client, { model, pdfBase64, source, onEvent, onText }) {
  const rules = await loadRules();
  const task = proofreadTask(rules, source ? API_SRC(source.main) : '');
  return runStructured(client, { model, effort: 'high', content: pdfContent(pdfBase64, task, source?.text), schema: PROOFREAD_SCHEMA, onEvent, onText });
}

export async function review(client, { model, pdfBase64, venue, mode, onText }) {
  const task = reviewTask({ venue, group: venueGroup(venue), mode });
  return runStructured(client, { model, effort: 'high', content: pdfContent(pdfBase64, task), schema: REVIEW_SCHEMA, onText });
}

export async function translateReview(client, { model, reviewEn }) {
  return runStructured(client, { model, effort: 'low', content: [{ type: 'text', text: translateTask(reviewEn) }], schema: REVIEW_SCHEMA });
}

// ── No-API mode ────────────────────────────────────────────────────────────
// Same tasks, packaged as one prompt to paste into claude.ai or Claude Code
// next to the PDF. Without structured outputs the schema goes in the prompt,
// and the review comes back in both languages in a single answer.

const REVIEW_PAIR_SCHEMA = obj({ en: REVIEW_SCHEMA, ko: REVIEW_SCHEMA });

function manualFooter(schema, extra = '') {
  return `

---

## Output format

${extra}Respond with exactly one JSON object and nothing else: no prose before or after it, no Markdown code fence. It must validate against this JSON Schema:

${JSON.stringify(schema)}`;
}

const ATTACHED = 'The attached PDF is the paper.';

export async function manualProofreadPrompt(source = ATTACHED) {
  const rules = await loadRules();
  return `${source}\n\n${proofreadTask(rules)}${manualFooter(PROOFREAD_SCHEMA)}`;
}

export function manualReviewPrompt({ venue, mode }, source = ATTACHED) {
  const task = reviewTask({ venue, group: venueGroup(venue), mode });
  return `${source}\n\n${task}${manualFooter(REVIEW_PAIR_SCHEMA,
    'Write the review in English under `en`. Under `ko`, give a faithful Korean translation of that same review: same items in the same order, the same `decision` and `severity` values, the same rating and confidence, with method names, datasets, metrics, and established technical terms kept in English where Korean researchers normally do.\n\n')}`;
}

// Parses a pasted answer: tolerates a code fence or stray text around the
// JSON object, then checks the fields the page relies on.
export function parseManual(text, kind) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new ReviewError('no-json');
  let data;
  try { data = JSON.parse(s.slice(a, b + 1)); } catch { throw new ReviewError('bad-json'); }
  const isReview = (r) => r && typeof r === 'object' && typeof r.decision === 'string' && Array.isArray(r.strengths) && Array.isArray(r.weaknesses);
  if (kind === 'proof') {
    if (!Array.isArray(data.issues)) throw new ReviewError('wrong-shape');
    data.issues.forEach((i, k) => { i.id ??= k + 1; i.page = Number(i.page) || 0; i.quote ??= ''; });
    data.most_common_problems_en ??= []; data.most_common_problems_ko ??= [];
    return data;
  }
  if (isReview(data.en)) return { en: data.en, ko: isReview(data.ko) ? data.ko : null };
  if (isReview(data)) return { en: data, ko: null };
  throw new ReviewError('wrong-shape');
}

// ── Local Claude Code bridge (bridge.mjs) ──────────────────────────────────
// Same prompts; the bridge writes the PDF next to Claude Code as ./paper.pdf
// and enforces the schema with `claude -p --json-schema`.

const LOCAL_PDF = 'The paper is the PDF file ./paper.pdf in the current working directory. Read every page of it with the Read tool before you answer; for a long PDF, read it in page ranges until all pages are covered.';

export async function bridgeTask(kind, opts) {
  if (kind === 'proof' && opts?.srcMain) {
    const rules = await loadRules();
    return { prompt: `${LOCAL_PDF}\n\n${proofreadTask(rules, LOCAL_SRC(opts.srcMain))}`, schema: PROOFREAD_SCHEMA };
  }
  return kind === 'proof'
    ? { prompt: await manualProofreadPrompt(LOCAL_PDF), schema: PROOFREAD_SCHEMA }
    : { prompt: manualReviewPrompt(opts, LOCAL_PDF), schema: REVIEW_PAIR_SCHEMA };
}

// ── Revision check ─────────────────────────────────────────────────────────
// Given the issues found in the previous version and the revised PDF, Claude
// judges each issue and lists problems the edits introduced.

const VERIFY_SCHEMA = obj({
  summary_en: str,
  summary_ko: str,
  verdicts: { type: 'array', items: obj({
    id: { type: 'integer' },
    status: { type: 'string', enum: ['fixed', 'partially_fixed', 'not_fixed', 'cannot_tell'] },
    note_en: str,
    note_ko: str,
  }) },
  new_issues: PROOFREAD_SCHEMA.properties.issues,
  flow_check: obj({
    verdict: { type: 'string', enum: ['ok', 'minor_problems', 'major_problems'] },
    notes_en: strArr,
    notes_ko: strArr,
  }),
});

function verifyTask(issues, source, src = '') {
  const slim = issues.map(({ id, page, quote, severity, type, description_en, suggestion, done }) => ({ id, marked_fixed: !!done, page, quote, severity, type, description_en, suggestion }));
  return `${source}

# Task: check a revision

This PDF is the REVISED version of a paper.${src ? ` Its LaTeX source is available too: ${src} Use it to check fixes that live in the source and give \`source\` (file:line) for new issues.` : ''} An earlier proofreading pass of the previous version found the issues listed below (JSON). The page numbers and quotes refer to the previous version, so text may have moved.

Work in this order:

1. **Issues the author marked as fixed** (\`marked_fixed: true\`). Check these first and most carefully: confirm each one is really fixed and that the fix is correct English and did not introduce a new error in the same sentence. Be strict: if the author thinks it is fixed but it is not, say so.
2. **All remaining issues.**
3. **Overall flow of the revised paper.** Edits made to fix local issues often break things elsewhere. Read the whole revision and check: transitions between sentences, paragraphs, and sections still make sense; terms, method names, notation, and numbers are consistent across sections (abstract, introduction, experiments, conclusion, captions); references to figures, tables, equations, and sections still point to the right content; claims in the abstract, introduction, and conclusion still match the results. Report this in \`flow_check\`: \`verdict\` is \`ok\`, \`minor_problems\`, or \`major_problems\`, with concrete notes in English (\`notes_en\`) and the same notes in Korean (\`notes_ko\`); empty lists if everything is fine.

For every issue, decide:
- \`fixed\`: the problem is gone and the new text is correct (it need not match the suggestion word for word).
- \`partially_fixed\`: improved but not fully resolved, or fixed in one place and not another.
- \`not_fixed\`: the problem is still there.
- \`cannot_tell\`: the passage was removed or cannot be found, so the issue cannot be judged.
Give a short reason in \`note_en\` and the same in natural Korean in \`note_ko\`.

List in \`new_issues\` only clear problems that the revision introduced in changed or new text (grammar, spelling, spacing, capitalization, punctuation, hyphenation, wording, clarity, overclaiming, formatting, notation). Do not repeat the issues below. Use the same fields as the proofreading output: \`page\` is the 1-based physical page of this revised PDF, \`quote\` is a verbatim 3–12 word span from that page, \`description_ko\` is a concise Korean margin note, and \`id\` starts at 1.

Finish with a two-sentence overall summary in English (\`summary_en\`) and Korean (\`summary_ko\`).

Previous issues:
${JSON.stringify(slim, null, 1)}`;
}

export async function verifyRevision(client, { model, pdfBase64, issues, source }) {
  const task = verifyTask(issues, 'The attached PDF is the revised paper.', source ? API_SRC(source.main) : '');
  return runStructured(client, { model, effort: 'high', content: pdfContent(pdfBase64, task, source?.text), schema: VERIFY_SCHEMA });
}

export function bridgeVerifyTask(issues, srcMain) {
  return { prompt: verifyTask(issues, LOCAL_PDF.replace('The paper is', 'The revised paper is'), srcMain ? LOCAL_SRC(srcMain) : ''), schema: VERIFY_SCHEMA };
}

export function parseVerify(data) {
  if (!data || !Array.isArray(data.verdicts)) throw new ReviewError('wrong-shape');
  data.new_issues = (data.new_issues || []).map((i, k) => ({ ...i, id: i.id ?? k + 1, page: Number(i.page) || 0, quote: i.quote ?? '' }));
  return data;
}
