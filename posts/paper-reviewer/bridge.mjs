#!/usr/bin/env node
// Paper Reviewer bridge: lets https://jivvon1.github.io/posts/paper-reviewer/
// run its proofreading and review on YOUR local Claude Code (your own login
// and plan), instead of an API key.
//
//   curl -fsSL https://jivvon1.github.io/posts/paper-reviewer/bridge.mjs | node --input-type=module
//   # or download it, read it, then:  node bridge.mjs
//
// Needs Node 18+ and Claude Code (`claude`) installed and signed in.
//
// What it does, and nothing else:
// - listens on 127.0.0.1 only, and answers only requests that come from the
//   Paper Reviewer page's origin AND carry the pairing token printed below;
// - for each request, writes the PDF to a fresh temp folder and runs
//   `claude -p` there with only the Read tool enabled (no shell, no edits,
//   no web, no MCP servers), then streams progress and the JSON result back;
// - deletes the temp folder afterwards;
// - on request, compiles a LaTeX project you point it at, or one uploaded as a
//   .zip (e.g. Overleaf "Download Source"), with latexmk or pdflatex, always
//   -no-shell-escape, in a temp folder;
// - when the page sends the LaTeX source zip with a job, unpacks it next to the
//   PDF so Claude Code can read the .tex files (Read/Glob/Grep only).
// Ctrl+C stops it.
//
// Options (env vars): PR_PAGE   page to open and accept requests from
//                     PR_PORT   first port to try (default 43117)
//                     PR_MODEL  default model passed to `claude --model` (the page can pick another)
//                     PR_CLAUDE path to the claude binary (default: claude)
//                     PR_NO_OPEN=1  print the link instead of opening it

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile, stat, mkdir, readdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';

