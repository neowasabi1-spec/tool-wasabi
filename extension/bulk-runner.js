const BULK_KEY = 'wasabi_bulk_import';

const els = {
  phase: document.getElementById('phase'),
  fill: document.getElementById('fill'),
  saved: document.getElementById('saved'),
  skipped: document.getElementById('skipped'),
  failed: document.getElementById('failed'),
  left: document.getElementById('left'),
  typeLabel: document.getElementById('typeLabel'),
  now: document.getElementById('now'),
  stop: document.getElementById('stop'),
  resume: document.getElementById('resume'),
};

let stopRequested = false;
let running = false;

async function getState() {
  return (await chrome.storage.local.get(BULK_KEY))[BULK_KEY] || null;
}

async function patchState(patch) {
  const cur = (await getState()) || {};
  const next = { ...cur, ...patch, runnerOpen: true, updatedAt: Date.now() };
  await chrome.storage.local.set({ [BULK_KEY]: next });
  return next;
}

function render(st) {
  if (!st) return;
  const total = Number(st.total) || (st.urls || []).length || 0;
  const index = Math.min(Number(st.index) || 0, total);
  const saved = Number(st.savedCount) || 0;
  const skipped = Number(st.skippedCount) || 0;
  const failed = Number(st.failedCount) || 0;
  const left = Math.max(0, total - index);
  if (els.saved) els.saved.textContent = String(saved);
  if (els.skipped) els.skipped.textContent = String(skipped);
  if (els.failed) els.failed.textContent = String(failed);
  if (els.left) els.left.textContent = String(left);
  if (els.fill) els.fill.style.width = total ? `${Math.round((index / total) * 100)}%` : '0%';
  if (els.now) els.now.textContent = st.status || '';
  if (els.typeLabel) els.typeLabel.textContent = st.pageTypeLabel || st.pageType || 'page';
  if (els.phase) els.phase.textContent = st.done ? 'done' : running ? 'running' : 'paused';
  if (els.stop) els.stop.style.display = running ? '' : 'none';
  if (els.resume) els.resume.style.display = running || st.done ? 'none' : '';
}

async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function run() {
  if (running) return;
  const start = await getState();
  if (!start || !Array.isArray(start.urls) || !start.urls.length) {
    els.now.textContent = 'No URLs queued. Close this window and Scan again.';
    return;
  }
  if (start.done) {
    running = false;
    render(start);
    return;
  }

  running = true;
  stopRequested = false;
  await patchState({ running: true, done: false, error: null, runnerOpen: true });
  render({ ...start, running: true });

  let tabId = start.tabId || null;
  let index = Math.max(0, Number(start.index) || 0);
  let savedCount = Number(start.savedCount) || 0;
  let failedCount = Number(start.failedCount) || 0;
  let skippedCount = Number(start.skippedCount) || 0;
  const urls = start.urls;
  const total = urls.length;

  for (; index < urls.length; index++) {
    if (stopRequested) break;
    const url = urls[index];
    const n = index + 1;
    let st = await patchState({
      running: true,
      done: false,
      index,
      tabId,
      status: `${n}/${total}: opening…`,
      savedCount,
      failedCount,
      skippedCount,
    });
    render(st);

    try {
      const r = await send({
        type: 'BULK_ONE',
        tabId,
        url,
        pageType: start.pageType,
        pageTypeLabel: start.pageTypeLabel,
        category: start.category,
        tags: start.tags,
        projectId: start.projectId,
        wantDesktop: !!start.wantDesktop,
        wantMobile: !!start.wantMobile,
      });
      if (r && r.tabId) tabId = r.tabId;
      if (stopRequested || (r && r.error === 'Stopped')) break;
      if (!r || !r.ok) throw new Error((r && r.error) || 'Save failed');
      if (r.skipped || r.duplicate) skippedCount += 1;
      else savedCount += 1;
      st = await patchState({
        index: index + 1,
        tabId,
        savedCount,
        failedCount,
        skippedCount,
        status: `${n}/${total}: ${r.duplicate || r.skipped ? 'already in archive' : 'saved'} ✓`,
      });
      render(st);
    } catch (e) {
      if (stopRequested || /stopped/i.test(String((e && e.message) || e))) break;
      failedCount += 1;
      st = await patchState({
        index: index + 1,
        tabId,
        savedCount,
        failedCount,
        skippedCount,
        status: `${n}/${total}: skipped (${String((e && e.message) || e).slice(0, 80)})`,
      });
      render(st);
    }
  }

  const stopped = stopRequested;
  const parts = [];
  if (savedCount) parts.push(`${savedCount} saved`);
  if (skippedCount) parts.push(`${skippedCount} already in archive`);
  if (failedCount) parts.push(`${failedCount} failed`);
  const summary = parts.length ? parts.join(', ') : 'Nothing saved';
  running = false;
  const done = !stopped;
  const st = await patchState({
    running: false,
    done,
    index,
    tabId,
    savedCount,
    failedCount,
    skippedCount,
    status: stopped ? `Stopped. ${summary}. Reopen Save to continue.` : `Done. ${summary}.`,
  });
  render(st);
  try {
    if (tabId) await chrome.tabs.remove(tabId);
  } catch {
    /* already closed */
  }
}

els.stop.addEventListener('click', () => {
  stopRequested = true;
  if (els.now) els.now.textContent = 'Stopping…';
  if (els.phase) els.phase.textContent = 'stopping';
  send({ type: 'BULK_STOP' }).catch(() => {});
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') els.stop && els.stop.click();
});

els.resume.addEventListener('click', () => {
  run();
});

window.addEventListener('beforeunload', () => {
  if (!running) return;
  chrome.storage.local.get(BULK_KEY).then((bag) => {
    const cur = bag[BULK_KEY] || {};
    if (cur.done) return;
    chrome.storage.local.set({
      [BULK_KEY]: {
        ...cur,
        running: false,
        done: false,
        runnerOpen: false,
        status: `Interrupted at ${cur.savedCount || 0}/${cur.total || '?'}. Reopen Save to continue.`,
        updatedAt: Date.now(),
      },
    });
  });
});

run().catch((e) => {
  const msg = String((e && e.message) || e);
  if (els.now) els.now.textContent = `Importer crashed: ${msg}`;
  if (els.phase) els.phase.textContent = 'error';
});
