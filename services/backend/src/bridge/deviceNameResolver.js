/**
 * deviceNameResolver — host-side, best-effort resolution of a connected
 * device's REAL name on the local network. Used by the LAN collaboration bridge
 * to pre-fill the forced device-naming dialog with something identifiable
 * ("小明的-MacBook" rather than a random client id) before falling back to a
 * generic platform name.
 *
 * Resolution cascade (highest → lowest confidence; first meaningful one wins):
 *   1. client UA Client Hints model (passed in by the browser)
 *   2. reverse DNS / PTR             — dns.reverse(ip)
 *   3. NetBIOS                       — nmblookup -A <ip> (Linux) / nbtstat -A (Win)
 *   4. mDNS / .local                 — avahi-resolve (Linux) / dscacheutil (macOS)
 *   5. UA-string model token
 * Pure selection logic lives in @khy/shared/deviceIdentity#pickRealName; this
 * module only performs the host I/O and feeds it the collected signals.
 *
 * Status transparency: every host probe is isolated (own try/catch + timeout +
 * tool-presence guard). A missing tool, a timeout, or an empty result simply
 * skips to the next source — this NEVER throws and NEVER fabricates a name.
 * Resolved `.local`/`.internal` names are DISPLAY-ONLY and must not flow into
 * any outbound request (they would trip ssrfGuard by design).
 *
 * @pattern Chain of Responsibility
 */
'use strict';

const dns = require('dns');
const { execFile } = require('child_process');
const { searchExecutable } = require('../tools/platformUtils');
const { pickRealName } = require('@khy/shared/deviceIdentity');

const DEFAULT_TIMEOUT_MS = 2500;

// ── Low-level helpers ──────────────────────────────────────────────────────

/** Normalize a remote address to a bare IP, or null if it is not IP-like. */
function _normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (!s) return null;
  if (s.startsWith('::ffff:')) s = s.slice(7); // IPv4-mapped IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;          // IPv4
  if (s.includes(':') && /^[0-9a-fA-F:]+$/.test(s)) return s; // IPv6 (loose)
  return null;
}

function _isV4Lan(ip) {
  return !!ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !/^127\./.test(ip);
}

function _isLoopback(ip) {
  return /^127\./.test(ip) || ip === '::1';
}

/** Race a promise against a timeout; resolves null on timeout/rejection. */
function _withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    if (timer.unref) timer.unref();
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } },
    );
  });
}

/**
 * Run a binary with an argv array (no shell → no injection surface) and a hard
 * timeout. Resolves stdout (possibly partial on timeout) or null on spawn error.
 */
function _run(cmd, args, ms) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: ms, windowsHide: true, encoding: 'utf-8' },
        (err, stdout) => { resolve(err ? (stdout || null) : (stdout || '')); });
    } catch {
      resolve(null);
    }
  });
}

// ── Parsers (exported for focused tests) ───────────────────────────────────

/** Parse the UNIQUE <00> name from nmblookup -A / nbtstat -A output. */
function parseNetbios(out) {
  const lines = String(out || '').split(/\r?\n/);
  for (const line of lines) {
    if (!/<00>/.test(line)) continue;
    if (/GROUP/i.test(line)) continue; // skip group entries (workgroup/browser)
    const m = line.match(/^\s*([^\s<]+)\s*<00>/);
    if (m && m[1] && m[1] !== '__MSBROWSE__') return m[1].trim();
  }
  return null;
}

/** Parse a hostname from `avahi-resolve -a <ip>` ("<ip>\t<name>"). */
function parseAvahi(out) {
  const line = String(out || '').trim().split(/\r?\n/)[0] || '';
  const parts = line.split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

/** Parse a hostname from macOS `dscacheutil -q host` ("name: <host>"). */
function parseDscacheutil(out) {
  const m = String(out || '').match(/name:\s*(\S+)/i);
  return m ? m[1].trim() : null;
}

/** Extract a model token from an Android user-agent string. */
function uaModelToken(userAgent) {
  const ua = String(userAgent || '');
  let m = ua.match(/Android[^;]*;\s*([^;)]+?)\s+Build\//i);
  if (m) return m[1].trim();
  m = ua.match(/;\s*([^;)]+?)\s+Build\//i);
  if (m) return m[1].trim();
  return '';
}

// ── Host probes ────────────────────────────────────────────────────────────

function _defaultDeps() {
  return {
    searchExecutable,
    reverse: (ip) => dns.promises.reverse(ip),
    run: _run,
    platform: process.platform,
  };
}

async function _reverseDns(ip, ms, deps) {
  const names = await _withTimeout(Promise.resolve().then(() => deps.reverse(ip)), ms);
  return Array.isArray(names) && names.length ? names[0] : null;
}

async function _netbios(ip, ms, deps) {
  const isWin = deps.platform === 'win32';
  const tool = isWin ? 'nbtstat' : 'nmblookup';
  if (!deps.searchExecutable(tool)) return null;
  const out = await deps.run(tool, ['-A', ip], ms);
  return out ? parseNetbios(out) : null;
}

async function _mdns(ip, ms, deps) {
  if (deps.platform === 'darwin') {
    if (!deps.searchExecutable('dscacheutil')) return null;
    const out = await deps.run('dscacheutil', ['-q', 'host', '-a', 'ip_address', ip], ms);
    return out ? parseDscacheutil(out) : null;
  }
  if (!deps.searchExecutable('avahi-resolve')) return null;
  const out = await deps.run('avahi-resolve', ['-a', ip], ms);
  return out ? parseAvahi(out) : null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve the best real device name for a connected client.
 *
 * @param {{ip?:string, userAgent?:string, hints?:object}} input
 * @param {{timeoutMs?:number, deps?:object}} [opts] - deps injectable for tests
 * @returns {Promise<{name:string, source:string}|null>} null when nothing
 *          identifiable was found (caller then uses a generic auto name).
 */
async function resolveRealName(input, opts) {
  const { ip, userAgent, hints } = input || {};
  const o = opts || {};
  const ms = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const deps = o.deps || _defaultDeps();

  const norm = _normalizeIp(ip);
  const wantHost = !!norm && !_isLoopback(norm);
  const wantLan = _isV4Lan(norm);

  // Run host probes concurrently to keep handshake latency low. Each guards
  // itself and resolves null on any failure — the cascade never rejects.
  const [ptr, nb, md] = await Promise.all([
    wantHost ? _reverseDns(norm, ms, deps).catch(() => null) : Promise.resolve(null),
    wantLan ? _netbios(norm, ms, deps).catch(() => null) : Promise.resolve(null),
    wantLan ? _mdns(norm, ms, deps).catch(() => null) : Promise.resolve(null),
  ]);

  // Assemble signals in priority order; pickRealName takes the first meaningful.
  const signals = [];
  const h = hints || {};
  if (h.model) signals.push({ source: 'hints', value: h.model });
  if (ptr) signals.push({ source: 'ptr', value: ptr });
  if (nb) signals.push({ source: 'netbios', value: nb });
  if (md) signals.push({ source: 'mdns', value: md });
  const uam = uaModelToken(userAgent);
  if (uam) signals.push({ source: 'ua', value: uam });

  return pickRealName(signals);
}

module.exports = {
  resolveRealName,
  // exported for focused tests
  parseNetbios,
  parseAvahi,
  parseDscacheutil,
  uaModelToken,
  _normalizeIp,
  _isV4Lan,
};
