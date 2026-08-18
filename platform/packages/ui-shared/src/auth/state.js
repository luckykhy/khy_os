export function parseStoredJson(rawValue, fallback = null) {
  if (!rawValue || typeof rawValue !== 'string') return fallback;
  try {
    return JSON.parse(rawValue);
  } catch {
    return fallback;
  }
}

export function hasAuthToken(token) {
  return Boolean(token);
}
