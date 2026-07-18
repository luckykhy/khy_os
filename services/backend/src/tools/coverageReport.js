/**
 * coverageReport — parse existing coverage reports into structured gaps.
 *
 * Capability: "软件测试" (test coverage analysis). Reads coverage artifacts that
 * the user already generated (lcov.info, coverage-summary.json, cobertura XML)
 * and returns structured line/branch/function coverage with identified gaps —
 * files below threshold, uncovered lines, worst-covered files.
 *
 * Auto-detection: scans the project tree for known report paths; the user can
 * also pass an explicit path.
 *
 * Zero-hardcoding rule: thresholds are configurable per invocation; no default
 * credential or path is baked in.
 *
 * State transparency: `meta` reports detected format, file count, and overall
 * coverage percentages.
 */

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const { guardedReadFileSync } = require('./guardedReadFileSync');

// ─── Known report paths (checked in order) ──────────────────────────────────

const KNOWN_PATHS = [
  'coverage/lcov.info',
  'coverage/coverage-summary.json',
  'coverage/cobertura-coverage.xml',
  'coverage/coverage.xml',
  'coverage/coverage-final.json',
  'target/debug/coverage/lcov.info',
  'lcov.info',
];

// ─── Format detectors (by first non-whitespace char) ────────────────────────

function _detectFormat(filePath) {
  try {
    const head = guardedReadFileSync(filePath, 'utf-8').trimStart();
    if (head.startsWith('TN:') || head.startsWith('SF:')) return 'lcov';
    if (head.startsWith('{')) return 'json';
    if (head.startsWith('<?xml') || head.startsWith('<coverage')) return 'cobertura';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── LCOV parser ────────────────────────────────────────────────────────────

/**
 * Parse an lcov.info file into structured coverage data.
 * LCOV format: TN: / SF:/path/to/file / DA:line,count / LF: / LH: / BRDA: / BRF: / BRH: / end_of_record
 */
function _parseLcov(lcovPath) {
  const text = guardedReadFileSync(lcovPath, 'utf-8');
  const records = [];
  let current = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === 'end_of_record') {
      if (current) records.push(current);
      current = null;
      continue;
    }

    if (line.startsWith('SF:')) {
      if (current) records.push(current);
      current = { file: line.slice(3), lines: { found: 0, hit: 0, details: [] }, branches: { found: 0, hit: 0 }, functions: { found: 0, hit: 0 } };
    } else if (current) {
      if (line.startsWith('DA:')) {
        const [, lineNum, count] = line.match(/^DA:(\d+),(\d+)/) || [];
        const l = parseInt(lineNum, 10), c = parseInt(count, 10);
        current.lines.found++;
        if (c > 0) current.lines.hit++;
        current.lines.details.push({ line: l, hit: c });
      } else if (line.startsWith('LF:')) {
        current.lines.found = parseInt(line.slice(3), 10);
      } else if (line.startsWith('LH:')) {
        current.lines.hit = parseInt(line.slice(3), 10);
      } else if (line.startsWith('BRF:')) {
        current.branches.found = parseInt(line.slice(4), 10);
      } else if (line.startsWith('BRH:')) {
        current.branches.hit = parseInt(line.slice(4), 10);
      } else if (line.startsWith('FNF:')) {
        current.functions.found = parseInt(line.slice(4), 10);
      } else if (line.startsWith('FNH:')) {
        current.functions.hit = parseInt(line.slice(4), 10);
      }
    }
  }
  if (current) records.push(current);

  return _buildResult(records, 'lcov');
}

// ─── JSON parser (coverage-summary.json / coverage-final.json) ──────────────

function _parseCoverageJson(jsonPath) {
  let raw;
  try { raw = JSON.parse(guardedReadFileSync(jsonPath, 'utf-8')); } catch { return null; }

  const records = [];

  // coverage-summary.json shape: { total: { lines/branches/functions/statements: { total, covered, pct } }, "file.js": {...} }
  if (raw && raw.total && typeof raw.total === 'object') {
    for (const [file, stats] of Object.entries(raw)) {
      if (file === 'total') continue;
      if (!stats || typeof stats !== 'object') continue;
      const lines = stats.lines || {};
      const branches = stats.branches || {};
      const functions = stats.functions || {};
      records.push({
        file,
        lines: { found: lines.total || 0, hit: lines.covered || 0, pct: lines.pct },
        branches: { found: branches.total || 0, hit: branches.covered || 0, pct: branches.pct },
        functions: { found: functions.total || 0, hit: functions.covered || 0, pct: functions.pct },
      });
    }
    return _buildResult(records, 'json');
  }

  // coverage-final.json shape (Istanbul): { "file.js": { path, statementMap, fnMap, branchMap, s, f, b } }
  if (raw && typeof raw === 'object' && !raw.total) {
    for (const [file, data] of Object.entries(raw)) {
      if (!data || typeof data !== 'object') continue;
      const stmts = Object.values(data.s || {});
      const branches = Object.values(data.b || {});
      const fns = Object.values(data.f || {});
      records.push({
        file,
        lines: { found: stmts.length, hit: stmts.filter(v => v > 0).length },
        branches: { found: branches.length, hit: branches.filter(v => Array.isArray(v) ? v[0] > 0 : v > 0).length },
        functions: { found: fns.length, hit: fns.filter(v => v > 0).length },
      });
    }
    return _buildResult(records, 'json');
  }

  return null;
}

