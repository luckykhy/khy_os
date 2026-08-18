export function unwrapResponse(response) {
  const payload = response?.data;
  if (
    payload &&
    typeof payload === 'object' &&
    Object.prototype.hasOwnProperty.call(payload, 'success') &&
    Object.prototype.hasOwnProperty.call(payload, 'data')
  ) {
    return payload.data;
  }
  return payload ?? response;
}

export function getResponseErrorMessage(response, fallback = '') {
  const payload = response?.data;
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (payload && typeof payload === 'object') {
    const message = payload.message || payload.error;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
