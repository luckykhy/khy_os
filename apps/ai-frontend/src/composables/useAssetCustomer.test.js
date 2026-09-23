import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the axios client so the composable can be tested in isolation
// (no real network). `@/api/unwrap` is kept REAL on purpose: it is a pure
// function and part of the contract under test (the composable must still
// unwrap exactly like it does in production).
vi.mock('@/api/request', () => {
  const request = {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    defaults: { baseURL: '' },
  };
  return { default: request };
});

import request from '@/api/request';
import { useAssetCustomer } from './useAssetCustomer';

const OVERVIEW_URL = '/api/ai-gateway/assets/overview';
const CUSTOMERS_URL = '/api/ai-gateway/customers';

const FAKE_OVERVIEW = { totalModels: 3, enabledModels: 2 };
const FAKE_CUSTOMERS = [
  { id: 'c-1', name: 'first' },
  { id: 'c-2', name: 'second' },
];

/** Shape a resolved axios response the way the real client does. */
function ok(payload) {
  return Promise.resolve({ data: { success: true, data: payload } });
}

/** Shape a rejected request with an HTTP-ish error body (axios style). */
function httpError(status, message) {
  return Promise.reject({ response: { status, data: { error: message } } });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('refreshAll — parallel sources', () => {
  it('both sources succeed: both states populated, no failures recorded, loading reset', async () => {
    request.get.mockImplementation((url) =>
      url === OVERVIEW_URL ? ok(FAKE_OVERVIEW) : ok(FAKE_CUSTOMERS)
    );

    const svc = useAssetCustomer();
    const result = await svc.refreshAll();

    expect(svc.overview.value).toEqual(FAKE_OVERVIEW);
    expect(svc.customers.value).toEqual(FAKE_CUSTOMERS);
    expect(svc.loadingOverview.value).toBe(false);
    expect(svc.loadingCustomers.value).toBe(false);
    expect(result.failed).toEqual([]);
  });

  it('only the secondary source (overview) fails: does NOT reject, primary data kept', async () => {
    request.get.mockImplementation((url) =>
      url === OVERVIEW_URL
        ? httpError(500, 'upstream overview unavailable')
        : ok(FAKE_CUSTOMERS)
    );

    const svc = useAssetCustomer();

    // This is the defect under repair: Promise.all used to reject here, and the
    // consumer's post-refresh auto-selection was skipped along with the error.
    const result = await svc.refreshAll(); // must not throw

    expect(result).toEqual(expect.any(Object));
    expect(svc.customers.value).toEqual(FAKE_CUSTOMERS);
    expect(svc.customers.value.length).toBe(2);
  });

  it('secondary failure is recorded with its source, status and message', async () => {
    request.get.mockImplementation((url) =>
      url === OVERVIEW_URL
        ? httpError(503, 'overview upstream 503')
        : ok(FAKE_CUSTOMERS)
    );

    const svc = useAssetCustomer();
    const result = await svc.refreshAll();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe('overview');
    expect(result.failed[0].status).toBe(503);
    expect(result.failed[0].message).toBe('overview upstream 503');
    // The primary result is still handed back, not swallowed.
    expect(result.customers).toEqual(FAKE_CUSTOMERS);
    expect(result.overview).toBeNull();
  });

  it('primary source (customers) fails: still rejects, consumer can report it', async () => {
    request.get.mockImplementation((url) =>
      url === OVERVIEW_URL ? ok(FAKE_OVERVIEW) : httpError(500, 'customers unavailable')
    );

    const svc = useAssetCustomer();

    // Guard against over-correction: the primary failure must NOT be swallowed,
    // otherwise an empty customer panel would show no error at all.
    await expect(svc.refreshAll()).rejects.toMatchObject({
      response: { status: 500 },
    });
  });

  it('primary failure keeps the already-loaded secondary data (no reverse loss)', async () => {
    request.get.mockImplementation((url) =>
      url === OVERVIEW_URL ? ok(FAKE_OVERVIEW) : httpError(500, 'customers unavailable')
    );

    const svc = useAssetCustomer();
    await expect(svc.refreshAll()).rejects.toBeDefined();

    // fetchOverview resolves before the primary rejects, so its state must
    // survive — degradation must not discard a sibling's already-settled data.
    expect(svc.overview.value).toEqual(FAKE_OVERVIEW);
  });

  it('both sources fail: still rejects (primary failure wins, no silent success)', async () => {
    request.get.mockImplementation(() => httpError(500, 'everything down'));

    const svc = useAssetCustomer();

    await expect(svc.refreshAll()).rejects.toBeDefined();
  });

  it('still passes includeSecrets / model through to the customers request', async () => {
    request.get.mockImplementation((url) =>
      url === OVERVIEW_URL ? ok(FAKE_OVERVIEW) : ok(FAKE_CUSTOMERS)
    );

    const svc = useAssetCustomer();
    await svc.refreshAll({ includeSecrets: true, model: 'gpt-x' });

    const customersCall = request.get.mock.calls.find((c) => c[0] === CUSTOMERS_URL);
    expect(customersCall).toBeDefined();
    expect(customersCall[1]).toEqual({ params: { includeSecrets: 'true', model: 'gpt-x' } });
    expect(request.get).toHaveBeenCalledWith(OVERVIEW_URL);
  });

  it('a failing source leaves no loading flag stuck on', async () => {
    request.get.mockImplementation((url) =>
      url === OVERVIEW_URL ? httpError(500, 'nope') : ok(FAKE_CUSTOMERS)
    );

    const svc = useAssetCustomer();
    await svc.refreshAll();

    expect(svc.loadingOverview.value).toBe(false);
    expect(svc.loadingCustomers.value).toBe(false);
  });
});
