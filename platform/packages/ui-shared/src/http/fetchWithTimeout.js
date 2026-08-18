function abort(controller, reason) {
  try {
    controller.abort(reason);
  } catch {
    controller.abort();
  }
}

export function createRequestSignal({ signal, timeout = 0 } = {}) {
  const controller = new AbortController();
  let timer = null;

  if (signal) {
    if (signal.aborted) {
      abort(controller, signal.reason);
    } else {
      signal.addEventListener('abort', () => abort(controller, signal.reason), { once: true });
    }
  }

  if (Number.isFinite(timeout) && timeout > 0) {
    timer = setTimeout(() => {
      const reason =
        typeof DOMException === 'function'
          ? new DOMException('timeout', 'AbortError')
          : new Error('timeout');
      abort(controller, reason);
    }, timeout);
  }

  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const { timeout = 0, signal, ...requestOptions } = options;
  const requestSignal = createRequestSignal({ signal, timeout });
  try {
    return await fetchImpl(url, { ...requestOptions, signal: requestSignal.signal });
  } finally {
    requestSignal.dispose();
  }
}
