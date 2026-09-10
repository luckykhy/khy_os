// Single source of truth for role tiers and permission codes.
// Numeric tiers compare with >=, so SUPER_ADMIN outranks ADMIN by construction
// instead of each call site special-casing the name.
export const ROLE = Object.freeze({
  GUEST: 0,
  USER: 1,
  ADMIN: 10,
  SUPER_ADMIN: 100,
});

export const PERMISSIONS = Object.freeze([
  'channel.view',
  'channel.manage',
  'gateway.view',
  'gateway.manage',
  'billing.view',
  'billing.manage',
  'usage.view',
  'user.view',
  'user.manage',
  'eval.view',
  'eval.manage',
  'audit.view',
  'system.manage',
]);

// Role tiers that actually reach the frontend today: the backend hands back
// "admin" or nothing, and guest means "no token".
export const ROLE_LEVELS = Object.freeze({
  guest: ROLE.GUEST,
  user: ROLE.USER,
  admin: ROLE.ADMIN,
});

// Display names. Kept in the auth module so the sidebar, header dropdown and
// any future badge all read the same label instead of each inlining a ternary.
export const ROLE_LABELS = Object.freeze({
  guest: '游客',
  user: '普通用户',
  admin: '管理员',
});
