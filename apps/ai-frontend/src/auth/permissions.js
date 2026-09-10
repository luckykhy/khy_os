// Every authorization decision in the app goes through these helpers.
// Pages and the router must not compare role strings themselves.
import { ROLE, ROLE_LEVELS, ROLE_LABELS, PERMISSIONS } from './roles';

const LEVELS_BY_NAME = new Map(Object.entries(ROLE_LEVELS));
const LABELS_BY_NAME = new Map(Object.entries(ROLE_LABELS));
const PERM_SET = new Set(PERMISSIONS);

// The backend sends back "admin" for administrators and omits the field (or
// sends arbitrary casing/whitespace) for everyone else, so normalization is
// strict and total: anything unrecognized is treated as a normal user.
export function normalizeRole(user) {
  const raw = String((user && user.role) || '')
    .trim()
    .toLowerCase();
  return raw === 'admin' ? 'admin' : 'user';
}

// Accepts either a user object or a role name string, so callers can pass
// either a payload or a literal tier without branching.
export function roleLevel(user) {
  const name = typeof user === 'string' ? user.toLowerCase() : normalizeRole(user);
  const level = LEVELS_BY_NAME.get(name);
  return typeof level === 'number' ? level : ROLE.USER;
}

// Tier check: an admin also counts as a user, because the tiers are numeric and
// compared with >= rather than matched by name.
export function hasRole(user, minRole) {
  const floor = typeof minRole === 'number' ? minRole : roleLevel(minRole);
  return roleLevel(user) >= floor;
}

// Code check. The backend role payload does not carry a permission array yet,
// so an admin is granted every declared code and a normal user gets none.
// Unknown codes return false rather than passing through, so a typo in a call
// site fails closed instead of silently widening access.
export function can(user, permission) {
  if (!PERM_SET.has(permission)) return false;
  return hasRole(user, ROLE.ADMIN);
}

export function roleLabel(user) {
  return LABELS_BY_NAME.get(normalizeRole(user)) || ROLE_LABELS.user;
}

export function isAdmin(user) {
  return hasRole(user, ROLE.ADMIN);
}