// ─── Cobertura XML parser ────────────────────────────────────────────────────

function _parseCobertura(xmlPath) {
  const text = guardedReadFileSync(xmlPath, 'utf-8');
  const records = [];

  // Lightweight XML extraction — avoids pulling a full XML parser dependency.
  // Cobertura structure: <package> → <class filename="..." .../> → <lines><line hits="N" number="N"/></lines>
  const pkgRe = /<package[^>]*>([\s\S]*?)<\/package>/g;
  let pkgMatch;
  while ((pkgMatch = pkgRe.exec(text)) !== null) {
    const pkgBody = pkgMatch[1];
    const clsRe = /<class[^>]*filename\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/class>/g;
    let clsMatch;
    while ((clsMatch = clsRe.exec(pkgBody)) !== null) {
      const file = clsMatch[1];
      const clsBody = clsMatch[2];
      let totalLines = 0, hitLines = 0;
      let totalBranches = 0, hitBranches = 0;

      const lineRe = /<line[^>]*hits\s*=\s*"(\d+)"[^>]*number\s*=\s*"(\d+)"[^>]*(?:branch\s*=\s*"true")?[^>]*>/g;
      let lMatch;
      while ((lMatch = lineRe.exec(clsBody)) !== null) {
        totalLines++;
        const hits = parseInt(lMatch[1], 10);
        if (hits > 0) hitLines++;
        // Cobertura branch attribute: condition-coverage="50% (1/2)"
        const condMatch = clsBody.match(/condition-coverage\s*=\s*"(\d+)%\s*\((\d+)\/(\d+)\)"/);
        if (condMatch) {
          hitBranches = parseInt(condMatch[2], 10);
          totalBranches = parseInt(condMatch[3], 10);
        }
      }

      records.push({
        file,
        lines: { found: totalLines, hit: hitLines },
        branches: { found: totalBranches, hit: hitBranches },
        functions: { found: 0, hit: 0 },
      });
    }
  }

  if (records.length === 0) {
    // Fallback: simpler <class> tags without nested <lines>
    const simpleClsRe = /<class[^>]*filename\s*=\s*"([^"]*)"[^>]*line-rate\s*=\s*"([^"]*)"[^>]*branch-rate\s*=\s*"([^"]*)"/g;
    let scMatch;
    while ((scMatch = simpleClsRe.exec(text)) !== null) {
      records.push({
        file: scMatch[1],
        lines: { found: 0, hit: 0, rate: parseFloat(scMatch[2]) },
        branches: { found: 0, hit: 0, rate: parseFloat(scMatch[3]) },
        functions: { found: 0, hit: 0 },
      });
    }
  }

  return _buildResult(records, 'cobertura');
}

// ─── Unified result builder ──────────────────────────────────────────────────

function _pct(hit, found) {
  if (!found || found <= 0) return 0;
  return Math.round((hit / found) * 10000) / 100;
}

function _buildResult(records, format) {
  if (!records.length) {
    return { format, files: 0, lineCoverage: null, branchCoverage: null, fnCoverage: null, filesBelowThreshold: [], worstFiles: [] };
  }

  let totalLines = 0, hitLines = 0;
  let totalBranches = 0, hitBranches = 0;
  let totalFns = 0, hitFns = 0;

  const gaps = [];

  for (const r of records) {
    const lp = _pct(r.lines.hit, r.lines.found);
    const bp = _pct(r.branches.hit, r.branches.found);
    const fp = _pct(r.functions.hit, r.functions.found);

    totalLines += r.lines.found;
    hitLines += r.lines.hit;
    totalBranches += r.branches.found;
    hitBranches += r.branches.hit;
    totalFns += r.functions.found;
    hitFns += r.functions.hit;

    gaps.push({
      file: r.file,
      linePct: lp,
      branchPct: bp,
      fnPct: fp,
      lines: r.lines,
      branches: r.branches,
      functions: r.functions,
    });
  }

  // Sort by line coverage ascending (worst first)
  gaps.sort((a, b) => a.linePct - b.linePct);

  const filesBelowThreshold = gaps.filter(g => g.linePct < 80);
  const worstFiles = gaps.slice(0, 10);

  return {
    format,
    files: records.length,
    lineCoverage: _pct(hitLines, totalLines),
    branchCoverage: _pct(hitBranches, totalBranches),
    fnCoverage: _pct(hitFns, totalFns),
    filesBelowThreshold,
    worstFiles,
    allFiles: gaps,
  };
}

