// Pure-function leaf: localStorage wrappers that preserve the EXACT try/catch
// semantics of the existing "guarded" call sites.
//
// Scope note: this leaf only replaces call sites that ALREADY wrapped a single
// localStorage call in a try/catch whose behaviour is "swallow the failure"
// (guarded writes/removes) or "return null on failure" (guarded reads). It is
// deliberately NOT a drop-in for bare, unguarded `localStorage.getItem(...)`
// call sites whose intended semantics is to THROW on read failure — those must
// stay inline (a NOTE is left at such sites explaining the divergence).

// Guarded read: return the stored value, or null on any storage failure.
export function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Guarded write: attempt to store, silently ignoring any storage failure.
export function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

// Guarded remove: attempt to delete, silently ignoring any storage failure.
export function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// Shared storage key for the auth token. The runtime value MUST stay the string
// 'token' — this is a literal-convergence alias, not a storage-key change.
export const TOKEN_KEY = 'token';