const VERSION = 5;
const PAGE = process.env.PR_PAGE || 'https://jivvon1.github.io/posts/paper-reviewer/';
const ORIGINS = new Set(['https://jivvon1.github.io', new URL(PAGE).origin]);
const CLAUDE = process.env.PR_CLAUDE || 'claude';
const MODEL = process.env.PR_MODEL || '';
const MAX_BODY = 120 * 1024 * 1024;
const MAX_UNZIPPED = 400 * 1024 * 1024;
const MAX_JOBS = 2;
const TOKEN = randomBytes(18).toString('base64url');
// Models the page may request; anything else is ignored.
const MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m` };

const probe = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', shell: platform() === 'win32' });
if (probe.status !== 0) {
  console.error(c.red('Could not run `claude`. Install Claude Code and sign in first: https://claude.com/claude-code'));
  process.exit(1);
}
const CLAUDE_VERSION = probe.stdout.trim();
// Login state of this machine's Claude Code (`claude auth status` prints JSON).
function authStatus() {
  const r = spawnSync(CLAUDE, ['auth', 'status'], { encoding: 'utf8', shell: platform() === 'win32', timeout: 20000 });
  try { const j = JSON.parse(r.stdout); return { loggedIn: !!j.loggedIn, method: j.authMethod || null, plan: j.subscriptionType || null }; }
  catch { return { loggedIn: null, method: null, plan: null }; }
}
let AUTH = authStatus();
const AUTH_ERR = /OAuth|authenticat|not logged in|log ?in again|\/login|invalid api key|401/i;
const has = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8', shell: platform() === 'win32' }).status === 0;
const TEX = { latexmk: has('latexmk'), pdflatex: has('pdflatex') };

let jobs = 0;

function tokenOk(req) {
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); } else chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function run(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, e.message === 'too-large' ? 413 : 400, { error: e.message }); }
  const { prompt, schema, pdfBase64, label = 'job', model, zipBase64 } = body;
  if (typeof prompt !== 'string' || typeof pdfBase64 !== 'string' || (schema && typeof schema !== 'object')) return sendJson(res, 400, { error: 'bad-request' });
  if (jobs >= MAX_JOBS) return sendJson(res, 429, { error: 'busy' });

  jobs++;
  const dir = await mkdtemp(join(tmpdir(), 'paper-reviewer-'));
  await writeFile(join(dir, 'paper.pdf'), Buffer.from(pdfBase64, 'base64'));
  if (typeof zipBase64 === 'string') {
    try { await unzipTo(Buffer.from(zipBase64, 'base64'), join(dir, 'source')); }
    catch (e) { jobs--; await rm(dir, { recursive: true, force: true }); return sendJson(res, 400, { error: e.message }); }
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const emit = (o) => res.write(JSON.stringify(o) + '\n');
  const started = Date.now();
  console.log(c.dim(`[${new Date().toLocaleTimeString()}]`), `${label}: started${MODELS.has(model) ? ` (${model})` : ''}`);

  const tools = typeof zipBase64 === 'string' ? 'Read,Glob,Grep' : 'Read';
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', tools, '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--no-session-persistence'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  const useModel = MODELS.has(model) ? model : MODEL;
  if (useModel) args.push('--model', useModel);
  const child = spawn(CLAUDE, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], shell: platform() === 'win32' });
  child.stdin.end(prompt);

  let buf = '', stderr = '', done = false;
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use' && block.name === 'Read') emit({ type: 'progress', kind: 'read', pages: block.input?.pages ?? null, file: /paper\.pdf$/.test(block.input?.file_path || '') ? null : basename(block.input?.file_path || '') });
          else if (block.type === 'tool_use' && block.name === 'StructuredOutput') emit({ type: 'progress', kind: 'writing' });
          else if (block.type === 'thinking' || block.type === 'text') emit({ type: 'progress', kind: 'thinking' });
        }
      } else if (ev.type === 'result') {
        done = true;
        let data = ev.structured_output ?? null;
        const ok = !ev.is_error && ev.subtype === 'success';
        emit({ type: 'result', ok, subtype: ev.subtype, data, text: ev.result ?? '', auth: !ok && AUTH_ERR.test(String(ev.result ?? '')) });
      }
    }
  });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });

  // Stop Claude if the page goes away mid-run.
  res.on('close', () => { if (!done) child.kill(); });

  child.on('close', async (code) => {
    if (!done) emit({ type: 'error', message: stderr.trim() || `claude exited with code ${code}`, auth: AUTH_ERR.test(stderr) });
    res.end();
    jobs--;
    await rm(dir, { recursive: true, force: true });
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(c.dim(`[${new Date().toLocaleTimeString()}]`), `${label}: ${done ? c.green('done') : c.red('failed')} in ${secs}s`);
  });
}

// Runs a command with a time limit; resolves with { code, out }.
function runTool(cmd, args, cwd, ms = 180000, onLine = null) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: platform() === 'win32' });
    let out = '', part = '';
    const keep = (d) => {
      out = (out + d).slice(-6000);
      if (!onLine) return;
      part += d;
      let nl;
      while ((nl = part.indexOf('\n')) >= 0) { onLine(part.slice(0, nl)); part = part.slice(nl + 1); }
    };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill(); keep('\n[timed out]'); }, ms);
    child.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
    child.on('error', (e) => { clearTimeout(timer); done({ code: -1, out: e.message }); });
  });
}

// Minimal .zip reader (stored + deflate, no ZIP64). Skips __MACOSX and
// directory entries, and refuses entries that would land outside `dest`.
async function unzipTo(buf, dest) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('bad-zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16), total = 0;
  const names = [];
  if (count > 20000) throw new Error('zip-too-many');
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad-zip');
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen).replace(/\\/g, '/');
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || basename(name).startsWith('._')) continue;
    const target = resolve(dest, name);
    if (!target.startsWith(resolve(dest) + sep)) throw new Error('zip-slip');
    if ((total += usize) > MAX_UNZIPPED) throw new Error('zip-too-big');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    names.push(name);
  }
  return names;
}

// Picks the main .tex: the requested one, else main.tex, else the shallowest
// .tex that contains \documentclass.
async function findMain(dir, names, wanted) {
  const tex = names.filter(n => /\.tex$/i.test(n));
  if (wanted && tex.includes(wanted)) return wanted;
  const byDepth = (a, b) => a.split('/').length - b.split('/').length || a.length - b.length;
  const mains = tex.filter(n => basename(n).toLowerCase() === 'main.tex').sort(byDepth);
  if (mains.length) return mains[0];
  for (const n of tex.sort(byDepth)) {
    try { if (/\\documentclass/.test(await readFile(join(dir, n), 'utf8'))) return n; } catch { /* unreadable */ }
  }
  return null;
}

// Builds `mainPath` into a temp folder; resolves { ok, pdf?, engine, log }.
// `progress({ rule, run, pages })` is called as latexmk/pdflatex report work.
async function buildPdf(mainPath, progress = null) {
  const out = await mkdtemp(join(tmpdir(), 'paper-reviewer-tex-'));
  const cwd = dirname(mainPath), file = basename(mainPath);
  let rule = 'pdflatex', run = 0, pages = 0;
  const onLine = progress && ((line) => {
    const m = line.match(/Run number (\d+) of rule '([^']+)'/) || line.match(/applying rule '([^']+)'/);
    if (m) { rule = (m[2] || m[1]).replace(/^.*pdflatex.*$/, 'pdflatex'); run = m[2] ? +m[1] : run + 1; pages = 0; progress({ rule, run, pages }); return; }
    const shipped = line.match(/\[(\d+)(?=[\]{\s<]|$)/g);
    if (shipped && rule === 'pdflatex') { pages = Math.max(pages, ...shipped.map(x => +x.slice(1))); progress({ rule, run, pages }); }
  });
  let result;
  if (TEX.latexmk) {
    result = await runTool('latexmk', ['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-outdir=${out}`, '-pdflatex=pdflatex -no-shell-escape %O %S', file], cwd, 180000, onLine);
  } else {
    const args = ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', `-output-directory=${out}`, file];
    progress?.({ rule: 'pdflatex', run: 1, pages: 0 });
    result = await runTool('pdflatex', args, cwd, 180000, onLine);
    if (result.code === 0) { run = 1; progress?.({ rule: 'pdflatex', run: 2, pages: 0 }); result = await runTool('pdflatex', args, cwd, 180000, onLine); }
  }
  const engine = TEX.latexmk ? 'latexmk' : 'pdflatex';
  try {
    const pdf = await readFile(join(out, file.replace(/\.tex$/i, '.pdf')));
    return { ok: true, pdf, engine, log: result.out.slice(-1500), warnings: result.code !== 0 };
  } catch {
    return { ok: false, engine, log: result.out.slice(-3000) };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

function sendBuild(res, b, extra = {}) {
  if (b.ok) sendJson(res, 200, { ok: true, engine: b.engine, pdfBase64: b.pdf.toString('base64'), log: b.log, warnings: b.warnings, ...extra });
  else sendJson(res, 200, { ok: false, engine: b.engine, log: b.log, ...extra });
}

async function compileZip(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, e.message === 'too-large' ? 413 : 400, { error: e.message }); }
  if (!TEX.latexmk && !TEX.pdflatex) return sendJson(res, 501, { error: 'no-tex' });
  if (typeof body.zipBase64 !== 'string') return sendJson(res, 400, { error: 'bad-request' });
  const dir = await mkdtemp(join(tmpdir(), 'paper-reviewer-src-'));
  // With { stream: true } the reply is NDJSON progress events ending in a
  // { type: 'result' } line; otherwise a single JSON object.
  const stream = body.stream === true;
  const emit = (o) => res.write(JSON.stringify(o) + '\n');
  try {
    const names = await unzipTo(Buffer.from(body.zipBase64, 'base64'), dir);
    const main = await findMain(dir, names, body.main);
    if (!main) return sendJson(res, 400, { error: 'no-main' });
    console.log(c.dim(`[${new Date().toLocaleTimeString()}]`), `compile zip: ${main} (${names.length} files)`);
    if (!stream) return sendBuild(res, await buildPdf(join(dir, main)), { main });
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    emit({ type: 'stage', stage: 'unzip', files: names.length });
    emit({ type: 'stage', stage: 'main', main });
    const b = await buildPdf(join(dir, main), (p) => emit({ type: 'tex', ...p }));
    emit(b.ok ? { type: 'result', ok: true, engine: b.engine, pdfBase64: b.pdf.toString('base64'), log: b.log, warnings: b.warnings, main }
      : { type: 'result', ok: false, engine: b.engine, log: b.log, main });
    res.end();
  } catch (e) {
    if (res.headersSent) { emit({ type: 'result', ok: false, error: e.message }); res.end(); }
    else sendJson(res, 400, { error: e.message });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function compile(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const { dir, main = 'main.tex' } = body;
  if (!TEX.latexmk && !TEX.pdflatex) return sendJson(res, 501, { error: 'no-tex' });
  if (typeof dir !== 'string' || !isAbsolute(dir)) return sendJson(res, 400, { error: 'dir-not-absolute' });
  const root = resolve(dir);
  const mainPath = resolve(root, String(main));
  const rel = relative(root, mainPath);
  if (rel.startsWith('..') || isAbsolute(rel) || !/\.tex$/i.test(mainPath)) return sendJson(res, 400, { error: 'bad-main' });
  try { if (!(await stat(root)).isDirectory() || !(await stat(mainPath)).isFile()) throw 0; } catch { return sendJson(res, 404, { error: 'not-found' }); }

  console.log(c.dim(`[${new Date().toLocaleTimeString()}]`), `compile: ${mainPath}`);
  sendBuild(res, await buildPdf(mainPath));
}

const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  // Rejects DNS-rebinding tricks and requests from any other website.
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return sendJson(res, 403, { error: 'host' });
  if (req.headers.origin && !ORIGINS.has(req.headers.origin)) return sendJson(res, 403, { error: 'origin' });
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!tokenOk(req)) return sendJson(res, 401, { error: 'token' });
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') { if (!jobs) AUTH = authStatus(); return sendJson(res, 200, { ok: true, version: VERSION, claude: CLAUDE_VERSION, busy: jobs, tex: TEX, auth: AUTH }); }
  if (req.method === 'POST' && url.pathname === '/compile') return compile(req, res).catch((e) => sendJson(res, 500, { error: e.message }));
  if (req.method === 'POST' && url.pathname === '/compile-zip') return compileZip(req, res).catch((e) => sendJson(res, 500, { error: e.message }));
  if (req.method === 'POST' && url.pathname === '/run') return run(req, res).catch((e) => { try { sendJson(res, 500, { error: e.message }); } catch { /* already streaming */ } });
  sendJson(res, 404, { error: 'not-found' });
});

