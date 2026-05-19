// IndexedDB-backed persistent store for cloned/swiped HTML blobs.
//
// Why this exists:
// `src/lib/supabase-operations.ts` (`stripHtmlFromJsonb`) drops the raw `html`
// blob from `cloned_data` / `swiped_data` / `extracted_data` JSONB columns
// when it exceeds 50 KB, to avoid the Postgres `57014 statement_timeout` on
// the anon role. The store has a rehydrate-from-openclaw_messages fallback
// at boot, but it only works for the rewrite/extract flow which writes a
// `jobId` into `clonedData.jobId` / `swipedData.jobId`.
//
// The synchronous "Identical Clone" path goes straight through
// `/api/clone-funnel` and never lands in `openclaw_messages`, so it has no
// jobId and nothing to rehydrate from. After a single page reload the
// Translate tab shows "No HTML available", because `clonedData.html` is
// gone and there is no recovery path.
//
// This module persists the HTML in IndexedDB, keyed by (pageId, target),
// so it survives reloads. It's used as a last-resort rehydrate source
// after the Supabase round-trip strips the blob and after the
// openclaw_messages rehydrate has had its chance.

const DB_NAME = 'tool-wasabi-html-blobs';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

export type BlobTarget = 'clonedData' | 'swipedData' | 'extractedData';

export interface HtmlBlob {
  pageId: string;
  target: BlobTarget;
  html: string;
  mobileHtml?: string;
  savedAt: number;
}

type BlobKey = string;
function keyFor(pageId: string, target: BlobTarget): BlobKey {
  return `${pageId}::${target}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!isBrowser()) return Promise.reject(new Error('IndexedDB unavailable (SSR)'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

export async function saveHtmlBlob(
  pageId: string,
  target: BlobTarget,
  html: string,
  mobileHtml?: string,
): Promise<void> {
  if (!isBrowser() || !html) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record = {
        key: keyFor(pageId, target),
        pageId,
        target,
        html,
        mobileHtml,
        savedAt: Date.now(),
      };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('IndexedDB put failed'));
    });
  } catch (err) {
    console.warn(`[html-blob-store] save failed for ${pageId}/${target}:`, err);
  }
}

export async function loadHtmlBlob(
  pageId: string,
  target: BlobTarget,
): Promise<HtmlBlob | null> {
  if (!isBrowser()) return null;
  try {
    const db = await openDb();
    return await new Promise<HtmlBlob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(keyFor(pageId, target));
      req.onsuccess = () => {
        const row = req.result as (HtmlBlob & { key: BlobKey }) | undefined;
        if (!row || !row.html) {
          resolve(null);
          return;
        }
        resolve({
          pageId: row.pageId,
          target: row.target,
          html: row.html,
          mobileHtml: row.mobileHtml,
          savedAt: row.savedAt,
        });
      };
      req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
    });
  } catch (err) {
    console.warn(`[html-blob-store] load failed for ${pageId}/${target}:`, err);
    return null;
  }
}

export async function deleteHtmlBlob(pageId: string, target: BlobTarget): Promise<void> {
  if (!isBrowser()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(keyFor(pageId, target));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('IndexedDB delete failed'));
    });
  } catch (err) {
    console.warn(`[html-blob-store] delete failed for ${pageId}/${target}:`, err);
  }
}

export async function listHtmlBlobKeys(): Promise<BlobKey[]> {
  if (!isBrowser()) return [];
  try {
    const db = await openDb();
    return await new Promise<BlobKey[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAllKeys();
      req.onsuccess = () => resolve((req.result as BlobKey[]) || []);
      req.onerror = () => reject(req.error || new Error('IndexedDB getAllKeys failed'));
    });
  } catch {
    return [];
  }
}
