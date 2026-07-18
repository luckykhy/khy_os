'use strict';

/**
 * documentSnippetService.js
 *
 * Lightweight PDF snippet extraction for multimodal prompt augmentation.
 * Priority:
 * 1) pdftotext (best quality for text PDFs)
 * 2) python3 + pypdf (optional fallback)
 * 3) strings (last-resort heuristic)
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const { searchExecutable } = require('../tools/platformUtils');
const ocrSnippet = require('./ocrSnippetService');

const PDF_SNIPPET_MAX_BYTES = Math.max(
  2 * 1024 * 1024,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_SNIPPET_MAX_BYTES || String(24 * 1024 * 1024)), 10) || (24 * 1024 * 1024)
);
const PDF_SNIPPET_MAX_CHARS = Math.max(
  600,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_SNIPPET_MAX_CHARS || '2400'), 10) || 2400
);
const PDF_SNIPPET_MAX_PAGES = Math.max(
  1,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_SNIPPET_MAX_PAGES || '8'), 10) || 8
);
const PDF_SNIPPET_PER_PAGE_MAX_CHARS = Math.max(
  120,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_SNIPPET_PER_PAGE_MAX_CHARS || '480'), 10) || 480
);
const PDF_KEYPOINT_MODE_ENABLED = !['0', 'false', 'off'].includes(
  String(process.env.KHY_MULTIMODAL_PDF_KEYPOINT_MODE || 'true').trim().toLowerCase()
);
const PDF_KEYPOINTS_PER_PAGE = Math.max(
  1,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_KEYPOINTS_PER_PAGE || '2'), 10) || 2
);
const PDF_KEYPOINT_MIN_LINE_CHARS = Math.max(
  8,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_KEYPOINT_MIN_LINE_CHARS || '14'), 10) || 14
);
const PDF_SNIPPET_TIMEOUT_MS = Math.max(
  1200,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_SNIPPET_TIMEOUT_MS || '4500'), 10) || 4500
);
const PDF_SNIPPET_TOTAL_BUDGET_MS = Math.max(
  1600,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_SNIPPET_TOTAL_BUDGET_MS || '6200'), 10) || 6200
);
const PDF_LARGE_FILE_MB = Math.max(
  2,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_LARGE_FILE_MB || '10'), 10) || 10
);
const PDF_LARGE_MAX_PAGES = Math.max(
  1,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_LARGE_MAX_PAGES || '3'), 10) || 3
);
const PDF_PAGE_LABEL_ENABLED = !['0', 'false', 'off'].includes(
  String(process.env.KHY_MULTIMODAL_PDF_PAGE_LABEL_ENABLED || 'true').trim().toLowerCase()
);
const PDF_OCR_FALLBACK_ENABLED = !['0', 'false', 'off'].includes(
  String(process.env.KHY_MULTIMODAL_PDF_OCR_FALLBACK || 'true').trim().toLowerCase()
);
const PDF_OCR_MIN_TEXT_CHARS = Math.max(
  20,
  parseInt(String(process.env.KHY_MULTIMODAL_PDF_OCR_MIN_TEXT_CHARS || '120'), 10) || 120
);

// 收敛到 utils/safeStatSync 单一真源(逐字节委托,调用点不变)
const _safeStat = require('../utils/safeStatSync');

function _truncate(text = '', maxChars = PDF_SNIPPET_MAX_CHARS) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n...[truncated]`;
}

function _normalizeExtractedText(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function _truncateInline(text = '', maxChars = PDF_SNIPPET_PER_PAGE_MAX_CHARS) {
  const normalized = _normalizeExtractedText(text);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)} ...`;
}

function _normalizeLineKey(line = '') {
  return String(line || '')
    .toLowerCase()
    .replace(/[ \t\r\n`~!@#$%^&*()\-_=+\[\]{}|;:'",.<>/?！？。；：，、（）【】《》“”‘’·…]/g, '')
    .trim();
}

function _isNoiseLine(line = '') {
  const text = String(line || '').trim();
  if (!text) return true;
  if (/^(page\s*)?\d+(\s*\/\s*\d+)?$/i.test(text)) return true;
  if (/^\d+\s*$/.test(text)) return true;
  if (/^(confidential|copyright|all rights reserved)/i.test(text)) return true;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^[\-=*_#]{4,}$/.test(text)) return true;
  return false;
}

function _isHeadingLine(line = '') {
  const text = String(line || '').trim();
  if (!text) return false;
  if (/^(\d+(\.\d+){0,3}|[一二三四五六七八九十]+)[\.\s、:：)]\S+/.test(text)) return true;
  if (/^(摘要|概述|背景|结论|建议|风险|计划|目标|结果|总结|说明)[:：]?$/i.test(text)) return true;
  const alphaOnly = text.replace(/[^A-Za-z ]/g, '').trim();
  if (alphaOnly.length >= 4 && alphaOnly === alphaOnly.toUpperCase() && text.length <= 72) return true;
  if (/[:：]$/.test(text) && text.length <= 80) return true;
  return false;
}

function _isBulletLine(line = '') {
  const text = String(line || '').trim();
  if (!text) return false;
  return /^([-*•●◦▪◾]|(\d+[\.\)]|[一二三四五六七八九十]+[、）)]))\s+/.test(text);
}

function _hasMetricSignal(line = '') {
  const text = String(line || '');
  return /(\d+(\.\d+)?\s*%|\$\s*\d|\d+\s*(万|亿|k|m|b)|\d{4}\s*年|q[1-4]\b|同比|环比|增长|下降|增幅|跌幅|million|billion|yo[yi])/i.test(text);
}

function _hasKeywordSignal(line = '') {
  const text = String(line || '');
  return /(risk|issue|impact|action|plan|result|summary|decision|milestone|deadline|priority|bottleneck|优化|风险|问题|影响|结论|计划|行动|进展|里程碑|优先级|瓶颈)/i.test(text);
}

function _splitLineFragments(line = '') {
  const text = String(line || '').trim();
  if (!text) return [];
  const rough = text
    .split(/[。！？!?；;]+|\.(?=\s|$)/g)
    .map(x => x.trim())
    .filter(Boolean);
  if (rough.length <= 1) return [text];
  const out = [];
  for (const frag of rough) {
    if (frag.length < PDF_KEYPOINT_MIN_LINE_CHARS && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${frag}`.trim();
      continue;
    }
    out.push(frag);
  }
  return out;
}

function _scoreKeypointLine(line = '', index = 0, total = 1) {
  const text = String(line || '').trim();
  if (!text) return -999;
  let score = 0;
  const length = text.length;
  if (length >= 20 && length <= 180) score += 3;
  else if (length >= 12 && length < 20) score += 1;
  else if (length > 220) score -= 2;
  else if (length < 10) score -= 2;
  if (_isHeadingLine(text)) score += 4;
  if (_isBulletLine(text)) score += 2;
  if (_hasMetricSignal(text)) score += 4;
  if (_hasKeywordSignal(text)) score += 2;
  if (_isNoiseLine(text)) score -= 6;
  const headWindow = Math.max(1, Math.floor(total * 0.2));
  if (index < headWindow) score += 1;
  return score;
}

function _extractPageKeypoints(text = '', options = {}) {
  const normalized = _normalizeExtractedText(text);
  if (!normalized) return [];
  const lines = normalized
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const maxKeypoints = Math.max(
    1,
    parseInt(String(options.keypointsPerPage || PDF_KEYPOINTS_PER_PAGE), 10) || PDF_KEYPOINTS_PER_PAGE
  );
  const minLineChars = Math.max(
    4,
    parseInt(String(options.keypointMinLineChars || PDF_KEYPOINT_MIN_LINE_CHARS), 10) || PDF_KEYPOINT_MIN_LINE_CHARS
  );

  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const fragments = _splitLineFragments(line);
    for (const frag of fragments) {
      const textFrag = String(frag || '').trim();
      if (!textFrag) continue;
      if (textFrag.length < minLineChars && !_isHeadingLine(textFrag) && !_isBulletLine(textFrag)) continue;
      candidates.push({
        text: textFrag,
        index,
      });
      if (candidates.length >= 96) break;
    }
    if (candidates.length >= 96) break;
  }
  if (candidates.length === 0) return [];

  const unique = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = _normalizeLineKey(item.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  if (unique.length === 0) return [];

  const scored = unique
    .map(item => ({
      ...item,
      score: _scoreKeypointLine(item.text, item.index, lines.length),
    }))
    .filter(item => item.score > -3)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .slice(0, maxKeypoints)
    .sort((a, b) => a.index - b.index);

  return scored.map(item => item.text);
}

function _splitPdftotextPages(raw = '') {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  if (!normalized) return [];
  const chunks = normalized.split('\f');
  const pages = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const text = _normalizeExtractedText(chunks[index]);
    if (!text) continue;
    pages.push({
      page: index + 1,
      text,
    });
  }
  return pages;
}

function _renderPageSnippet(pages = [], options = {}) {
  const includePageLabels = options.includePageLabels !== false;
  const keypointMode = options.keypointMode !== undefined
    ? !!options.keypointMode
    : PDF_KEYPOINT_MODE_ENABLED;
  const perPageMaxChars = Math.max(
    80,
    parseInt(String(options.perPageMaxChars || PDF_SNIPPET_PER_PAGE_MAX_CHARS), 10) || PDF_SNIPPET_PER_PAGE_MAX_CHARS
  );
  const maxChars = Math.max(
    200,
    parseInt(String(options.maxChars || PDF_SNIPPET_MAX_CHARS), 10) || PDF_SNIPPET_MAX_CHARS
  );
  if (!Array.isArray(pages) || pages.length === 0) return '';
  const lines = [];
  for (const item of pages) {
    if (!item || !item.text) continue;
    let content = '';
    if (keypointMode) {
      const keypoints = _extractPageKeypoints(item.text, options);
      if (keypoints.length > 0) {
        content = keypoints.join(' | ');
      }
    }
    const snippet = _truncateInline(content || item.text, perPageMaxChars);
    if (!snippet) continue;
    if (includePageLabels) lines.push(`[Page ${Math.max(1, Number(item.page) || 1)}] ${snippet}`);
    else lines.push(snippet);
  }
  return _truncate(lines.join('\n'), maxChars);
}

function _resolveAdaptiveMaxPages(stat = null, requestedMaxPages = PDF_SNIPPET_MAX_PAGES) {
  const base = Math.max(1, parseInt(String(requestedMaxPages || PDF_SNIPPET_MAX_PAGES), 10) || PDF_SNIPPET_MAX_PAGES);
  const sizeMb = Math.max(0, Number(stat?.size || 0) / 1024 / 1024);
  if (sizeMb >= PDF_LARGE_FILE_MB) {
    return Math.max(1, Math.min(base, PDF_LARGE_MAX_PAGES));
  }
  return base;
}

function _run(cmd, args = [], timeoutMs = PDF_SNIPPET_TIMEOUT_MS) {
  return spawnSync(cmd, args, {
    encoding: 'utf-8',
    timeout: Math.max(1000, parseInt(String(timeoutMs || PDF_SNIPPET_TIMEOUT_MS), 10) || PDF_SNIPPET_TIMEOUT_MS),
    maxBuffer: 8 * 1024 * 1024,
  });
}

function _runAsync(cmd, args = [], timeoutMs = PDF_SNIPPET_TIMEOUT_MS) {
  const ms = Math.max(1000, parseInt(String(timeoutMs || PDF_SNIPPET_TIMEOUT_MS), 10) || PDF_SNIPPET_TIMEOUT_MS);
  return new Promise((resolve) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    let timer = null;
    let child = null;

    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(payload || { status: 1, stdout, stderr });
    };

    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        status: 1,
        stdout,
        stderr: String(error?.message || error || 'spawn failed'),
      });
      return;
    }

    const appendChunk = (prev, chunk) => {
      if (!chunk) return prev;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      let out = `${prev}${text}`;
      if (out.length > 8 * 1024 * 1024) {
        out = out.slice(out.length - (8 * 1024 * 1024));
      }
      return out;
    };

    child.stdout?.on('data', (chunk) => {
      stdout = appendChunk(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendChunk(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({
        status: 1,
        stdout,
        stderr: stderr || String(error?.message || error || 'spawn error'),
      });
    });
    child.on('close', (code) => {
      finish({
        status: Number.isInteger(code) ? code : 1,
        stdout,
        stderr,
      });
    });

    timer = setTimeout(() => {
      try { safeKill(child, 'SIGKILL', 0); } catch { /* ignore */ }
      finish({
        status: 124,
        stdout,
        stderr: stderr || `timeout after ${ms}ms`,
      });
    }, ms);
    timer.unref?.();
  });
}