// Tries successive ports when one is taken. The banner reads the bound port
// from the server itself, so a retry never prints a stale link.
function listen(port, triesLeft) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) listen(port + 1, triesLeft - 1);
    else { console.error(c.red(e.message)); process.exit(1); }
  });
  server.listen(port, '127.0.0.1');
}

server.once('listening', () => {
  const { port } = server.address();
  const link = `${PAGE}#bridge=${TOKEN}&port=${port}`;
  console.log(`\n  ${c.bold('Paper Reviewer bridge')} ${c.dim(`· ${CLAUDE_VERSION}`)}`);
  if (AUTH.loggedIn === false) console.log(c.red('  Claude Code is not signed in. Run `claude auth login` first, then retry from the page.'));
  else if (AUTH.plan) console.log(c.dim(`  Signed in · ${AUTH.method || ''} ${AUTH.plan}`));
  console.log(`  Listening on ${c.bold(`127.0.0.1:${port}`)}, accepting requests from ${[...ORIGINS].join(', ')}\n`);
  console.log(`  Open this link to connect (it opens automatically if it can):\n  ${c.bold(link)}\n`);
  console.log(`  Or paste this pairing code into the page: ${c.bold(`${port}-${TOKEN}`)}\n`);
  console.log(c.dim('  Leave this running while you use the page. Ctrl+C to stop.\n'));
  const opener = { darwin: ['open', [link]], win32: ['cmd', ['/c', 'start', '', link]] }[platform()] ?? ['xdg-open', [link]];
  if (!process.env.PR_NO_OPEN) try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* print-only */ }
});

listen(Number(process.env.PR_PORT) || 43117, 9);
