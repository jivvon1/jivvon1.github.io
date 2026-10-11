// Run history for the paper reviewer, kept in this browser's IndexedDB until
// the visitor resets it. Each record holds the PDF bytes plus the results, so
// a past run can be reopened exactly as it was.

const DB_NAME = 'paper-reviewer';
const STORE = 'runs';
export const MAX_RUNS = 20;

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function newRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveRun(record) {
  await tx('readwrite', s => s.put(record));
  await prune();
}

export async function getRun(id) {
  return tx('readonly', s => s.get(id));
}

export async function deleteRun(id) {
  return tx('readwrite', s => s.delete(id));
}

export async function clearRuns() {
  return tx('readwrite', s => s.clear());
}

// Newest first, without the PDF bytes (the list only needs the summary).
export async function listRuns() {
  const all = await tx('readonly', s => s.getAll());
  return (all || [])
    .map(({ pdf, source, revisions, revision, ...meta }) => ({ ...meta,
      revisions: (revisions || []).map(({ pdf: _p, source: _s, claude: _c, ...v }) => v) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function prune() {
  const runs = await listRuns();
  for (const r of runs.slice(MAX_RUNS)) await deleteRun(r.id);
}

export function historyAvailable() {
  try { return 'indexedDB' in window && !!indexedDB; } catch { return false; }
}
