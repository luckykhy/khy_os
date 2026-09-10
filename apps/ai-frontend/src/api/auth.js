import request from '@/api/request';

// Login capability discovery. Called once per session by the login surface; the
// result is cached because the server does not expose per-user information here.
//
// The fallback is deliberately the *least* permissive shape: if the backend is
// old or unreachable, the login page hides optional login methods and shows no
// recovery link, rather than rendering a button that 404s. That is the whole
// point of this endpoint — the frontend must never guess.
const FALLBACK_CAPABILITIES = {
  passwordLogin: true,
  registration: false,
  oauthProviders: [],
  qrLogin: { enabled: false, ttlSeconds: 0 },
  cliTokenLogin: false,
  webauthn: false,
  changePassword: false,
  securityQuestion: false,
  defaultAdminAvailable: false,
  passwordReset: { mode: 'none' },
  setupRequired: false,
};

let capabilitiesPromise = null;

// Pure on purpose: the envelope unwrap and the fail-soft default are the two
// things that would silently hide a missing login method, so they get their own
// unit tests instead of being buried inside the axios call.
export function resolveCapabilities(envelope) {
  const payload = envelope && typeof envelope.data === 'object' && envelope.data ? envelope.data : envelope;
  return { ...FALLBACK_CAPABILITIES, ...payload };
}

export function getAuthCapabilities() {
  if (!capabilitiesPromise) {
    capabilitiesPromise = request
      .get('/api/auth/capabilities', { silent: true })
      .then(({ data }) => resolveCapabilities(data))
      .catch(() => ({ ...FALLBACK_CAPABILITIES }));
  }
  return capabilitiesPromise;
}

// Recover the cache after a logout-driven config reload; login methods are a
// server property, not a user property, so this is normally never needed.
export function resetAuthCapabilities() {
  capabilitiesPromise = null;
}

// The reset endpoints build a Sequelize `where` from whichever of `username`
// and `email` is present, preferring the username clause. Sending an address as
// `username` would look up a user literally named "a@b.com" and miss.
export function splitAccount(raw) {
  const account = String(raw || '').trim();
  if (!account) return {};
  return account.includes('@') ? { email: account } : { username: account };
}
