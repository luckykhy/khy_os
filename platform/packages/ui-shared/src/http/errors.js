export function isNetworkLikeError(error) {
  if (!error) return false;
  if (error.response) return false;

  const code = String(error.code || '').toUpperCase();
  if (['ECONNABORTED', 'ERR_NETWORK', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) {
    return true;
  }

  const message = String(error.message || '').toLowerCase();
  return (
    message.includes('network error') ||
    message.includes('failed to fetch') ||
    message.includes('timeout') ||
    message.includes('econnrefused')
  );
}
