// Lightweight client-side "who am I" helper.
//
// The tool doesn't have auth yet — when the users table lands this
// helper should be replaced by a session lookup (or moved server-side
// entirely, in which case the run endpoint should ignore the body
// triggeredBy* fields). Until then, we let the user set their display
// name once and we cache it in localStorage so checkpoint logs show
// a meaningful person instead of "Owner".

const STORAGE_KEY = 'wasabi.checkpoint.userName';
const DEFAULT_NAME = 'Owner';

/** SSR-safe getter. Returns the persisted display name, or the
 *  default placeholder when nothing is set / when called on the server. */
export function getCurrentUserName(): string {
  if (typeof window === 'undefined') return DEFAULT_NAME;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored.trim().slice(0, 120);
  } catch {
    // localStorage might be blocked in private browsing — fall through.
  }
  return DEFAULT_NAME;
}

export function setCurrentUserName(name: string): void {
  if (typeof window === 'undefined') return;
  const trimmed = name.trim().slice(0, 120);
  try {
    if (trimmed.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // Same blocked-localStorage case.
  }
}
