'use strict';

/**
 * projectState.js — pure project-version-state reader for the publish pipeline.
 *
 * This module was carved out of the cli/handlers/publish.js god-file (B1 split)
 * as the first cohesive, side-effect-light seam: locating the project root and
 * parsing the version-bearing manifests (pyproject.toml, the Python package
 * __init__.py, and the backend package.json). It depends only on fs/path and
 * its own layout constants — no CLI presentation, no child_process, no other
 * publish helpers — so it lives in the services layer where pure logic belongs.
 *
 * publish.js imports these symbols back under their original names, so every
 * existing call site is unchanged; a cli module requiring a service is a normal
 * downward dependency. The remote subsystem (services/remote) can also source
 * _findProjectRoot/_readState from here instead of reaching up into the CLI.
 */

const fs = require('fs');
const path = require('path');

const PYPROJECT_PATH = 'pyproject.toml';
// Version-bearing files. The `restructure/full-forest` layout moved the Python
// package under platform/ and the backend under services/, so each is resolved
// against an ordered candidate list (preferred → legacy) to support both
// layouts. The first candidate is the canonical path used for new writes/labels.
const PYTHON_INIT_CANDIDATES = [
  path.join('platform', 'khy_platform', '__init__.py'),
  path.join('khy_platform', '__init__.py'),
];
const BACKEND_PKG_CANDIDATES = [
  path.join('services', 'backend', 'package.json'),
  path.join('backend', 'package.json'),
];
// npm channel manifest (@khy-os/khy-os). This is the THIRD version-sync red-line
// source enforced by scripts/ci/check-version-sync.js (alongside pyproject.toml
// and services/backend/package.json); a version bump that skips it makes
// check:version-sync fail. Resolved via the same candidate-list pattern for
// layout-compat, though today only the forest path exists.
const NPM_PKG_CANDIDATES = [
  path.join('packaging', 'npm', 'package.json'),
];

function _findProjectRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    const hasPyproject = fs.existsSync(path.join(current, PYPROJECT_PATH));
    const hasSetup = fs.existsSync(path.join(current, 'setup.py'));
    if (hasPyproject || hasSetup) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

// Resolve the first candidate that exists under projectRoot. When none exists
// (e.g. a fresh checkout missing the file), the first candidate is returned as
// the canonical default so writes/error labels still point at the preferred
// layout. Returns a path relative to projectRoot.
function _resolveExisting(projectRoot, candidates) {
  for (const rel of candidates) {
    if (fs.existsSync(path.join(projectRoot, rel))) return rel;
  }
  return candidates[0];
}

function _readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function _extractProjectBlock(pyprojectContent = '') {
  const m = String(pyprojectContent).match(/\[project\]([\s\S]*?)(?:\n\[[^\n]+\]|$)/);
  return m ? m[1] : '';
}

function _extractProjectField(pyprojectContent, key) {
  const block = _extractProjectBlock(pyprojectContent);
  if (!block) return '';
  const re = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, 'm');
  const m = block.match(re);
  return m ? String(m[1] || '').trim() : '';
}

function _readState(projectRoot) {
  const pyprojectFile = path.join(projectRoot, PYPROJECT_PATH);
  const pyproject = _readFileSafe(pyprojectFile);
  const packageName = _extractProjectField(pyproject, 'name');
  const pyVersion = _extractProjectField(pyproject, 'version');

  const pyInitFile = path.join(projectRoot, _resolveExisting(projectRoot, PYTHON_INIT_CANDIDATES));
  const pyInit = _readFileSafe(pyInitFile);
  const pyInitVersionMatch = pyInit.match(/^\s*__version__\s*=\s*["']([^"']+)["']\s*$/m);
  const pyInitVersion = pyInitVersionMatch ? String(pyInitVersionMatch[1]).trim() : '';

  const backendPkgFile = path.join(projectRoot, _resolveExisting(projectRoot, BACKEND_PKG_CANDIDATES));
  let backendVersion = '';
  try {
    const parsed = JSON.parse(_readFileSafe(backendPkgFile) || '{}');
    backendVersion = String(parsed.version || '').trim();
  } catch { /* ignore */ }

  const versions = [pyVersion, pyInitVersion, backendVersion].filter(Boolean);
  const versionAligned = versions.length > 0 && versions.every(v => v === versions[0]);

  return {
    projectRoot,
    packageName,
    versions: {
      pyproject: pyVersion,
      python: pyInitVersion,
      backend: backendVersion,
    },
    versionAligned,
  };
}

function _isLikelyVersion(version) {
  // Practical release format for this CLI (simple + predictable):
  // 0.1.0 / 1.2.3 / 1.2.3rc1 / 1.2.3.post1 / 1.2.3.dev1
  return /^\d+(?:\.\d+){1,3}(?:[abrc]\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/i.test(String(version || '').trim());
}

module.exports = {
  PYPROJECT_PATH,
  PYTHON_INIT_CANDIDATES,
  BACKEND_PKG_CANDIDATES,
  NPM_PKG_CANDIDATES,
  _findProjectRoot,
  _resolveExisting,
  _readFileSafe,
  _extractProjectBlock,
  _extractProjectField,
  _readState,
  _isLikelyVersion,
};
