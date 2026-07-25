'use strict';

/**
 * Scaffold spec extraction — parses user messages for project
 * directory/file structure specifications.
 *
 * Extracted from toolUseLoop.js (lines 4553-4649) as part of the
 * industrial-grade modularization (Phase 1C).
 *
 * Dependencies: path (Node built-in).
 */

const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(max, n);
}

function unwrapPastedContent(raw = '') {
  return String(raw || '').replace(/<pasted-content>\n([\s\S]*?)\n<\/pasted-content>/g, '$1').trim();
}

function looksLikeFilePathToken(token = '') {
  const t = String(token || '').trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[A-Za-z]:\\?$/.test(t)) return false;
  if (/[<>*?|]/.test(t)) return false;
  if (/[\\/]/.test(t)) return true;
  return /\.[a-zA-Z0-9]{1,10}$/.test(t);
}

function looksLikeDirectoryToken(token = '') {
  const t = String(token || '').trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!t) return false;
  if (/[<>*?|]/.test(t)) return false;
  if (/[\\/]\s*$/.test(t)) return true;
  if (!/[\\/]/.test(t)) return false;
  return !/\.[a-zA-Z0-9]{1,10}$/.test(t);
}

// ── Main extraction ──────────────────────────────────────────────────

function extractScaffoldSpecFromMessage(userMessage, options = {}) {
  const raw = unwrapPastedContent(userMessage);
  if (!raw) return null;

  const defaultConcurrency = parsePositiveInt(options.defaultConcurrency, 4, 1, 16);
  const maxFiles = parsePositiveInt(options.maxFiles, 120, 1, 500);
  const maxDirs = parsePositiveInt(options.maxDirs, 160, 1, 500);

  let root = '.';
  const explicitRoot = raw.match(/(?:^|\s)(?:root|cwd|目录|路径)\s*[:=：]\s*([^\s,，;；]+)/i);
  if (explicitRoot && explicitRoot[1]) root = explicitRoot[1].trim();

  const dirs = new Set();
  const files = new Map();
  const addDir = (value) => {
    const d = String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/[\\/]+$/g, '');
    if (!d || d === '.' || d === './') return;
    if (dirs.size < maxDirs) dirs.add(d);
  };
  const addFile = (filePath, content = '') => {
    const f = String(filePath || '').trim().replace(/^['"`]+|['"`]+$/g, '');
    if (!f) return;
    if (!files.has(f) && files.size < maxFiles) files.set(f, String(content || ''));
  };

  const inlineCodeTokens = [...raw.matchAll(/`([^`]+)`/g)].map(m => String(m[1] || '').trim()).filter(Boolean);
  for (const token of inlineCodeTokens) {
    if (looksLikeFilePathToken(token)) addFile(token);
    else if (looksLikeDirectoryToken(token)) addDir(token);
  }

  const lines = raw.split('\n').map(s => String(s || '').trim()).filter(Boolean);
  for (const lineRaw of lines) {
    const line = lineRaw
      .replace(/^\s*(?:[-*+•]|\d+[.)]|[└├│])\s*/g, '')
      .trim();
    if (!line) continue;

    const pair = line.match(/^([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,10})\s*(?::|=>)\s*([\s\S]*)$/);
    if (pair && pair[1]) {
      addFile(pair[1], pair[2] || '');
      continue;
    }

    if (line.endsWith('/') || line.endsWith('\\')) {
      addDir(line);
      continue;
    }

    if (looksLikeFilePathToken(line)) {
      addFile(line);
      continue;
    }

    if (looksLikeDirectoryToken(line)) {
      addDir(line);
      continue;
    }
  }

  for (const filePath of files.keys()) {
    const parent = path.dirname(filePath);
    if (parent && parent !== '.' && parent !== filePath) addDir(parent);
  }

  if (dirs.size === 0 && files.size === 0) return null;
  return {
    root,
    directories: [...dirs],
    files: [...files.entries()].map(([p, c]) => ({ path: p, content: c })),
    overwrite: false,
    writeConcurrency: defaultConcurrency,
  };
}

module.exports = {
  extractScaffoldSpecFromMessage,
  looksLikeFilePathToken,
  looksLikeDirectoryToken,
  unwrapPastedContent,
  parsePositiveInt,
};