function _extractWithPdftotext(filePath = '', maxPages = PDF_SNIPPET_MAX_PAGES, timeoutMs = PDF_SNIPPET_TIMEOUT_MS) {
  if (!searchExecutable('pdftotext')) {
    return { success: false, engine: 'pdftotext', error: 'pdftotext not installed' };
  }
  const args = [
    '-q',
    '-enc', 'UTF-8',
    '-l', String(Math.max(1, maxPages)),
    filePath,
    '-',
  ];
  const result = _run('pdftotext', args, timeoutMs);
  if (result.status !== 0) {
    return {
      success: false,
      engine: 'pdftotext',
      error: String(result.stderr || result.stdout || `pdftotext exited ${result.status}`).trim(),
    };
  }
  const pages = _splitPdftotextPages(result.stdout || '');
  const text = pages.length > 0
    ? pages.map(x => x.text).join('\n\n')
    : _normalizeExtractedText(result.stdout || '');
  if (!text) return { success: false, engine: 'pdftotext', error: 'pdftotext produced empty text' };
  return { success: true, engine: 'pdftotext', text, pages };
}

async function _extractWithPdftotextAsync(filePath = '', maxPages = PDF_SNIPPET_MAX_PAGES, timeoutMs = PDF_SNIPPET_TIMEOUT_MS) {
  if (!searchExecutable('pdftotext')) {
    return { success: false, engine: 'pdftotext', error: 'pdftotext not installed' };
  }
  const args = [
    '-q',
    '-enc', 'UTF-8',
    '-l', String(Math.max(1, maxPages)),
    filePath,
    '-',
  ];
  const result = await _runAsync('pdftotext', args, timeoutMs);
  if (result.status !== 0) {
    return {
      success: false,
      engine: 'pdftotext',
      error: String(result.stderr || result.stdout || `pdftotext exited ${result.status}`).trim(),
    };
  }
  const pages = _splitPdftotextPages(result.stdout || '');
  const text = pages.length > 0
    ? pages.map(x => x.text).join('\n\n')
    : _normalizeExtractedText(result.stdout || '');
  if (!text) return { success: false, engine: 'pdftotext', error: 'pdftotext produced empty text' };
  return { success: true, engine: 'pdftotext', text, pages };
}

