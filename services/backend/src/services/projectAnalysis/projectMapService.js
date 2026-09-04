'use strict';

/**
 * projectMapService.js — Lightweight project structure analyzer.
 *
 * Generates a compact "project map" (directory tree + entry points + dependencies)
 * without reading file contents. Designed to fit within ~500 tokens so it can be
 * injected as context for AI analysis of large codebases.
 *
 * Key design: NEVER reads file contents — only directory listings and manifest
 * file metadata (package.json, pyproject.toml, etc.). This keeps the map small
 * while giving the AI enough information to know WHERE to look for details.
 *
 * Output format:
 *   [ProjectMap v1]
 *   Root: /path/to/project
 *   Type: node|python|mixed
 *   Entry: src/index.js, main.py, ...
 *   Deps: express, react, ...
 *   Tree (depth 3, max 80 nodes):
 *     src/
 *       index.js
 *       components/
 *         App.jsx
 *     ...
 *
 * @module services/projectAnalysis/projectMapService
 */

const fs = require('fs');
const path = require('path');

// ── Constants ───────────────────────────────────────────────────────────

const MAX_TREE_DEPTH = 3;
const MAX_TREE_NODES = 80;
const MAX_FILES_PER_DIR = 20;
const MAX_MANIFEST_DEPS = 30;
const MAX_FILE_SIZE_BYTES = 50 * 1024; // Skip files > 50KB for manifest reads

// Directories to always skip (never appear in tree)
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.eggs',
  '*.egg-info',
  '.mypy_cache',
  '.pytest_cache',
  '.idea',
  '.vscode',
  '.vs',
  'target', // Rust/Java
  'out',
  'bin',
  'obj',
  '.terraform',
  '.serverless',
]);

// Manifest files that reveal project structure
const MANIFEST_FILES = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'CMakeLists.txt',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  '.gitignore',
  'README.md',
  'tsconfig.json',
  'jsconfig.json',
];

// Entry point patterns (ordered by priority)
const ENTRY_PATTERNS = [
  // Node.js
  'src/index.js',
  'src/index.ts',
  'src/main.js',
  'src/main.ts',
  'src/app.js',
  'src/app.ts',
  'index.js',
  'index.ts',
  'main.js',
  'main.ts',
  'app.js',
  'app.ts',
  'server.js',
  'server.ts',
  // Python
  'main.py',
  'app.py',
  'manage.py',
  'wsgi.py',
  'asgi.py',
  'src/__main__.py',
  'src/main.py',
  'src/app.py',
  // Rust
  'src/main.rs',
  'src/lib.rs',
  // Go
  'main.go',
  'cmd/main.go',
  // Java
  'src/main/java/Main.java',
  // Generic
  'Makefile',
  'Dockerfile',
];

// ── Helpers ─────────────────────────────────────────────────────────────

function _shouldSkipDir(name) {
  if (SKIP_DIRS.has(name)) return true;
  // Skip hidden dirs (starting with .) except some known ones
  if (name.startsWith('.') && !['.github', '.vscode', '.idea'].includes(name)) return true;
  return false;
}

function _shouldSkipFile(name) {
  // Skip hidden files, lock files, and large binaries
  if (name.startsWith('.')) return true;
  if (name.endsWith('.lock') && name !== 'package-lock.json') return true;
  if (/\.(exe|dll|so|dylib|bin|dat|db|sqlite|class|jar|war|ear|pyc|pyo|whl|zip|tar|gz|rar|7z|jpg|jpeg|png|gif|bmp|ico|svg|mp3|mp4|avi|mov|woff|woff2|ttf|eot)$/.test(name)) {
    return true;
  }
  return false;
}

/**
 * Read a manifest file's metadata without loading full content.
 * For package.json: extract name, main, scripts keys, dependencies (top-level only).
 * For pyproject.toml: extract name, dependencies.
 * For others: just note existence.
 */
