export function resolveAuthGuard({
  requiresAuth = false,
  requiresAdmin = false,
  isAuthenticated = false,
  isAdmin = false,
  isGuestRoute = false,
  authenticatedRedirect = '/',
  adminRedirect = '/',
  loginRedirect = '/login',
  order = ['auth', 'admin', 'guest'],
} = {}) {
  const decisions = {
    auth: requiresAuth && !isAuthenticated ? loginRedirect : null,
    admin: requiresAdmin && !isAdmin ? adminRedirect : null,
    guest: isGuestRoute && isAuthenticated ? authenticatedRedirect : null,
  };

  for (const key of order) {
    if (decisions[key]) return decisions[key];
  }
  return null;
}
