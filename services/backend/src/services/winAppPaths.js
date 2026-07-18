'use strict';

// Windows "App Paths" registry → installed-app discovery source — pure leaf
// (zero IO, zero business require, deterministic, fail-soft, env-gated).
//
// WHY THIS EXISTS (the real defect it fixes):
//   toolCalling.js `_getInstalledApps()` win32 branch only scans two Start-Menu
//   directories for `.lnk`/`.url` shortcuts. An app installed to a non-default
//   drive/dir (e.g. Quark at `D:\Users\…\AppData\Local\Programs\Quark\quark.exe`)
//   that registers no Start-Menu shortcut is therefore INVISIBLE to the matcher —
//   `_matchInstalledApp` returns null → "Application not found" → the model spins.
//
//   The authoritative SSOT for "where is <exe> installed" on Windows is the
//   registry key
//     HKCU/HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\<exe>
//   whose `(Default)` value is the absolute path to the executable. Quark (and
//   virtually every well-behaved installer) registers there even when it drops no
//   Start-Menu shortcut. This leaf parses `reg query … /s` output into the same
//   record shape the Start-Menu walk produces, so the existing matcher gains a
//   second discovery source with no new matching/launch logic.
//
//   IO (running `reg query`) stays in the thin shell (toolCalling.js); PARSING is
//   this pure leaf and is fully unit-testable against captured real `reg` output.
//
// Gate: KHY_APP_PATHS_REGISTRY (default ON). Off → win32 discovery falls back
// byte-identically to the Start-Menu-only scan.
//
// win32-only by nature: `reg` output only exists on Windows. The leaf itself is
// platform-agnostic (it just parses text), so it is testable on Linux/mac CI.

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const raw = env && env.KHY_APP_PATHS_REGISTRY;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// A registry key line for an App Paths entry ends with `\<name>.exe`. `reg query
// … /s` emits the full key path on its own line, e.g.:
//   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\quark.exe
// We only care about the trailing `\<exe>.exe` segment.
const KEY_EXE_RE = /\\([^\\]+\.exe)\s*$/i;

// A value line under a key looks like (note: reg indents with 4 spaces):
//   (Default)    REG_SZ    D:\Users\…\Quark\quark.exe
// On a zh-CN Windows the default value name is localized to `(默认)`. Either
// REG_SZ or REG_EXPAND_SZ may carry the path. We capture everything after the
// type token as the path (it may legitimately contain spaces).
const DEFAULT_VALUE_RE = /^\s*\((?:Default|默认)\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i;

/**
 * Parse `reg query …\App Paths /s` stdout into a flat list of
 * `{ exeName, exePath }` for every key that has a `(Default)` executable path.
 *
 * Keys whose name is not `*.exe`, or that carry no `(Default)` value, are
 * skipped. Fail-soft: non-string / empty input → `[]`.
 */
function parseAppPathsOutput(stdout) {
  const text = String(stdout == null ? '' : stdout);
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const out = [];
  let currentExe = '';

  for (const line of lines) {
    const keyMatch = line.match(KEY_EXE_RE);
    // A line that ends in `\<name>.exe` AND is not itself a value line is a key
    // header. (Value lines start with `(Default)`/`(默认)` or another value name
    // and won't end in `.exe` after the type token in practice.)
    if (keyMatch && !/^\s*\(/.test(line)) {
      currentExe = keyMatch[1];
      continue;
    }
    if (!currentExe) continue;
    const valMatch = line.match(DEFAULT_VALUE_RE);
    if (valMatch) {
      const exePath = valMatch[1].trim().replace(/^"+|"+$/g, '');
      if (exePath) out.push({ exeName: currentExe, exePath });
      // One default per key; reset so a stray later value line can't re-bind.
      currentExe = '';
    }
  }
  return out;
}

/**
 * Build installed-app records (same shape as the Start-Menu walk) from
 * `reg query` stdout. Deduped by `bin` (lowercased exe name without `.exe`);
 * first occurrence wins. Entries with an empty resolved path are skipped.
 *
 *   { name, nameCn:'', bin, exec, keywords:[], searchText, file, source }
 *
 * `name`/`bin` = exe name without `.exe`; `exec` = absolute exe path;
 * `searchText` = `"<bin> <exeName>"` lowercased (so the matcher can hit either
 * "quark" or "quark.exe").
 */
function buildAppPathRecords(stdout) {
  const entries = parseAppPathsOutput(stdout);
  const seen = new Set();
  const records = [];
  for (const { exeName, exePath } of entries) {
    const path = String(exePath || '').trim();
    if (!path) continue;
    const lowerExe = String(exeName || '').toLowerCase();
    const bin = lowerExe.replace(/\.exe$/i, '');
    if (!bin || seen.has(bin)) continue;
    seen.add(bin);
    records.push({
      name: bin,
      nameCn: '',
      bin,
      exec: path,
      keywords: [],
      searchText: `${bin} ${lowerExe}`.trim(),
      file: exeName,
      source: 'app-paths',
    });
  }
  return records;
}

module.exports = {
  isEnabled,
  parseAppPathsOutput,
  buildAppPathRecords,
};
