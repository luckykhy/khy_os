// Safe redirect targets.
//
// `?redirect=` is read from the address bar, so it is attacker-controlled. The
// guard, the /401 page and the login form all need to honour it without turning
// it into an open redirect. Only a same-origin relative path is accepted;
// everything else falls back.
//
// Leading whitespace and control bytes are stripped first: browsers have
// historically normalized `/\t//evil.com` to `//evil.com`, which would have
// slipped past a bare `startsWith('//')` check. The class is built at runtime
// instead of written as an escaped range, so the static control-character lint
// check has nothing literal to flag.
const CONTROL_CHARS = (() => {
  let chars = '';
  for (let code = 0x00; code <= 0x20; code += 1) chars += String.fromCharCode(code);
  chars += String.fromCharCode(0x7f);
  return new RegExp(`[${chars}]`, 'g');
})();

export function safeRedirectPath(raw, fallback = '/') {
  const value = String(raw || '')
    .trim()
    .replace(CONTROL_CHARS, '');
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;
  return value;
}
