// Service endpoint single source of truth (SSOT).
//
// The first-party production backend domain lives HERE and ONLY here, so a
// domain migration or self-hosting changes exactly one line instead of leaving
// scattered modules pointing at a dead host. Every other module MUST import
// DEFAULT_BACKEND_URL from this file rather than hardcoding the literal — this
// is enforced by scripts/check-agent-rules.js (rule `no-hardcoded-prod-domain`,
// which exempts `constants/serviceDefaults.js` as the designated source of truth).
//
// Overridable at build time via Vite's VITE_BACKEND_URL environment variable.
export const DEFAULT_BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://khyquant.top'