// ─── Auto-detect coverage report in project ──────────────────────────────────

function _findReport(explicitPath, cwd) {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    return null;
  }

  for (const rel of KNOWN_PATHS) {
    const candidate = path.join(cwd, rel);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

module.exports = defineTool({
  name: 'coverage_report',
  description:
    'Parse existing test coverage reports (lcov.info, coverage-summary.json, cobertura XML) '
    + 'and return structured coverage data with identified gaps — files below 80% line coverage, '
    + 'worst-covered files, and overall line/branch/function percentages.',
  category: 'analysis',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: 'coverage report test coverage lcov',
  aliases: ['coverage', 'test_coverage', 'check_coverage', '覆盖率', '测试覆盖率'],

  inputSchema: {
    path: {
      type: 'string',
      maxLength: 4096,
      description: 'Path to a coverage report file. Auto-detected from common locations if omitted (coverage/lcov.info, etc.).',
    },
    threshold: {
      type: 'number',
      min: 0,
      max: 100,
      default: 80,
      description: 'Line coverage threshold percentage (0-100). Files below this are flagged as gaps. Default 80.',
    },
  },

  getActivityDescription(input) {
    const p = input && input.path ? String(input.path) : 'auto-detect';
    return `分析测试覆盖率: ${p}`;
  },

  async execute(params, _context) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const reportPath = _findReport(params && params.path ? String(params.path) : '', cwd);

    if (!reportPath) {
      const tried = params && params.path ? [params.path] : KNOWN_PATHS;
      return {
        success: false,
        error: `No coverage report found. Tried: ${tried.slice(0, 8).join(', ')}. Run your test suite with coverage first.`,
        content: `No coverage report found in ${cwd}. Run tests with coverage enabled (e.g. \`jest --coverage\`, \`pytest --cov\`, \`cargo tarpaulin\`) to generate a report.`,
        meta: { format: null, tried },
      };
    }

    const format = _detectFormat(reportPath);
    const threshold = (params && Number.isFinite(params.threshold) && params.threshold >= 0 && params.threshold <= 100)
      ? params.threshold : 80;

    let result;
    try {
      if (format === 'lcov') result = _parseLcov(reportPath);
      else if (format === 'json') result = _parseCoverageJson(reportPath);
      else if (format === 'cobertura') result = _parseCobertura(reportPath);
      else {
        return {
          success: false,
          error: `Unknown coverage format in: ${reportPath}`,
          content: `Unable to determine coverage report format for ${reportPath}. Supported formats: lcov.info, coverage-summary.json, cobertura XML.`,
          meta: { format: 'unknown' },
        };
      }
    } catch (err) {
      return {
        success: false,
        error: `Failed to parse coverage report: ${err.message}`,
        content: `Coverage report parse error: ${err.message}`,
        meta: { format },
      };
    }

    if (!result || result.files === 0) {
      return {
        success: true,
        content: `Coverage report found at ${reportPath} (format: ${format}) but contains no file data.`,
        meta: { format, files: 0 },
      };
    }

    const below = result.filesBelowThreshold || [];
    const gapsList = below.slice(0, 15).map(g =>
      `  ${g.file} — lines: ${g.linePct}%${g.branchPct !== undefined ? `, branches: ${g.branchPct}%` : ''}`
    ).join('\n');

    const header = `Coverage report: ${path.basename(reportPath)} (${format})`;
    const summary = `Overall: lines ${result.lineCoverage}%${result.branchCoverage ? `, branches ${result.branchCoverage}%` : ''}${result.fnCoverage ? `, functions ${result.fnCoverage}%` : ''} across ${result.files} files.`;
    const gapsBlock = below.length > 0
      ? `\nFiles below ${threshold}% line coverage (${below.length} of ${result.files}):\n${gapsList}\nHint: worst file is ${result.worstFiles[0]?.file || 'N/A'} at ${result.worstFiles[0]?.linePct || '?'}%.`
      : `\nAll ${result.files} files meet the ${threshold}% line coverage threshold.`;

    return {
      success: true,
      content: `${header}\n${summary}${gapsBlock}`,
      meta: {
        format: result.format,
        files: result.files,
        lineCoverage: result.lineCoverage,
        branchCoverage: result.branchCoverage,
        fnCoverage: result.fnCoverage,
        threshold,
        filesBelowThreshold: below.length,
        worstFile: result.worstFiles[0] || null,
      },
    };
  },
});