function _extractWithPythonPypdf(filePath = '', maxPages = PDF_SNIPPET_MAX_PAGES, timeoutMs = PDF_SNIPPET_TIMEOUT_MS) {
  if (!searchExecutable('python3')) {
    return { success: false, engine: 'python3+pypdf', error: 'python3 not installed' };
  }
  const code = [
    'import json,sys',
    'from pypdf import PdfReader',
    'fp=sys.argv[1]',
    'max_pages=int(sys.argv[2])',
    'r=PdfReader(fp)',
    'out=[]',
    'for i,p in enumerate(r.pages):',
    '    if i>=max_pages: break',
    '    t=(p.extract_text() or "").strip()',
    '    if t: out.append({"page": i+1, "text": t})',
    'sys.stdout.write(json.dumps({"pages": out}, ensure_ascii=False))',
  ].join(';');
  const result = _run('python3', ['-c', code, filePath, String(Math.max(1, maxPages))], timeoutMs);
  if (result.status !== 0) {
    return {
      success: false,
      engine: 'python3+pypdf',
      error: String(result.stderr || result.stdout || `python3 exited ${result.status}`).trim(),
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || '{}'));
  } catch { /* ignore */ }
  const pages = Array.isArray(parsed?.pages)
    ? parsed.pages
      .map(item => ({
        page: Math.max(1, Number(item?.page) || 1),
        text: _normalizeExtractedText(item?.text || ''),
      }))
      .filter(item => item.text)
    : [];
  const text = pages.length > 0
    ? pages.map(x => x.text).join('\n\n')
    : _normalizeExtractedText(result.stdout || '');
  if (!text) return { success: false, engine: 'python3+pypdf', error: 'python pypdf produced empty text' };
  return { success: true, engine: 'python3+pypdf', text, pages };
}

