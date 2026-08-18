import { normalizeToken } from '../auth/token.js';

export function createAuthHeaders(rawToken, headers = {}) {
  const nextHeaders = { ...headers };
  const token = normalizeToken(rawToken);
  const hasAuthorization = Object.keys(nextHeaders).some(
    (key) => key.toLowerCase() === 'authorization'
  );

  if (token && !hasAuthorization) {
    nextHeaders.Authorization = `Bearer ${token}`;
  }

  return nextHeaders;
}
