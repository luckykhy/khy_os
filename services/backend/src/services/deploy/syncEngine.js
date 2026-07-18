'use strict';

/**
 * syncEngine — copy a project source tree to a deployment target directory.
 *
 * Design rules:
 *  - Pure exclusion logic (`shouldExclude`) is separated from I/O so it can be
 *    unit-tested without touching disk.
 *  - All filesystem mutation goes through an injected `fs`-like object; tests
 *    drive it against an in-memory tree with zero real writes.
 *  - Safety: refuses to copy a directory into itself or into its own subtree
 *    (which would recurse infinitely / corrupt the source).
 *  - Transparency: returns a manifest of copied files and skipped entries.
 */

const path = require('path');

function defaultFs() {
  return require('fs');
}

/**
 * Default exclude patterns: build artifacts, VCS metadata, virtualenvs, caches
 * and logs that must never be shipped to a deployment target. These are matched
 * against the basename of each entry.
 */
const DEFAULT_EXCLUDES = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.cache',
  'dist',
  'build',
  'target',
  'coverage',
  '.DS_Store',
  '.idea',
  '.vscode',
];

/**
 * Decide whether an entry should be excluded from the copy.
 *
 * @param {string} relPath  Path relative to the source root (POSIX-ish).
 * @param {string} baseName Entry basename.
 * @param {Object} [opts]
 * @param {string[]} [opts.excludes]      Basenames to exclude.
 * @param {boolean} [opts.excludeDotfiles] Exclude entries starting with '.'.
 * @returns {boolean}
 */
function shouldExclude(relPath, baseName, opts = {}) {
  const excludes = opts.excludes || DEFAULT_EXCLUDES;
  if (excludes.includes(baseName)) return true;
  // Always drop log files and lockless tmp noise regardless of caller list.
  if (/\.log$/i.test(baseName)) return true;
  if (opts.excludeDotfiles && baseName.startsWith('.')) return true;
  return false;
}

/** True if `child` is the same as or nested under `parent`. */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Recursively copy `source` into `target`, applying exclusions.
 *
 * @param {string} source Absolute source directory.
 * @param {string} target Absolute target directory.
 * @param {Object} [opts]
 * @param {Object} [opts.fs]    Injected fs (existsSync/statSync/readdirSync/
 *                              mkdirSync/copyFileSync/readlinkSync/symlinkSync).
 * @param {string[]} [opts.excludes]
 * @param {boolean} [opts.excludeDotfiles]
 * @returns {{ copied: string[], skipped: string[], dirs: number, bytes: number }}
 */
function syncTree(source, target, opts = {}) {
  const fs = opts.fs || defaultFs();
  const src = path.resolve(source);
  const dst = path.resolve(target);

  if (!fs.existsSync(src)) {
    throw new Error(`部署源不存在: ${src}`);
  }
  if (src === dst) {
    throw new Error('部署源与目标相同，已拒绝（避免自我覆盖）');
  }
  if (isInside(src, dst)) {
    throw new Error(`部署目标位于源目录内部，已拒绝（避免递归拷贝）: ${dst}`);
  }

  const result = { copied: [], skipped: [], dirs: 0, bytes: 0 };

  const walk = (curSrc, curDst, rel) => {
    if (!fs.existsSync(curDst)) {
      fs.mkdirSync(curDst, { recursive: true });
      result.dirs += 1;
    }
    const entries = fs.readdirSync(curSrc);
    for (const name of entries) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (shouldExclude(childRel, name, opts)) {
        result.skipped.push(childRel);
        continue;
      }
      const childSrc = path.join(curSrc, name);
      const childDst = path.join(curDst, name);
      const st = fs.lstatSync(childSrc);
      if (st.isSymbolicLink()) {
        // Preserve symlinks verbatim rather than dereferencing them.
        try {
          const linkTarget = fs.readlinkSync(childSrc);
          if (fs.existsSync(childDst)) fs.rmSync(childDst, { force: true });
          fs.symlinkSync(linkTarget, childDst);
          result.copied.push(childRel);
        } catch {
          result.skipped.push(childRel);
        }
      } else if (st.isDirectory()) {
        walk(childSrc, childDst, childRel);
      } else if (st.isFile()) {
        fs.copyFileSync(childSrc, childDst);
        result.copied.push(childRel);
        result.bytes += typeof st.size === 'number' ? st.size : 0;
      }
    }
  };

  walk(src, dst, '');
  return result;
}

module.exports = {
  syncTree,
  shouldExclude,
  isInside,
  DEFAULT_EXCLUDES,
};