function _readManifestMeta(filePath, projectName) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      return { type: 'manifest', name: path.basename(filePath), truncated: true };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const baseName = path.basename(filePath);

    if (baseName === 'package.json') {
      const json = JSON.parse(content);
      const deps = [];
      if (json.dependencies) deps.push(...Object.keys(json.dependencies).slice(0, MAX_MANIFEST_DEPS));
      if (json.devDependencies) deps.push(...Object.keys(json.devDependencies).slice(0, 10));
      return {
        type: 'node',
        name: json.name || projectName,
        main: json.main || null,
        moduleType: json.type || 'commonjs',
        scripts: json.scripts ? Object.keys(json.scripts).slice(0, 8) : [],
        deps: [...new Set(deps)].slice(0, MAX_MANIFEST_DEPS),
        engines: json.engines || null,
      };
    }

    if (baseName === 'pyproject.toml') {
      // Simple TOML parsing for key fields
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      const depsMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      const deps = depsMatch
        ? depsMatch[1].match(/"[^"]+"/g)?.map((d) => d.replace(/"/g, '')).slice(0, MAX_MANIFEST_DEPS) || []
        : [];
      return {
        type: 'python',
        name: nameMatch ? nameMatch[1] : projectName,
        deps: deps.slice(0, MAX_MANIFEST_DEPS),
      };
    }

    if (baseName === 'Cargo.toml') {
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      return {
        type: 'rust',
        name: nameMatch ? nameMatch[1] : projectName,
      };
    }

    if (baseName === 'go.mod') {
      const moduleMatch = content.match(/module\s+(\S+)/);
      return {
        type: 'go',
        name: moduleMatch ? moduleMatch[1] : projectName,
      };
    }

    return { type: 'manifest', name: baseName };
  } catch {
    return null;
  }
}

/**
 * Build a compact directory tree string.
 */
function _buildTree(root, maxDepth, maxNodes) {
  const lines = [];
  let nodeCount = 0;

  function walk(dir, depth, prefix) {
    if (depth > maxDepth || nodeCount >= maxNodes) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then files, alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    let fileCount = 0;
    for (const entry of entries) {
      if (nodeCount >= maxNodes) break;

      const fullPath = path.join(dir, entry.name);
      const isDir = entry.isDirectory();

      if (isDir) {
        if (_shouldSkipDir(entry.name)) continue;
        lines.push(`${prefix}${entry.name}/`);
        nodeCount++;
        walk(fullPath, depth + 1, prefix + '  ');
      } else {
        if (_shouldSkipFile(entry.name)) continue;
        if (fileCount >= MAX_FILES_PER_DIR) {
          if (fileCount === MAX_FILES_PER_DIR) {
            lines.push(`${prefix}  ... (${entries.filter((e) => e.isFile()).length - MAX_FILES_PER_DIR} more files)`);
          }
          fileCount++;
          continue;
        }
        lines.push(`${prefix}${entry.name}`);
        nodeCount++;
        fileCount++;
      }
    }
  }

  walk(root, 0, '');
  return lines;
}

/**
 * Detect project type from manifest files.
 */
function _detectProjectType(root) {
  const types = [];
  if (fs.existsSync(path.join(root, 'package.json'))) types.push('node');
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'setup.py'))) types.push('python');
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) types.push('rust');
  if (fs.existsSync(path.join(root, 'go.mod'))) types.push('go');
  if (fs.existsSync(path.join(root, 'pom.xml'))) types.push('java');
  return types.length > 0 ? types.join('+') : 'unknown';
}

/**
 * Find entry points that exist in the project.
 */
function _findEntryPoints(root) {
  const found = [];
  for (const pattern of ENTRY_PATTERNS) {
    const fullPath = path.join(root, pattern);
    if (fs.existsSync(fullPath)) {
      found.push(pattern);
    }
  }
  return found;
}

/**
 * Count files by extension for a quick language breakdown.
 */
