import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveCapabilities, splitAccount, getAuthCapabilities, resetAuthCapabilities } from './auth.js';

const mockGet = vi.fn();
vi.mock('./request', () => ({ default: { get: (...args) => mockGet(...args) } }));

// The whole point of this module is that the login page never guesses. The
// assertions below pin both halves of that contract: a partial server reply
// keeps the unsafe defaults, and a total outage degrades to the same shape.
describe('resolveCapabilities', () => {
  it('unwraps the apiResponse envelope', () => {
    const caps = resolveCapabilities({ data: { passwordLogin: true }, success: true });
    expect(caps.passwordLogin).toBe(true);
  });

  it('defaults to the least permissive shape when the server is unreachable', () => {
    const caps = resolveCapabilities(null);
    expect(caps.passwordLogin).toBe(true);
    expect(caps.defaultAdminAvailable).toBe(false);
    expect(caps.passwordReset).toEqual({ mode: 'none' });
    expect(caps.qrLogin.enabled).toBe(false);
  });

  it('fills only the missing keys from the fallback', () => {
    const caps = resolveCapabilities({ defaultAdminAvailable: true });
    expect(caps.defaultAdminAvailable).toBe(true);
    expect(caps.passwordReset).toEqual({ mode: 'none' });
    expect(caps.registration).toBe(false);
  });

  it('lets a real mode override the fallback, so the link actually appears', () => {
    const caps = resolveCapabilities({ passwordReset: { mode: 'security-question' } });
    expect(caps.passwordReset.mode).toBe('security-question');
  });
});

describe('splitAccount', () => {
  it('sends an address as email, since a username lookup would miss it', () => {
    expect(splitAccount('a@b.com')).toEqual({ email: 'a@b.com' });
  });

  it('sends anything without @ as username', () => {
    expect(splitAccount(' alice ')).toEqual({ username: 'alice' });
  });

  it('returns nothing for blank input', () => {
    expect(splitAccount('')).toEqual({});
    expect(splitAccount(null)).toEqual({});
  });
});

describe('getAuthCapabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthCapabilities();
  });

  it('hits /api/auth/capabilities once and silently', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: { passwordLogin: true } } });
    const caps = await getAuthCapabilities();
    expect(mockGet).toHaveBeenCalledWith('/api/auth/capabilities', { silent: true });
    expect(caps.passwordLogin).toBe(true);
  });

  it('reuses the cached promise across callers', async () => {
    mockGet.mockResolvedValueOnce({ data: { data: {} } });
    const [a, b] = await Promise.all([getAuthCapabilities(), getAuthCapabilities()]);
    expect(a).toBe(b);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('falls back instead of throwing when the endpoint is missing', async () => {
    mockGet.mockRejectedValueOnce(new Error('404'));
    const caps = await getAuthCapabilities();
    expect(caps.passwordReset).toEqual({ mode: 'none' });
    expect(caps.defaultAdminAvailable).toBe(false);
  });

  it('recovers after a reset', async () => {
    mockGet.mockRejectedValueOnce(new Error('down'));
    await getAuthCapabilities();
    resetAuthCapabilities();
    mockGet.mockResolvedValueOnce({ data: { data: { registration: true } } });
    expect((await getAuthCapabilities()).registration).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
