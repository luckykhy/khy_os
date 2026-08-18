/**
 * deviceIdentity — single source of truth for device classification and
 * device-name formatting, shared by the LAN bridge (services/backend) and the
 * web backend (services/ai-backend).
 *
 * Pure functions only: no I/O, no Node-only APIs, no runtime deps. Safe to run
 * in Node and (after the build's CJS→ESM interop) in the browser.
 *
 * Device-name format requested by product: `_<xx><label>` where `xx` is a short
 * user-chosen or auto-resolved name and `label` ∈ {手机, 平板, 电脑}.
 *
 * @pattern Strategy
 */
'use strict';

// Device type → Chinese label (the suffix in `_xx手机/电脑/平板`).
const LABELS = { phone: '手机', tablet: '平板', desktop: '电脑' };
const LABEL_VALUES = [LABELS.phone, LABELS.tablet, LABELS.desktop];

// Platform → display token used when falling back to a generic auto name.
const PLATFORM_DISPLAY = {
  android: 'Android',
  ios: 'iPhone',
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
  unknown: '本机',
};

const MAX_XX_LEN = 24;   // upper bound on the short-name part
const MAX_NAME_LEN = 40; // upper bound on the full `_xx label` string

function _s(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

// Control-character handling kept as code-point checks (no regex literals with
// raw control bytes in source). Control = U+0000..U+001F and U+007F (DEL).
function _isControlCode(c) {
  return c < 0x20 || c === 0x7f;
}
function _hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    if (_isControlCode(s.charCodeAt(i))) return true;
  }
  return false;
}
function _stripControlChars(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (!_isControlCode(s.charCodeAt(i))) out += s[i];
  }
  return out;
}

// ── Platform & type detection ─────────────────────────────────────────────

/**
 * Best-effort OS platform from a user-agent string and optional UA Client Hints.
 * @returns {'android'|'ios'|'windows'|'macos'|'linux'|'unknown'}
 */