function _countFileTypes(root) {
  const counts = {};
  function walk(dir, depth) {
    if (depth > 2) return; // Only scan top 2 levels for speed
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (_shouldSkipDir(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else {
        const ext = path.extname(entry.name).toLowerCase() || '(no ext)';
        counts[ext] = (counts[ext] || 0) + 1;
      }
    }
  }
  walk(root, 0);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(', ');
}

// ── Main API ────────────────────────────────────────────────────────────

/**
 * Generate a compact project map.
 *
 * @param {string} root - Project root directory (default: cwd)
 * @param {object} [options]
 * @param {number} [options.maxDepth=3] - Max directory tree depth
 * @param {number} [options.maxNodes=80] - Max tree nodes
 * @param {boolean} [options.includeManifest=true] - Include manifest metadata
 * @param {boolean} [options.includeTree=true] - Include directory tree
 * @param {boolean} [options.includeStats=true] - Include file type stats
 * @returns {string} Compact project map text (~200-500 tokens)
 */
function generateProjectMap(root, options = {}) {
  const opts = {
    maxDepth: options.maxDepth || MAX_TREE_DEPTH,
    maxNodes: options.maxNodes || MAX_TREE_NODES,
    includeManifest: options.includeManifest !== false,
    includeTree: options.includeTree !== false,
    includeStats: options.includeStats !== false,
  };

  const resolvedRoot = path.resolve(root || process.cwd());
  const projectName = path.basename(resolvedRoot);

  const parts = ['[ProjectMap v1]'];
  parts.push(`Root: ${resolvedRoot}`);
  parts.push(`Type: ${_detectProjectType(resolvedRoot)}`);

  // Entry points
  const entries = _findEntryPoints(resolvedRoot);
  if (entries.length > 0) {
    parts.push(`Entry: ${entries.slice(0, 5).join(', ')}`);
  }

  // Manifest metadata
  if (opts.includeManifest) {
    for (const manifest of MANIFEST_FILES) {
      const manifestPath = path.join(resolvedRoot, manifest);
      if (fs.existsSync(manifestPath)) {
        const meta = _readManifestMeta(manifestPath, projectName);
        if (meta) {
          if (meta.deps && meta.deps.length > 0) {
            parts.push(`Deps: ${meta.deps.slice(0, 15).join(', ')}`);
          }
          if (meta.scripts && meta.scripts.length > 0) {
            parts.push(`Scripts: ${meta.scripts.join(', ')}`);
          }
          if (meta.main) {
            parts.push(`Main: ${meta.main}`);
          }
          break; // Only read the first manifest found
        }
      }
    }
  }

  // File type stats
  if (opts.includeStats) {
    const stats = _countFileTypes(resolvedRoot);
    if (stats) {
      parts.push(`Files: ${stats}`);
    }
  }

  // Directory tree
  if (opts.includeTree) {
    const treeLines = _buildTree(resolvedRoot, opts.maxDepth, opts.maxNodes);
    if (treeLines.length > 0) {
      parts.push('Tree:');
      parts.push(...treeLines.slice(0, opts.maxNodes));
      if (treeLines.length > opts.maxNodes) {
        parts.push(`... (${treeLines.length - opts.maxNodes} more nodes)`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Generate a focused map for a specific subdirectory.
 * Useful when the user wants to analyze a specific module.
 *
 * @param {string} subdir - Subdirectory path (relative to root or absolute)
 * @param {string} [root] - Project root (default: cwd)
 * @returns {string} Compact map of the subdirectory
 */
function generateSubdirMap(subdir, root) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const targetPath = path.isAbsolute(subdir) ? subdir : path.join(resolvedRoot, subdir);

  if (!fs.existsSync(targetPath)) {
    return `[ProjectMap v1] Error: "${subdir}" not found`;
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return `[ProjectMap v1] Error: "${subdir}" is not a directory`;
  }

  const relPath = path.relative(resolvedRoot, targetPath);
  const parts = [`[ProjectMap v1] Subdir: ${relPath}`];
  const treeLines = _buildTree(targetPath, MAX_TREE_DEPTH, MAX_TREE_NODES);
  if (treeLines.length > 0) {
    parts.push('Tree:');
    parts.push(...treeLines);
  }

  return parts.join('\n');
}

/**
 * Generate a minimal "index" — just entry points and key files.
 * Ultra-compact (~100 tokens) for when context budget is tight.
 *
 * @param {string} [root] - Project root (default: cwd)
 * @returns {string} Minimal project index
 */
function generateMiniMap(root) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const projectName = path.basename(resolvedRoot);
  const parts = ['[MiniMap]'];
  parts.push(`Type: ${_detectProjectType(resolvedRoot)}`);
  const entries = _findEntryPoints(resolvedRoot);
  if (entries.length > 0) {
    parts.push(`Entry: ${entries.slice(0, 3).join(', ')}`);
  }
  // Top-level files only
  let topFiles;
  try {
    topFiles = fs.readdirSync(resolvedRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && !_shouldSkipFile(e.name))
      .map((e) => e.name)
      .slice(0, 15);
  } catch {
    topFiles = [];
  }
  if (topFiles.length > 0) {
    parts.push(`Top: ${topFiles.join(', ')}`);
  }
  return parts.join('\n');
}

module.exports = {
  generateProjectMap,
  generateSubdirMap,
  generateMiniMap,
  // Exported for testing
  _detectProjectType,
  _findEntryPoints,
  _countFileTypes,
  _buildTree,
};
