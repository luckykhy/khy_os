/**
 * securityScan — SAST tool for the CLI agent.
 *
 * Scans a project's source files for security vulnerabilities using:
 *   1. Built-in regex rules from codeScanner (shell injection, secret exfil,
 *      SSTI, SQL injection, prototype pollution, path traversal, weak crypto,
 *      privilege escalation) — always available.
 *   2. Optional semgrep integration if installed (KHY_SECURITY_SCAN_SEMGREP).
 *
 * Walk strategy: reuses the pureJsGrep `_walkDir` pattern (fs.readdirSync
 * with excludeDirs: node_modules, .git, dist, build, .cache, coverage,
 * __pycache__, vendor, venv, .venv, target). Scans files with recognized
 * source extensions (.js, .ts, .py, .rs, .go, .java, .sh, .yaml/.yml,
 * .toml, Dockerfile, .env.example).
 *
 * Zero-hardcoding rule: no hardcoded paths; excludeDirs are configurable
 * via KHY_SECURITY_SCAN_EXCLUDE; severity thresholds are per-invocation.
 * State transparency: meta reports scanner_engine, rules_applied, files_scanned.
 */

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const { guardedReadFileSync } = require('./guardedReadFileSync');

// ─── Extended ruleset (includes codeScanner SCAN_RULES + additions) ──────────