async function _extractWithPythonPypdfAsync(filePath = '', maxPages = PDF_SNIPPET_MAX_PAGES, timeoutMs = PDF_SNIPPET_TIMEOUT_MS) {
  if (!searchExecutable('python3')) {
    return { success: false, engine: 'python3+pypdf', error: 'python3 not installed' };
  }
  const code = [
    'import json,sys',
    'from pypdf import PdfReader',
    'fp=sys.argv[1]',
    'max_pages=int(sys.argv[2])',
    'r=PdfReader(fp)',
    'out=[]',
    'for i,p in enumerate(r.pages):',
    '    if i>=max_pages: break',
    '    t=(p.extract_text() or "").strip()',
    '    if t: out.append({"page": i+1, "text": t})',
    'sys.stdout.write(json.dumps({"pages": out}, ensure_ascii=False))',
  ].join(';');
  const result = await _runAsync('python3', ['-c', code, filePath, String(Math.max(1, maxPages))], timeoutMs);
  if (result.status !== 0) {
    return {
      success: false,
      engine: 'python3+pypdf',
      error: String(result.stderr || result.stdout || `python3 exited ${result.status}`).trim(),
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || '{}'));
  } catch { /* ignore */ }
  const pages = Array.isArray(parsed?.pages)
    ? parsed.pages
      .map(item => ({
        page: Math.max(1, Number(item?.page) || 1),
        text: _normalizeExtractedText(item?.text || ''),
      }))
      .filter(item => item.text)
    : [];
  const text = pages.length > 0
    ? pages.map(x => x.text).join('\n\n')
    : _normalizeExtractedText(result.stdout || '');
  if (!text) return { success: false, engine: 'python3+pypdf', error: 'python pypdf produced empty text' };
  return { success: true, engine: 'python3+pypdf', text, pages };
}

