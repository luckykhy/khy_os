#!/usr/bin/env node
'use strict';

/**
 * check-f2e-wiring.js — 3-direction front-end ↔ back-end wiring audit.
 *
 * Verifies the wiring between each of the client surfaces and the Node
 * backend, so a runtime 404 / dead call is caught statically before it ships:
 *
 *   WEB    apps/ai-frontend      REST /api/*  (axios)  → backend route namespaces
 *   TUI    services/backend/src/cli  in-process service-layer `require` (CH-2)
 *   DESKTOP apps/khyos-desktop + electron/  IPC channels + endpoint source
 *
 * (MOBILE direction removed: apps/khy-mobile was an isolated ghost endpoint with
 *  no source — see [DESIGN-ARCH-120] §五. The surviving mobile client is the
 *  Flutter app apps/khy-os-client-app, which has no /api/* web source to audit.)
 *
 * Judgement per direction (see AGENTS.md 五通道决策矩阵):
 *   - WEB: every requested `/api/<ns>...` namespace must be a namespace
 *     the backend actually serves. Catches frontend calling a path the backend
 *     never mounts (→ 404 at runtime).
 *   - TUI: the main channel is same-process direct service-layer require, so the
 *     "wiring object" is the service module, not the route. Every
 *     `require('<...>/services/...')` from a CLI file must resolve to a real file
 *     (and, best-effort, export the named symbols being destructured).
 *   - DESKTOP: renderer `.invoke('ch')` channels must have a matching
 *     `ipcMain.handle('ch')`; and no production-domain endpoint may be hardcoded
 *     outside serviceDefaults/env (zero-hardcoding red line).
 *
 * Exit 0 = all directions clean (errors). Warnings are printed but do not
 * fail. Exit 1 = at least one direction has a hard gap.
 *
 * Usage:
 *   node scripts/ci/check-f2e-wiring.js            # audit all 3 directions
 *   node scripts/ci/check-f2e-wiring.js --verbose  # also list matched items
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const p = (...seg) => path.join(ROOT, ...seg);
const VERBOSE = process.argv.includes('--verbose');
const STRICT_EXPORTS = process.argv.includes('--strict-exports'); // also run TUI named-export warnings

// Backend registration files — the only places `/api/<ns>` mount literals live.
// Every mount style (app.use / a.use / mountOptional / app.get / inline
// `pathname === '/api/...'` dispatch) expresses its prefix as a '/api/X' literal,
// so scanning these for '/api/X' string literals captures the full served set.
const BACKEND_SERVER_FILES = [
  p('services', 'backend', 'server.js'),
  p('services', 'backend', 'src', 'services', 'aiManagementServer.js'),
  p('services', 'ai-backend', 'server.js'),
];

const PROD_DOMAIN = /khyquant\.(top|com|cn)\b/;

// ── shared: backend served-namespace inventory ─────────────────────
// Returns { namespaces: Set, literals: Array<{ns, file, line, text}> }
function collectBackendNamespaces() {
  const namespaces = new Set();
  const literals = [];
  const re = /(['"`])(\/api\/[^'"`?#]+)/g;
  for (const file of BACKEND_SERVER_FILES) {
    if (!fs.existsSync(file)) continue;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        const url = m[2];
        // Ignore catch-all '/api/*' — it is a 404 fallback, not a served namespace.
        const ns = url.replace(/^\/api\//, '').split('/')[0];
        if (!ns || ns === '*' || ns.includes('${')) continue;
        namespaces.add(ns);
        literals.push({ ns, file: rel(file), line: i + 1 });
      }
    });
  }
  return { namespaces, literals };
}

// Extract all '/api/...' path literals from a list of frontend files.
function collectApiPaths(dirs, exts) {
  const out = [];
  for (const d of dirs) {
    for (const f of listFiles(d, exts)) {
      fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        let m;
        const re = /(['"`])(\/api\/[^'"`?#]+)/g;
        while ((m = re.exec(line))) {
          const url = m[2];
          const ns = url.replace(/^\/api\//, '').split('/')[0];
          out.push({ url, ns, file: rel(f), line: i + 1 });
        }
      });
    }
  }
  return out;
}

// ── direction 1+2: WEB & MOBILE (REST namespace reachability) ──────
function checkRestDirection(label, sourceDirs, sourceExt, backendNamespaces, opts = {}) {
  const gaps = [];
  const warnings = [];
  const matched = [];
  const seen = new Set();
  const paths = collectApiPaths(sourceDirs, sourceExt);

  for (const c of paths) {
    // Optional per-direction ignore list (e.g. mobile third-party OpenAI /v1).
    if (opts.ignorePrefixes && opts.ignorePrefixes.some((pre) => c.url.startsWith(pre))) continue;
    if (c.ns && backendNamespaces.has(c.ns)) {
      matched.push(c);
    } else {
      gaps.push(c);
    }
  }

  return { label, gaps, warnings, matched, total: paths.length };
}

// ── direction 3: TUI service-layer require existence ───────────────
const _readCache = new Map();   // file path -> source (bound memory on repeated target reads)
const _exportCache = new Map();  // target path -> Set of export symbol names
function checkTui() {
  const gaps = [];      // unguarded require target that does not resolve (hard)
  const warnings = [];   // fail-soft (try/catch) optional module absent, or missing named export
  const matched = [];   // resolved OK
  const cliFiles = listFiles(p('services', 'backend', 'src', 'cli'), ['.js']);

  const RE_REQ = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

  for (const f of cliFiles) {
    const dir = path.dirname(f);
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      let m;
      RE_REQ.lastIndex = 0;
      while ((m = RE_REQ.exec(line))) {
        const spec = m[2];
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
        if (!spec.includes('services/')) continue;
        const resolved = resolveRequire(dir, spec);
        const exists = resolved && fs.existsSync(resolved);
        if (!exists) {
          // A require inside a nearby `try {` block is the documented CH-2 fail-soft
          // contract: the service is an optional degradation path, so an absent module
          // is acceptable, not a wiring defect. Downgrade to a warning.
          if (isTryGuarded(lines, i)) {
            warnings.push({ file: rel(f), line: i + 1, spec, kind: 'failsoft-optional-absent', detail: 'optional (fail-soft try/catch) service ' + spec + ' not present' });
          } else {
            gaps.push({ file: rel(f), line: i + 1, spec });
          }
          continue;
        }
        matched.push({ file: rel(f), line: i + 1, spec });
        // best-effort named-export check, opt-in via --strict-exports (the default
        // gate is "service module resolves to a real file" — that is the CH-2 wiring).
        if (!STRICT_EXPORTS) continue;
        const destruct = line.match(/\{\s*([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
        if (destruct) {
          const target = resolveRequire(dir, destruct[2]) || resolved;
          const names = destruct[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
          if (names.length && target) {
            const exports = exportKeys(target);
            const missing = names.filter((n) => !exports.has(n));
            if (missing.length) warnings.push({ file: rel(f), line: i + 1, spec: destruct[2], missing });
          }
        }
      }
    });
  }
  return { label: 'TUI (cli service-layer require)', gaps, warnings, matched, total: gaps.length + matched.length + warnings.length };
}

// True when the require on line `i` sits inside a `try { ... }` that opened within
// the few lines above (the CH-2 fail-soft require pattern).
function isTryGuarded(lines, i) {
  for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
    if (/try\s*\{/.test(lines[j])) return true;
  }
  return false;
}

// Parse a target module's exported symbol names once, cached.
function exportKeys(target) {
  if (_exportCache.has(target)) return _exportCache.get(target);
  const keys = new Set();
  const src = _readCache.get(target) || (_readCache.set(target, safeRead(target)), _readCache.get(target));
  if (src) {
    // `export const|function|class X`
    for (const em of src.matchAll(/\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) keys.add(em[1]);
    // `module.exports.X = ` / `exports.X = `
    for (const em of src.matchAll(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(em[1]);
    // `module.exports = { a, b, c }` object keys
    const obj = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\}/);
    if (obj) {
      for (const km of obj[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*(?::|=)/g)) keys.add(km[1]);
      // bare shorthand keys `a,` — only if the object has no `:` at all
      if (!/:/.test(obj[1])) {
        for (const km of obj[1].matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) keys.add(km[1]);
      }
    }
    // `Object.assign(exports, { ... })` and plain object re-exports
    for (const om of src.matchAll(/\bassign\([^,]+,\s*\{([\s\S]*?)\}\s*\)/g)) {
      for (const km of om[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*(?::|=)/g)) keys.add(km[1]);
    }
  }
  _exportCache.set(target, keys);
  return keys;
}

// Resolve a relative require from `dir` to an existing file path (or null).
// Tries every extension Node's CJS resolver would, so a module that exists as
// `.cjs` / `.mjs` / directory-index is not a false "missing" gap.
function resolveRequire(dir, spec) {
  const base = path.resolve(dir, spec);
  const exts = ['.js', '.cjs', '.mjs', '.json', '.node'];
  for (const e of exts) if (fs.existsSync(base + e)) return base + e;
  for (const e of exts) if (fs.existsSync(path.join(base, 'index' + e))) return path.join(base, 'index' + e);
  if (fs.existsSync(base)) return base;
  return null;
}

function safeRead(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

// Cheap static check that a named export symbol exists in the target's export surface.
// (Replaced by exportKeys() set-membership check; kept as documentation of intent.)


// ── direction 4: DESKTOP (IPC channel existence + endpoint source) ─
function checkDesktop() {
  const apps = [
    { label: 'khyos-desktop (new)', root: p('apps', 'khyos-desktop', 'src'), exts: ['.js', '.ts', '.vue'] },
    { label: 'electron (old)', root: p('electron'), exts: ['.js', '.ts', '.vue'] },
  ];
  const gaps = [];
  const warnings = [];
  const matched = [];

  const RE_HANDLE = /ipcMain\.handle\(\s*(['"`])([^'"`]+)\1/;
  const RE_INVOKE = /\.invoke\(\s*(['"`])([^'"`]+)\1/;
  const RE_ENDPOINT = /https?:\/\/[^\s'"`)]+/g;

  for (const app of apps) {
    if (!fs.existsSync(app.root)) continue;
    const files = listFiles(app.root, app.exts);
    const handles = new Set();
    const invokes = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const h = line.match(RE_HANDLE);
        if (h) handles.add(h[2]);
        const inv = line.match(RE_INVOKE);
        if (inv) invokes.push({ ch: inv[2], file: rel(f), line: i + 1 });
      });
    }
    // 4a. every invoke must have a handle
    for (const inv of invokes) {
      if (handles.has(inv.ch)) matched.push(inv);
      else gaps.push({ ...inv, app: app.label, kind: 'ipc-orphan-invoke', detail: '.invoke(' + inv.ch + ') has no ipcMain.handle(' + inv.ch + ')' });
    }
    // 4b. endpoint source: production domains / hardcoded host:port
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const trimmed = line.trim();
        if (/^\/?\/?\*?/.test(trimmed) && trimmed.length) {
          // skip pure comment lines for endpoint red-line (doc examples are exempt)
        }
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        for (const url of line.match(RE_ENDPOINT) || []) {
          // production domain hardcoded outside env/serviceDefaults → red line
          if (PROD_DOMAIN.test(url)) {
            const envOverridable = /process\.env\./.test(line) && /\|\|/.test(line);
            // env-overridable defaults to a production domain are STILL a red line
            // per AGENTS.md (生产域名 env 回退不豁免) — only serviceDefaults.js is the
            // sanctioned source. Flag unless the file is the SSOT or env-var driven.
            const inServiceDefaults = /serviceDefaults\.js/.test(f);
            if (!inServiceDefaults && !isComment) {
              gaps.push({ app: app.label, file: rel(f), line: i + 1, kind: 'prod-domain-hardcoded', detail: "hardcoded production domain '" + url + "' — must come from constants/serviceDefaults.js or env" });
            }
          }
          // hardcoded host:port (non-localhost, non-dev) without env/variable → warning
          else if (/\d{2,5}\/|:\d{2,5}\b/.test(url) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url) && !/process\.env\./.test(line)) {
            warnings.push({ app: app.label, file: rel(f), line: i + 1, kind: 'endpoint-not-env', detail: 'endpoint ' + url + ' is not derived from env/serviceDefaults' });
          }
        }
      });
    }
  }
  return { label: 'DESKTOP (IPC + endpoint source)', gaps, warnings, matched, total: matched.length + gaps.length };
}

// ── helpers ────────────────────────────────────────────────────────
function rel(f) {
  return f.replace(ROOT + path.sep, '').replace(/\\/g, '/');
}
// Fail-soft optional-module warnings repeat per call site; collapse to one line per
// (file, spec) keeping the first line number, so the report stays readable.
function dedupeWarnings(warnings) {
  const seen = new Map();
  for (const w of warnings) {
    const key = w.kind === 'failsoft-optional-absent' ? w.file + '\u0000' + w.spec : JSON.stringify(w);
    if (!seen.has(key)) seen.set(key, w);
  }
  return [...seen.values()];
}
function listFiles(dir, exts) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'out', 'release', 'build', '__tests__', 'test', '.dart_tool', 'linux-bin', 'android', 'public'].includes(e.name)) continue;
      out.push(...listFiles(full, exts));
    } else if (exts.includes(path.extname(full))) {
      out.push(full);
    }
  }
  return out;
}

// ── main ───────────────────────────────────────────────────────────
function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];

  const backend = collectBackendNamespaces();

  const web = checkRestDirection(
    'WEB (ai-frontend /api/*)',
    [p('apps', 'ai-frontend', 'src', 'api')],
    ['.js'],
    backend.namespaces,
  );

  // mobile direction removed: apps/khy-mobile is an isolated ghost endpoint
  // (0 git-tracked files, source lost — see [DESIGN-ARCH-120] §五). The surviving
  // mobile client is the Flutter app apps/khy-os-client-app, which has no /api/*
  // web source to audit here.

  let tui = { label: 'TUI (cli service-layer require)', gaps: [], warnings: [], matched: [], total: 0, skipped: true };
  if (!only || only === 'tui') tui = checkTui();

  let desktop = { label: 'DESKTOP (IPC + endpoint source)', gaps: [], warnings: [], matched: [], total: 0, skipped: true };
  if (!only || only === 'desktop') desktop = checkDesktop();

  const directions = [web, tui, desktop].filter((d) => !only || !d.skipped || d.label.toLowerCase().includes(only));

  console.log('Front-end ↔ Back-end Wiring Audit (3 directions)');
  console.log('=================================================');
  console.log('  Backend served namespaces: ' + backend.namespaces.size);
  for (const d of directions) {
    const g = d.gaps.length;
    const w = (d.warnings || []).length;
    console.log('  ' + d.label + ': ' + (g === 0 ? 'OK' : g + ' gap(s)') + (w ? ' + ' + w + ' warning(s)' : '') + (d.total ? '  (' + d.total + ' items)' : ''));
  }
  console.log('');

  let anyGap = false;
  for (const d of directions) {
    console.log('── ' + d.label + ' ' + '─'.repeat(Math.max(0, 50 - d.label.length)));
    if (VERBOSE && d.matched && d.matched.length) {
      console.log('  matched (' + d.matched.length + '):');
      for (const m of d.matched.slice(0, 60)) {
        console.log('    ✓ ' + (m.url ? m.url : m.spec ? m.spec : m.ch) + '   [' + m.file + ':' + m.line + ']');
      }
      if (d.matched.length > 60) console.log('    ... and ' + (d.matched.length - 60) + ' more');
      console.log('');
    }
    for (const w of dedupeWarnings(d.warnings)) {
      const desc = w.kind === 'ipc-orphan-invoke' ? w.detail
        : w.kind === 'endpoint-not-env' ? w.detail
        : w.kind === 'failsoft-optional-absent' ? w.detail
        : w.missing ? 'missing export(s) ' + w.missing.join(', ') + ' in ' + w.spec : 'warning ' + w.file;
      console.log('  ⚠ [warn] ' + desc + '   [' + w.file + ':' + w.line + ']');
    }
    if (d.gaps.length) {
      anyGap = true;
      console.log('  gaps (' + d.gaps.length + '):');
      for (const g of d.gaps) {
        if (g.kind) {
          console.log('  ✗ [' + g.kind + '] ' + g.detail + '   [' + g.app + ' ' + g.file + ':' + g.line + ']');
        } else if (g.spec) {
          console.log('  ✗ TUI require ' + g.spec + ' does not resolve to a file   [' + g.file + ':' + g.line + ']');
        } else {
          console.log('  ✗ ' + g.url + ' — backend has no mount for namespace "' + g.ns + '"   [' + g.file + ':' + g.line + ']');
        }
      }
    } else if (!d.warnings || d.warnings.length === 0) {
      console.log('  (clean)');
    }
    console.log('');
  }

  if (anyGap) {
    console.log('WIRING GAPS FOUND across ' + directions.filter((d) => d.gaps.length).map((d) => d.label).join(', '));
    process.exit(1);
  }
  console.log('All 3 directions wired correctly.');
  process.exit(0);
}

main();