// Lazy-require codeScanner rules to avoid pulling the module at definition time.
let _SCAN_RULES = null;
function _getRules() {
  if (_SCAN_RULES) return _SCAN_RULES;
  try {
    _SCAN_RULES = require('../services/security/codeScanner').SCAN_RULES;
  } catch {
    _SCAN_RULES = [];
  }
  // Extend with additional security rules beyond what codeScanner provides.
  _SCAN_RULES.push(
    // Path traversal
    {
      id: 'PATH_TRAVERSAL',
      pattern: /\.\.\/\.\.\/|\.\.\\\.\.\\|path\.join\s*\(\s*.*\.\.\/|path\.resolve\s*\(\s*.*\.\.\/|require\s*\(\s*.*\.\.\/\.\.\//gi,
      severity: 'high',
      category: 'path_traversal',
      description: 'Suspicious path traversal pattern (directory escape)',
    },
    {
      id: 'PATH_TRAVERSAL_NORMALIZE',
      pattern: /path\.normalize\s*\(\s*[^)]*(?:\.\.|dirname)/gi,
      severity: 'medium',
      category: 'path_traversal',
      description: 'Path normalization with user input (potential traversal bypass)',
    },

    // Command injection
    {
      id: 'CMD_INJECTION_UNSANITIZED',
      pattern: /(?:exec|execSync|spawn|spawnSync|execFile)\s*\(\s*[^)]*\+\s*[^)]+/gi,
      severity: 'high',
      category: 'command_injection',
      description: 'Shell command built with concatenation (potential injection)',
    },
    {
      id: 'CMD_INJECTION_TEMPLATE',
      pattern: /(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{[^}]*\}[^`]*`/gi,
      severity: 'high',
      category: 'command_injection',
      description: 'Shell command built with template literal (injection risk)',
    },

    // Weak cryptography
    {
      id: 'WEAK_CRYPTO_MD5',
      pattern: /\b(?:md5|MD5)\b/gi,
      severity: 'low',
      category: 'weak_crypto',
      description: 'Use of MD5 (cryptographically broken)',
    },
    {
      id: 'WEAK_CRYPTO_SHA1',
      pattern: /\b(?:sha1|SHA1)\b/gi,
      severity: 'low',
      category: 'weak_crypto',
      description: 'Use of SHA-1 (cryptographically broken)',
    },
    {
      id: 'WEAK_CRYPTO_DES',
      pattern: /\b(?:DES-|des-|'des'|"des"|aes-128-ecb)\b/gi,
      severity: 'medium',
      category: 'weak_crypto',
      description: 'Use of DES or AES-ECB (weak/obsolete cipher)',
    },
    {
      id: 'INSECURE_RANDOM',
      pattern: /\bMath\.random\s*\(\s*\)/g,
      severity: 'low',
      category: 'weak_crypto',
      description: 'Use of Math.random() for security-sensitive purposes',
    },

    // Hardcoded secrets (broader)
    {
      id: 'HARDCODED_SECRET_BROAD',
      pattern: /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth[_-]?token)\s*(?:=|:)\s*['"]([^'"]{8,})['"]/gi,
      severity: 'medium',
      category: 'secret_exfil',
      description: 'Possible hardcoded credential',
    },
    {
      id: 'HARDCODED_PRIVATE_KEY',
      pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP)\s+PRIVATE\s+KEY-----/g,
      severity: 'critical',
      category: 'secret_exfil',
      description: 'Embedded private key in source',
    },

    // Unsafe deserialization
    {
      id: 'UNSAFE_DESERIALIZE',
      pattern: /\b(?:yaml\.load\s*\(|pickle\.load|eval\s*\(\s*.*serializ|JSON\.parse\s*\(\s*.*untrusted)/gi,
      severity: 'high',
      category: 'unsafe_behavior',
      description: 'Potentially unsafe deserialization',
    }
  );

  // Run each rule's pattern through its paces to reset lastIndex
  for (const rule of _SCAN_RULES) {
    rule.pattern.lastIndex = 0;
  }
  return _SCAN_RULES;
}

// ─── File discovery ─────────────────────────────────────────────────────────

const DEFAULT_EXCLUDE = new Set([
  'node_modules', '.git', 'dist', 'build', '.cache', 'coverage',
  '__pycache__', 'vendor', 'venv', '.venv', 'target', '.next',
  '.nuxt', 'bower_components', '.tox', '.mypy_cache', '.pytest_cache',
]);

const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.pyi', '.pyx',
  '.rs',
  '.go',
  '.java', '.kt', '.scala',
  '.sh', '.bash', '.zsh',
  '.yaml', '.yml',
  '.toml',
  '.php',
  '.rb',
  'Dockerfile',
]);

const SOURCE_NAMES = new Set([
  'Dockerfile', '.env.example', '.env.sample', 'Makefile', 'CMakeLists.txt',
]);

function _isScannable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (SOURCE_EXTS.has(ext)) return true;
  const base = path.basename(filePath);
  if (SOURCE_NAMES.has(base)) return true;
  // Match Dockerfile variants
  if (base.startsWith('Dockerfile') || base.startsWith('docker-compose')) return true;
  return false;
}

function _readExcludeDirs() {
  const envDirs = process.env.KHY_SECURITY_SCAN_EXCLUDE || '';
  if (!envDirs) return DEFAULT_EXCLUDE;
  const custom = new Set(DEFAULT_EXCLUDE);
  for (const d of envDirs.split(',')) {
    const trimmed = d.trim();
    if (trimmed) custom.add(trimmed);
  }
  return custom;
}

/**
 * Walk a project directory and collect scannable files.
 * @param {string} root
 * @param {number} maxFiles
 * @returns {string[]}
 */
function _collectFiles(root, maxFiles) {
  const excludeDirs = _readExcludeDirs();
  const files = [];

  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name) && !entry.name.startsWith('.')) {
          walk(fullPath);
        }
        continue;
      }

      if (entry.isFile() && _isScannable(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  walk(root);
  return files;
}

// ─── Semgrep integration (optional) ──────────────────────────────────────────

async function _runSemgrep(root, { spawnWithIdleTimeout, getShellConfiguration }) {
  const { executable, argsPrefix } = getShellConfiguration({ login: true });
  const cmd = 'semgrep --config=auto --json --quiet --no-git-ignore 2>/dev/null';

  let output = '';
  try {
    const result = await spawnWithIdleTimeout(executable, [...argsPrefix, cmd], {
      idleMs: 120000,
      spawnOpts: { cwd: root, env: { ...process.env, SEMGREP_ENABLE_VERSION_CHECK: '0' } },
      label: 'securityScan:semgrep',
    });
    output = result.stdout || '';
  } catch {
    output = '';
  }

  if (!output.trim()) return [];

  try {
    const parsed = JSON.parse(output);
    const findings = [];
    for (const r of (parsed.results || [])) {
      findings.push({
        file: r.path || '',
        line: (r.start && r.start.line) || 0,
        ruleId: r.check_id || 'semgrep',
        severity: (r.extra && r.extra.severity) || 'warning',
        category: r.check_id ? r.check_id.split('.')[0] : 'semgrep',
        description: (r.extra && r.extra.message) || 'Semgrep finding',
        match: (r.extra && r.extra.lines) || '',
        source: 'semgrep',
      });
    }
    return findings;
  } catch {
    return [];
  }
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

module.exports = defineTool({
  name: 'security_scan',
  description:
    'Scan project source files for security vulnerabilities. Applies built-in regex rules '
    + '(shell injection, secret exfiltration, SSTI, SQL injection, prototype pollution, '
    + 'path traversal, weak crypto, command injection) and optionally semgrep. '
    + 'Use this before deploying or reviewing untrusted code.',
  category: 'analysis',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: 'security scan SAST vulnerability audit secrets',
  aliases: ['securityScan', 'sast', 'audit_code', '安全扫描', '代码审计', '审计', '漏洞扫描'],

  inputSchema: {
    cwd: {
      type: 'string',
      maxLength: 4096,
      description: 'Project root directory to scan. Defaults to current working directory.',
    },
    minSeverity: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'low',
      description: 'Minimum severity to report (default low).',
    },
    maxFiles: {
      type: 'number',
      min: 10,
      max: 5000,
      default: 1000,
      description: 'Maximum files to scan (10-5000, default 1000).',
    },
    semgrep: {
      type: 'boolean',
      default: false,
      description: 'Also run semgrep if installed. Requires semgrep in PATH.',
    },
  },

  getActivityDescription(input) {
    const dir = input && input.cwd ? String(input.cwd) : '.';
    return `安全扫描: ${dir}`;
  },

  async execute(params, _context) {
    const cwd = (params && params.cwd) ? path.resolve(String(params.cwd)) : process.cwd();
    const minSeverity = (params && params.minSeverity) || 'low';
    const maxFiles = (params && Number.isFinite(params.maxFiles))
      ? Math.min(5000, Math.max(10, Math.floor(params.maxFiles)))
      : 1000;
    const wantSemgrep = !!(params && params.semgrep);

    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return {
        success: false,
        error: `Not a directory: ${cwd}`,
        content: `Cannot scan: ${cwd} is not a directory.`,
        meta: { scannerEngine: 'regex', semgrepAvailable: false },
      };
    }

    const rules = _getRules();
    const { SEVERITY_ORDER: severityOrder } = require('../services/security/codeScanner');
    const minIdx = severityOrder.indexOf(minSeverity);
    const relevantRules = rules.filter(r => severityOrder.indexOf(r.severity) >= minIdx);

    const files = _collectFiles(cwd, maxFiles);
    const findings = [];

    for (const filePath of files) {
      let content;
      try { content = guardedReadFileSync(filePath, 'utf-8'); } catch { continue; }
      if (content.includes('\0')) continue; // skip binary

      for (const rule of relevantRules) {
        rule.pattern.lastIndex = 0;
        let match;
        while ((match = rule.pattern.exec(content)) !== null) {
          // Compute line number
          const lineNum = content.substring(0, match.index).split('\n').length;
          findings.push({
            file: path.relative(cwd, filePath),
            line: lineNum,
            ruleId: rule.id,
            severity: rule.severity,
            category: rule.category,
            description: rule.description,
            match: match[0].slice(0, 120),
          });
        }
      }
    }

    // ── Optional semgrep ─────────────────────────────────────────────────────
    let semgrepFindings = [];
    let semgrepAvailable = false;
    if (wantSemgrep) {
      try {
        const { spawnWithIdleTimeout } = require('../utils/spawnWithIdleTimeout');
        const { getShellConfiguration } = require('./platformUtils');
        semgrepFindings = await _runSemgrep(cwd, { spawnWithIdleTimeout, getShellConfiguration });
        semgrepAvailable = semgrepFindings.length > 0;
      } catch {
        // semgrep is optional
      }
    }

    const allFindings = [...findings, ...semgrepFindings];

    // ── Group and summarize ──────────────────────────────────────────────────
    if (allFindings.length === 0) {
      return {
        success: true,
        content: `Security scan complete — no issues found in ${files.length} files${wantSemgrep ? ' (regex + semgrep)' : ''}.`,
        meta: {
          scannerEngine: wantSemgrep && semgrepAvailable ? 'regex+semgrep' : 'regex',
          semgrepAvailable,
          filesScanned: files.length,
          rulesApplied: relevantRules.length,
          totalFindings: 0,
          bySeverity: {},
        },
      };
    }

    // Group by severity
    const bySeverity = {};
    for (const f of allFindings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }

    // Build readable content
    const topFindings = allFindings.slice(0, 30);
    const lines = [
      `Security scan: ${allFindings.length} finding(s) in ${files.length} files${wantSemgrep && semgrepAvailable ? ' (regex + semgrep)' : ''}.`,
      `By severity: ${Object.entries(bySeverity).map(([s, c]) => `${s}=${c}`).join(', ')}.`,
      '',
      ...topFindings.map(f =>
        `  [${f.severity.toUpperCase()}] ${f.file}:${f.line} — ${f.description}\n    → ${f.match}`
      ),
    ];

    if (allFindings.length > 30) {
      lines.push(`\n... and ${allFindings.length - 30} more findings.`);
    }

    return {
      success: true,
      content: lines.join('\n'),
      meta: {
        scannerEngine: wantSemgrep && semgrepAvailable ? 'regex+semgrep' : 'regex',
        semgrepAvailable,
        filesScanned: files.length,
        rulesApplied: relevantRules.length,
        totalFindings: allFindings.length,
        bySeverity,
      },
    };
  },
});