function _extractWithStrings(filePath = '', timeoutMs = PDF_SNIPPET_TIMEOUT_MS) {
  if (!searchExecutable('strings')) {
    return { success: false, engine: 'strings', error: 'strings not installed' };
  }
  const result = _run('strings', ['-n', '6', filePath], timeoutMs);
  if (result.status !== 0) {
    return {
      success: false,
      engine: 'strings',
      error: String(result.stderr || result.stdout || `strings exited ${result.status}`).trim(),
    };
  }
  const text = _normalizeExtractedText(result.stdout || '');
  if (!text) return { success: false, engine: 'strings', error: 'strings produced empty text' };
  return { success: true, engine: 'strings', text, pages: [] };
}

async function _extractWithStringsAsync(filePath = '', timeoutMs = PDF_SNIPPET_TIMEOUT_MS) {
  if (!searchExecutable('strings')) {
    return { success: false, engine: 'strings', error: 'strings not installed' };
  }
  const result = await _runAsync('strings', ['-n', '6', filePath], timeoutMs);
  if (result.status !== 0) {
    return {
      success: false,
      engine: 'strings',
      error: String(result.stderr || result.stdout || `strings exited ${result.status}`).trim(),
    };
  }
  const text = _normalizeExtractedText(result.stdout || '');
  if (!text) return { success: false, engine: 'strings', error: 'strings produced empty text' };
  return { success: true, engine: 'strings', text, pages: [] };
}

