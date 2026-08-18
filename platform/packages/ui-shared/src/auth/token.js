export function normalizeToken(rawToken) {
  if (!rawToken) return '';

  let token = rawToken;
  if (typeof token === 'object') {
    token = token.token || token.value || token.data?.token || '';
  }

  if (typeof token !== 'string') return '';
  return token.replace(/^Bearer\s+/i, '').trim();
}