function detectPlatform(userAgent, hints) {
  const ua = _s(userAgent);
  const h = hints || {};
  const chp = _s(h.platform).toLowerCase();
  if (chp) {
    if (chp.includes('android')) return 'android';
    if (chp.includes('ios')) return 'ios';
    if (chp.includes('win')) return 'windows';
    if (chp.includes('mac')) return 'macos';
    if (chp.includes('chrome os') || chp.includes('linux')) return 'linux';
  }
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/CrOS|X11|Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

/**
 * Classify a device into phone / tablet / desktop.
 *
 * iPadOS 13+ masquerades as "Macintosh"; we only treat such a device as a
 * tablet when the caller supplies `hints.touch === true` (the browser reports
 * touch points). UA Client Hints `hints.mobile` refines ambiguous desktops.
 *
 * @param {string} userAgent
 * @param {{platform?:string, mobile?:boolean, touch?:boolean, model?:string}} [hints]
 * @returns {{type:'phone'|'tablet'|'desktop', label:string, platform:string}}
 */
function classifyDevice(userAgent, hints) {
  const ua = _s(userAgent);
  const h = hints || {};
  const platform = detectPlatform(ua, h);

  const isAndroid = /Android/i.test(ua) || platform === 'android';
  const isIpad = /iPad/i.test(ua) || (platform === 'macos' && h.touch === true);
  const isAndroidTablet = isAndroid && (/Tablet/i.test(ua) || !/Mobile/i.test(ua));
  const isPhone =
    /iPhone|iPod/i.test(ua) ||
    (isAndroid && /Mobile/i.test(ua)) ||
    (platform === 'ios' && !isIpad);

  let type;
  if (isIpad || isAndroidTablet || /Tablet|PlayBook|Silk/i.test(ua)) {
    type = 'tablet';
  } else if (isPhone) {
    type = 'phone';
  } else if (h.mobile === true) {
    // UA-CH says mobile but UA string was inconclusive → treat as phone.
    type = 'phone';
  } else {
    type = 'desktop';
  }

  return { type, label: LABELS[type], platform };
}

// ── Name cleaning & formatting ─────────────────────────────────────────────

/** Strip control chars / illegal symbols / leading underscores; clamp length. */
function _sanitizeXx(xx) {
  let s = _stripControlChars(_s(xx).trim());
  s = s.replace(/^_+/, '');           // we own the leading underscore
  // Keep letters (any script), digits, dash, underscore, dot and spaces.
  s = s.replace(/[^\p{L}\p{N}\-_. ]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_XX_LEN) s = s.slice(0, MAX_XX_LEN).trim();
  return s;
}

/** Reduce a raw hostname/NetBIOS/mDNS name to a short, human-ish token. */
function _humanizeHost(raw) {
  let s = _s(raw).trim();
  if (!s) return '';
  s = s.replace(/\.(local|lan|home|internal|localdomain)\.?$/i, ''); // common LAN domains
  s = s.split('.')[0];        // drop any remaining domain labels
  s = s.replace(/\$+$/, '');  // NetBIOS unique-name trailing '$'
  return _sanitizeXx(s);
}

/**
 * Build the canonical `_<xx><label>` device name. Strips a duplicate label the
 * user may have typed, and clamps the whole string to MAX_NAME_LEN.
 */
function formatDeviceName(xx, label) {
  const lb = _s(label);
  let s = _sanitizeXx(xx);
  for (const known of LABEL_VALUES) {
    if (s.endsWith(known)) { s = s.slice(0, -known.length).trim(); break; }
  }
  let name = '_' + s + lb;
  if (name.length > MAX_NAME_LEN) {
    const room = Math.max(0, MAX_NAME_LEN - 1 - lb.length);
    name = '_' + s.slice(0, room).trim() + lb;
  }
  return name;
}

/**
 * Generic last-resort name derived only from platform + type, e.g.
 * `_iPhone手机`, `_Windows电脑`, `_本机电脑`.
 * @param {{platform?:string, label?:string}} info
 */
function autoDeviceName(info) {
  const i = info || {};
  const label = _s(i.label) || LABELS.desktop;
  const platform = _s(i.platform) || 'unknown';
  const disp = PLATFORM_DISPLAY[platform] || PLATFORM_DISPLAY.unknown;
  return formatDeviceName(disp, label);
}

// ── Real-name selection from collected signals ─────────────────────────────

const _UNINFORMATIVE = new Set(['localhost', 'unknown', 'ip', 'null', 'none']);

/** A name worth showing must be ≥2 chars, not IP-like, not pure-uninformative. */
function _isMeaningful(s) {
  if (!s || s.length < 2) return false;
  if (_UNINFORMATIVE.has(s.toLowerCase())) return false;
  if (/^\d{1,3}([.\-]\d{1,3}){3}$/.test(s)) return false; // looks like an IPv4
  if (/^\d+$/.test(s)) return false; // pure-numeric label (e.g. an IP octet) is not a name
  return true;
}

/**
 * Pick the best real device name from collected signals, in caller-supplied
 * priority order. Each signal is `{ source, value }` where `source` ∈
 * {'hints','ptr','netbios','mdns','ua', ...}. Hostname-like sources are
 * humanized; others are sanitized. Returns the first meaningful one or null.
 *
 * Pure: does NO I/O. The caller gathers signals (DNS/NetBIOS/UA-CH) and passes
 * them here so the selection logic stays testable.
 *
 * @param {Array<{source?:string, kind?:string, value?:string}>} signals
 * @returns {{name:string, source:string}|null}
 */
function pickRealName(signals) {
  const list = Array.isArray(signals) ? signals : [];
  for (const sig of list) {
    if (!sig) continue;
    const source = _s(sig.source || sig.kind);
    const cleaned = (source === 'ptr' || source === 'netbios' || source === 'mdns')
      ? _humanizeHost(sig.value)
      : _sanitizeXx(sig.value);
    if (_isMeaningful(cleaned)) return { name: cleaned, source };
  }
  return null;
}

/** Loose validity check for a stored/echoed device name. */
function isValidDeviceName(name) {
  const s = _s(name);
  if (!s || s.length > MAX_NAME_LEN) return false;
  if (_hasControlChar(s)) return false;
  return true;
}

module.exports = {
  LABELS,
  MAX_XX_LEN,
  MAX_NAME_LEN,
  detectPlatform,
  classifyDevice,
  formatDeviceName,
  autoDeviceName,
  pickRealName,
  isValidDeviceName,
  // exposed for focused unit tests
  _sanitizeXx,
  _humanizeHost,
};