function _resolveEngineOrder(options = {}) {
  const fromOptions = Array.isArray(options.engines) ? options.engines : [];
  const fromEnv = String(process.env.KHY_MULTIMODAL_PDF_EXTRACT_ENGINES || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
  const merged = [...fromOptions, ...fromEnv, 'pdftotext', 'python_pypdf', 'strings'];
  return [...new Set(merged)];
}

function _buildSuccess(result = {}, options = {}, maxPages = PDF_SNIPPET_MAX_PAGES) {
  const includePageLabels = options.includePageLabels !== undefined
    ? !!options.includePageLabels
    : PDF_PAGE_LABEL_ENABLED;
  const maxChars = Math.max(
    200,
    parseInt(String(options.maxChars || PDF_SNIPPET_MAX_CHARS), 10) || PDF_SNIPPET_MAX_CHARS
  );
  const perPageMaxChars = Math.max(
    80,
    parseInt(String(options.perPageMaxChars || PDF_SNIPPET_PER_PAGE_MAX_CHARS), 10) || PDF_SNIPPET_PER_PAGE_MAX_CHARS
  );
  const pages = Array.isArray(result.pages) ? result.pages : [];
  const pageSnippet = _renderPageSnippet(pages, {
    includePageLabels,
    maxChars,
    perPageMaxChars,
  });
  const text = pageSnippet || _truncate(result.text || '', maxChars);
  return {
    success: true,
    engine: result.engine || 'unknown',
    text,
    pageCount: pages.length,
    pagesUsed: Math.max(1, Math.min(maxPages, pages.length || maxPages)),
  };
}

function _shouldUsePdfOcrFallback(summary = {}, options = {}) {
  const enabled = options.pdfOcrFallback !== undefined
    ? !!options.pdfOcrFallback
    : PDF_OCR_FALLBACK_ENABLED;
  if (!enabled) return false;
  const text = String(summary?.text || '').trim();
  if (!text) return true;
  const compact = text.replace(/\s+/g, '');
  if (compact.length < PDF_OCR_MIN_TEXT_CHARS) return true;
  if (/^\[Page\s+\d+\]\s*[A-Za-z0-9]{1,10}(\n\[Page\s+\d+\]\s*[A-Za-z0-9]{1,10})*$/.test(text)) {
    return true;
  }
  return false;
}

function _tryScannedPdfOcrFallbackSync(filePath = '', mimeType = '', options = {}) {
  return ocrSnippet.extractScannedPdfOcrSnippet(filePath, mimeType, {
    maxChars: options.maxChars || PDF_SNIPPET_MAX_CHARS,
    maxPages: options.pdfOcrMaxPages,
    lang: options.ocrLang,
    timeoutMs: options.pdfOcrTimeoutMs || options.timeoutMs,
  });
}

async function _tryScannedPdfOcrFallbackAsync(filePath = '', mimeType = '', options = {}) {
  return ocrSnippet.extractScannedPdfOcrSnippetAsync(filePath, mimeType, {
    maxChars: options.maxChars || PDF_SNIPPET_MAX_CHARS,
    maxPages: options.pdfOcrMaxPages,
    lang: options.ocrLang,
    timeoutMs: options.pdfOcrTimeoutMs || options.timeoutMs,
    totalBudgetMs: options.pdfOcrTotalBudgetMs || options.totalBudgetMs,
  });
}

function _preflight(filePath = '', mimeType = '', options = {}) {
  const resolved = path.resolve(String(filePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) {
    return { ok: false, failure: { success: false, error: `file not found: ${resolved || filePath}` } };
  }
  const stat = _safeStat(resolved);
  if (!stat || !stat.isFile()) return { ok: false, failure: { success: false, error: 'input is not a file' } };
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(resolved).toLowerCase();
  const isPdf = mime === 'application/pdf' || ext === '.pdf';
  if (!isPdf) return { ok: false, failure: { success: false, error: `unsupported document type: ${mime || ext || 'unknown'}` } };
  if (stat.size <= 0) return { ok: false, failure: { success: false, error: 'empty file' } };
  if (stat.size > PDF_SNIPPET_MAX_BYTES) {
    return { ok: false, failure: { success: false, error: `file too large (${Math.round(stat.size / 1024 / 1024)}MB)` } };
  }

  const requestedMaxPages = Math.max(
    1,
    parseInt(String(options.maxPages || PDF_SNIPPET_MAX_PAGES), 10) || PDF_SNIPPET_MAX_PAGES
  );
  const adaptiveMaxPages = _resolveAdaptiveMaxPages(stat, requestedMaxPages);
  const timeoutMs = Math.max(
    1000,
    parseInt(String(options.timeoutMs || PDF_SNIPPET_TIMEOUT_MS), 10) || PDF_SNIPPET_TIMEOUT_MS
  );
  const engines = _resolveEngineOrder(options);
  return {
    ok: true,
    value: {
      resolved,
      stat,
      timeoutMs,
      adaptiveMaxPages,
      engines,
    },
  };
}

function extractDocumentSnippet(filePath = '', mimeType = '', options = {}) {
  const preflight = _preflight(filePath, mimeType, options);
  if (!preflight.ok) return preflight.failure;
  const { resolved, timeoutMs, adaptiveMaxPages, engines } = preflight.value;
  const failures = [];
  let bestSummary = null;

  for (const engine of engines) {
    let result = null;
    if (engine === 'pdftotext') result = _extractWithPdftotext(resolved, adaptiveMaxPages, timeoutMs);
    else if (engine === 'python_pypdf') result = _extractWithPythonPypdf(resolved, adaptiveMaxPages, timeoutMs);
    else if (engine === 'strings') result = _extractWithStrings(resolved, timeoutMs);
    if (!result) continue;
    if (result.success && result.text) {
      bestSummary = _buildSuccess(result, options, adaptiveMaxPages);
      if (!_shouldUsePdfOcrFallback(bestSummary, options)) {
        return bestSummary;
      }
      const ocr = _tryScannedPdfOcrFallbackSync(resolved, mimeType, options);
      if (ocr && ocr.success && ocr.text) {
        return {
          success: true,
          engine: `${bestSummary.engine}+ocr`,
          text: ocr.text,
          pageCount: Number(ocr.pageCount || 0) || bestSummary.pageCount || 0,
          pagesUsed: bestSummary.pagesUsed || adaptiveMaxPages,
        };
      }
      return bestSummary;
    }
    failures.push(`${engine}: ${result.error || 'failed'}`);
  }

  if (_shouldUsePdfOcrFallback(bestSummary || {}, options)) {
    const ocr = _tryScannedPdfOcrFallbackSync(resolved, mimeType, options);
    if (ocr && ocr.success && ocr.text) {
      return {
        success: true,
        engine: 'ocr',
        text: ocr.text,
        pageCount: Number(ocr.pageCount || 0) || 0,
        pagesUsed: adaptiveMaxPages,
      };
    }
    if (ocr && ocr.error) failures.push(`ocr: ${ocr.error}`);
  }

  return {
    success: false,
    error: failures.join(' | ') || 'pdf extraction failed',
  };
}

async function extractDocumentSnippetAsync(filePath = '', mimeType = '', options = {}) {
  const preflight = _preflight(filePath, mimeType, options);
  if (!preflight.ok) return preflight.failure;
  const { resolved, timeoutMs, adaptiveMaxPages, engines } = preflight.value;
  const failures = [];
  const totalBudgetMs = Math.max(
    timeoutMs,
    parseInt(String(options.totalBudgetMs || PDF_SNIPPET_TOTAL_BUDGET_MS), 10) || PDF_SNIPPET_TOTAL_BUDGET_MS
  );
  const startedAt = Date.now();

  for (const engine of engines) {
    const elapsed = Date.now() - startedAt;
    const remaining = totalBudgetMs - elapsed;
    if (remaining < 300) {
      failures.push('budget: extraction budget exhausted');
      break;
    }
    const engineTimeoutMs = Math.max(1000, Math.min(timeoutMs, remaining));
    let result = null;
    if (engine === 'pdftotext') result = await _extractWithPdftotextAsync(resolved, adaptiveMaxPages, engineTimeoutMs);
    else if (engine === 'python_pypdf') result = await _extractWithPythonPypdfAsync(resolved, adaptiveMaxPages, engineTimeoutMs);
    else if (engine === 'strings') result = await _extractWithStringsAsync(resolved, engineTimeoutMs);
    if (!result) continue;
    if (result.success && result.text) {
      const summary = _buildSuccess(result, options, adaptiveMaxPages);
      if (!_shouldUsePdfOcrFallback(summary, options)) {
        return summary;
      }
      const remainingForOcr = Math.max(1200, totalBudgetMs - (Date.now() - startedAt));
      const ocr = await _tryScannedPdfOcrFallbackAsync(resolved, mimeType, {
        ...options,
        totalBudgetMs: remainingForOcr,
      });
      if (ocr && ocr.success && ocr.text) {
        return {
          success: true,
          engine: `${summary.engine}+ocr`,
          text: ocr.text,
          pageCount: Number(ocr.pageCount || 0) || summary.pageCount || 0,
          pagesUsed: summary.pagesUsed || adaptiveMaxPages,
        };
      }
      if (ocr && ocr.error) failures.push(`ocr: ${ocr.error}`);
      return summary;
    }
    failures.push(`${engine}: ${result.error || 'failed'}`);
  }

  if (_shouldUsePdfOcrFallback({}, options)) {
    const remainingForOcr = Math.max(1200, totalBudgetMs - (Date.now() - startedAt));
    const ocr = await _tryScannedPdfOcrFallbackAsync(resolved, mimeType, {
      ...options,
      totalBudgetMs: remainingForOcr,
    });
    if (ocr && ocr.success && ocr.text) {
      return {
        success: true,
        engine: 'ocr',
        text: ocr.text,
        pageCount: Number(ocr.pageCount || 0) || 0,
        pagesUsed: adaptiveMaxPages,
      };
    }
    if (ocr && ocr.error) failures.push(`ocr: ${ocr.error}`);
  }

  return {
    success: false,
    error: failures.join(' | ') || 'pdf extraction failed',
  };
}

module.exports = {
  extractDocumentSnippet,
  extractDocumentSnippetAsync,
};
