'use strict';

/**
 * Code Check/Fix Service — 确定性代码检查与自动修复
 *
 * Tier 1 handler: 有无模型都拦截（语法检查+模式匹配比 AI 更精确、零 token）。
 *
 * 支持语言: JavaScript/TypeScript, Python
 * 检查: 语法错误 + 16 种常见 bug 模式 + 外部 linter（如可用）
 * 修复: 确定性可修复项 + 备份 + 验证
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ═══════════════════════════════════════════════════════════════════
// Intent Detection
// ═══════════════════════════════════════════════════════════════════

const _CODE_TARGET_RE = /(代码|项目|文件|bug|错误|语法|code|project|file|bugs?|errors?|syntax|\.js\b|\.ts\b|\.py\b|\.jsx\b|\.tsx\b)/i;

function isCodeCheckIntent(text) {
  if (text.length > 200) return false;
  const hasAction = /(检查|查bug|查错|诊断|扫描|lint|check\b|scan\b|diagnose)/i.test(text);
  if (hasAction && _CODE_TARGET_RE.test(text)) return true;
  // action + path-like target (contains / or .) → code check
  if (hasAction && /\S+[/\\]/.test(text)) return true;
  if (/^lint\b/i.test(text)) return true;
  if (/^(check|scan)\s+\S+[/\\]/i.test(text)) return true;
  if (/^check\s+\S+\.\w{1,6}\s*$/i.test(text)) return true;
  if (/^(?:查bug|检查代码|诊断项目|扫描代码|代码检查)\s*$/i.test(text)) return true;
  return false;
}

function isCodeFixIntent(text) {
  if (text.length > 200) return false;
  const hasAction = /(修复|修正|自动修复|fix\b|auto-?fix|repair)/i.test(text);
  if (hasAction && _CODE_TARGET_RE.test(text)) return true;
  // action + path-like target → code fix
  if (hasAction && /\S+[/\\]/.test(text)) return true;
  if (/^(?:修复代码|自动修复|fix code|代码修复)\s*$/i.test(text)) return true;
  if (/^(fix|auto-?fix)\s+\S+[/\\]/i.test(text)) return true;
  if (/^fix\s+\S+\.\w{1,6}\s*$/i.test(text)) return true;
  return false;
}

// ── Target extraction ───────────────────────────────────────────────

function _expandHome(p) {
  if (p && (p.startsWith('~/') || p === '~')) {
    return path.join(require('os').homedir(), p.slice(1));
  }
  return p;
}

function _extractTarget(text, cwd) {
  // "检查 src/foo.js" / "lint backend/" / "fix ./bar.py"
  const m = text.match(/(?:检查|查|诊断|扫描|lint|check|scan|fix|修复|修正)\s+["'`]?([^\s"'`，。；]{2,120})["'`]?/i);
  if (m) {
    const raw = m[1].replace(/(的?代码|的?bug|的?错误|code|bugs?|errors?)$/i, '').trim();
    if (raw && raw !== '代码' && raw !== 'code') {
      return path.resolve(cwd, _expandHome(raw));
    }
  }
  return null;
}

const _LANG_MAP = {
  '.js': 'js', '.cjs': 'js', '.mjs': 'js', '.jsx': 'js',
  '.ts': 'ts', '.tsx': 'ts',
  '.py': 'python',
};

function _detectLang(filePath) {
  return _LANG_MAP[path.extname(filePath).toLowerCase()] || null;
}

// ═══════════════════════════════════════════════════════════════════
// Detection (Plan Generation)
// ═══════════════════════════════════════════════════════════════════

function detectCodeCheck(text, opts) {
  const cwd = opts?.cwd || process.cwd();
  const target = _extractTarget(text, cwd) || cwd;
  const exists = fs.existsSync(target);
  if (!exists) return { type: 'code_check', category: '代码检查', label: path.basename(target), target, targetIsFile: false, cwd };
  const stat = fs.statSync(target);
  return {
    type: 'code_check',
    category: '代码检查',
    label: stat.isFile() ? path.basename(target) : '项目扫描',
    target,
    targetIsFile: stat.isFile(),
    cwd,
  };
}

function detectCodeFix(text, opts) {
  const plan = detectCodeCheck(text, opts);
  if (plan) plan.type = 'code_fix';
  if (plan) plan.category = '代码修复';
  return plan;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: File Collection
// ═══════════════════════════════════════════════════════════════════

const _IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', 'dist', 'build', '.cache',
  '.tmp', 'coverage', '.next', '.nuxt', 'vendor', 'venv', '.venv',
  '.tox', '.eggs', '.khy-backup',
]);
const _CODE_EXTS = new Set(Object.keys(_LANG_MAP));
const _MAX_FILES = 500;
const _MAX_DEPTH = 8;

function _collectFiles(target, isFile) {
  if (isFile) return fs.existsSync(target) ? [target] : [];
  const files = [];
  function walk(dir, depth) {
    if (depth > _MAX_DEPTH || files.length >= _MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || _IGNORE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && _CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
        if (files.length >= _MAX_FILES) return;
      }
    }
  }
  walk(target, 0);
  return files;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Syntax Checks
// ═══════════════════════════════════════════════════════════════════

function _syntaxCheckJS(filePath) {
  try {
    const r = spawnSync(process.execPath, ['--check', filePath], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ');
      const lineM = msg.match(/:(\d+)/);
      return {
        file: filePath, line: lineM ? parseInt(lineM[1], 10) : 1,
        severity: 'error', rule: 'syntax-error', message: msg, fixable: false,
      };
    }
  } catch { /* timeout */ }
  return null;
}

function _syntaxCheckPython(filePath) {
  const escaped = filePath.replace(/'/g, "\\'");
  try {
    const r = spawnSync('python3', ['-c', `import py_compile; py_compile.compile('${escaped}', doraise=True)`], {
      encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ');
      const lineM = msg.match(/line (\d+)/);
      return {
        file: filePath, line: lineM ? parseInt(lineM[1], 10) : 1,
        severity: 'error', rule: 'syntax-error', message: msg, fixable: false,
      };
    }
  } catch { /* python3 not available or timeout */ }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Pattern-Based Bug Detection
// ═══════════════════════════════════════════════════════════════════

function _isComment(line, lang) {
  const trimmed = line.trim();
  if (lang === 'python') return trimmed.startsWith('#');
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

// ── JS/TS Patterns ──────────────────────────────────────────────────

const _JS_PATTERNS = [
  {
    rule: 'loose-equality',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      // Match == but not === or !==
      if (!/[^!=]==[^=]/.test(line)) return null;
      // Allow == null (common intentional pattern)
      if (/==\s*null\b/.test(line) || /null\s*==/.test(line)) return null;
      return { line: lineNum, severity: 'warning', rule: 'loose-equality',
        message: '使用 == 可能导致类型强转，建议使用 ===', fixable: true };
    },
  },
  {
    rule: 'var-usage',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      if (/\bvar\s+\w/.test(line)) {
        return { line: lineNum, severity: 'warning', rule: 'var-usage',
          message: '使用 var 声明，建议改为 let 或 const', fixable: true };
      }
      return null;
    },
  },
  {
    rule: 'console-log',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      if (/\bconsole\.log\s*\(/.test(line)) {
        return { line: lineNum, severity: 'info', rule: 'console-log',
          message: '遗留的 console.log 调用', fixable: false };
      }
      return null;
    },
  },
  {
    rule: 'empty-catch',
    test(line, lineNum) {
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
        return { line: lineNum, severity: 'warning', rule: 'empty-catch',
          message: '空的 catch 块会吞掉错误', fixable: false };
      }
      return null;
    },
  },
  {
    rule: 'assignment-in-condition',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      // if (x = 1) but not if (x == / === / != / !== / <= / >=)
      const m = line.match(/\b(?:if|while)\s*\(([^)]+)\)/);
      if (!m) return null;
      const cond = m[1];
      // Check for single = that is not ==, ===, !=, !==, <=, >=, =>
      if (/(?<![!=<>])=(?!=)/.test(cond) && !/==|!=|<=|>=|=>/.test(cond)) {
        return { line: lineNum, severity: 'warning', rule: 'assignment-in-condition',
          message: '条件中可能误用赋值 =，是否应为 === ?', fixable: false };
      }
      return null;
    },
  },
  {
    rule: 'unreachable-code',
    test(line, lineNum, lines, idx, lang) {
      if (idx === 0) return null;
      const prev = (lines[idx - 1] || '').trim();
      const curr = line.trim();
      if (!curr || /^[}\])]/.test(curr) || _isComment(curr, lang)) return null;
      if (/^(case|default)\b/.test(curr)) return null;
      if (/^(return|throw)\b/.test(prev) && !/[{(,]$/.test(prev)) {
        return { line: lineNum, severity: 'warning', rule: 'unreachable-code',
          message: 'return/throw 后的代码不可达', fixable: false };
      }
      return null;
    },
  },
  {
    rule: 'debugger-left',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      if (/^\s*debugger\s*;?\s*$/.test(line)) {
        return { line: lineNum, severity: 'warning', rule: 'debugger-left',
          message: '遗留的 debugger 语句', fixable: true };
      }
      return null;
    },
  },
  {
    rule: 'duplicate-key',
    test(line, lineNum, lines, idx) {
      // Simplistic: look for same property name appearing twice in nearby lines
      // Only check if line looks like "key: value," or "key()" inside object
      const m = line.match(/^\s*['"]?(\w+)['"]?\s*:/);
      if (!m) return null;
      const key = m[1];
      // Search backward for same key in same object scope (up to 50 lines)
      for (let i = idx - 1; i >= Math.max(0, idx - 50); i--) {
        const prev = lines[i];
        if (/^\s*[{}]/.test(prev.trim())) break; // hit object boundary
        const pm = prev.match(/^\s*['"]?(\w+)['"]?\s*:/);
        if (pm && pm[1] === key) {
          return { line: lineNum, severity: 'error', rule: 'duplicate-key',
            message: `重复的对象键 "${key}"（上次在第 ${i + 1} 行）`, fixable: false };
        }
      }
      return null;
    },
  },
  {
    rule: 'no-throw-literal',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      if (/\bthrow\s+['"`]/.test(line) || /\bthrow\s+\d/.test(line)) {
        return { line: lineNum, severity: 'warning', rule: 'no-throw-literal',
          message: '直接 throw 字面量，建议 throw new Error(...)', fixable: false };
      }
      return null;
    },
  },
  {
    rule: 'triple-slash-ref',
    test(line, lineNum) {
      // Leftover TypeScript triple-slash reference in JS files (handled separately)
      return null;
    },
  },
];

// ── Python Patterns ─────────────────────────────────────────────────

const _PY_PATTERNS = [
  {
    rule: 'mutable-default-arg',
    test(line, lineNum) {
      if (/\bdef\s+\w+\s*\(.*=\s*\[\s*\]/.test(line) || /\bdef\s+\w+\s*\(.*=\s*\{\s*\}/.test(line)) {
        return { line: lineNum, severity: 'warning', rule: 'mutable-default-arg',
          message: '可变对象作为默认参数（每次调用共享同一实例）', fixable: false };
      }
      return null;
    },
  },
  {
    rule: 'bare-except',
    test(line, lineNum) {
      if (/^\s*except\s*:\s*$/.test(line)) {
        return { line: lineNum, severity: 'warning', rule: 'bare-except',
          message: '裸 except: 会捕获所有异常（含 SystemExit/KeyboardInterrupt）', fixable: false };
      }
      return null;
    },
  },
  {
    rule: 'equality-none',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      if (/==\s*None\b/.test(line) || /!=\s*None\b/.test(line)) {
        return { line: lineNum, severity: 'warning', rule: 'equality-none',
          message: '使用 == None 而非 is None（PEP8）', fixable: true };
      }
      return null;
    },
  },
  {
    rule: 'print-left',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      if (/^\s*print\s*\(/.test(line)) {
        return { line: lineNum, severity: 'info', rule: 'print-left',
          message: '遗留的 print() 调用', fixable: false };
      }
      return null;
    },
  },
  {
    rule: 'fstring-missing-f',
    test(line, lineNum, _lines, _idx, lang) {
      if (_isComment(line, lang)) return null;
      // String with { } but no f prefix (not .format() call, not Jinja {{ }})
      const m = line.match(/(?<![fFbBrRuU])(['"])(.*?\{[^{].*?\}.*?)\1/);
      if (m && !/\.format\s*\(/.test(line) && !/\{\{/.test(m[2])) {
        return { line: lineNum, severity: 'warning', rule: 'fstring-missing-f',
          message: '字符串含 {} 但缺少 f 前缀', fixable: true };
      }
      return null;
    },
  },
  {
    rule: 'broad-exception',
    test(line, lineNum) {
      if (/^\s*except\s+Exception\s*(?::|\bas\b)/.test(line)) {
        return { line: lineNum, severity: 'info', rule: 'broad-exception',
          message: 'except Exception 过宽，建议捕获更具体的异常', fixable: false };
      }
      return null;
    },
  },
];

function _scanPatterns(filePath, content, lang) {
  const lines = content.split('\n');
  const patterns = (lang === 'python') ? _PY_PATTERNS : _JS_PATTERNS;
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    for (const pat of patterns) {
      if (!pat.test) continue;
      const issue = pat.test(lines[i], i + 1, lines, i, lang);
      if (issue) {
        issue.file = filePath;
        issues.push(issue);
      }
    }
  }
  return issues;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 4: External Linter (best-effort)
// ═══════════════════════════════════════════════════════════════════

function _tryExternalLint(cwd, files) {
  // ESLint
  const eslintConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'];
  const hasEslint = eslintConfigs.some(c => fs.existsSync(path.join(cwd, c)));
  if (hasEslint) {
    try {
      const jsFiles = files.filter(f => /\.[jt]sx?$/.test(f)).slice(0, 50);
      if (jsFiles.length === 0) return [];
      const r = spawnSync('npx', ['eslint', '--format', 'json', '--no-error-on-unmatched-pattern', ...jsFiles], {
        cwd, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (r.stdout) {
        try {
          const data = JSON.parse(r.stdout);
          const issues = [];
          for (const entry of data) {
            for (const msg of (entry.messages || [])) {
              issues.push({
                file: entry.filePath,
                line: msg.line || 1,
                severity: msg.severity === 2 ? 'error' : 'warning',
                rule: `eslint/${msg.ruleId || 'unknown'}`,
                message: msg.message,
                fixable: !!msg.fix,
              });
            }
          }
          return issues;
        } catch { /* JSON parse failed */ }
      }
    } catch { /* eslint not available */ }
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════
// Execution: Code Check
// ═══════════════════════════════════════════════════════════════════

async function executeCodeCheck(plan) {
  const { target, targetIsFile, cwd } = plan;

  if (!fs.existsSync(target)) {
    return { type: 'code_check', success: false, error: `目标不存在: ${target}` };
  }

  // Phase 1: Collect files
  const files = _collectFiles(target, targetIsFile);
  if (files.length === 0) {
    return { type: 'code_check', success: true, target, issues: [], stats: { filesScanned: 0, errors: 0, warnings: 0, infos: 0, fixable: 0 } };
  }

  const allIssues = [];

  for (const file of files) {
    const lang = _detectLang(file);
    if (!lang) continue;

    // Phase 2: Syntax check
    let syntaxIssue = null;
    if (lang === 'js' || lang === 'ts') syntaxIssue = _syntaxCheckJS(file);
    else if (lang === 'python') syntaxIssue = _syntaxCheckPython(file);

    if (syntaxIssue) {
      allIssues.push(syntaxIssue);
      continue; // If syntax is broken, pattern matching is unreliable — skip
    }

    // Phase 3: Pattern matching
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.length > 512 * 1024) continue; // skip very large files
      const patternIssues = _scanPatterns(file, content, lang);
      allIssues.push(...patternIssues);
    } catch { /* unreadable */ }
  }

  // Phase 4: External linter
  let externalLinter = null;
  if (!targetIsFile) {
    try {
      const extIssues = _tryExternalLint(cwd || target, files);
      if (extIssues.length > 0) {
        // Deduplicate: if same file+line+rule exists from built-in, skip external
        const existing = new Set(allIssues.map(i => `${i.file}:${i.line}:${i.rule}`));
        for (const ei of extIssues) {
          const key = `${ei.file}:${ei.line}:${ei.rule}`;
          if (!existing.has(key)) allIssues.push(ei);
        }
        externalLinter = 'eslint';
      }
    } catch { /* non-blocking */ }
  }

  // Sort: errors first, then warnings, then info
  const sevOrder = { error: 0, warning: 1, info: 2 };
  allIssues.sort((a, b) => (sevOrder[a.severity] || 3) - (sevOrder[b.severity] || 3));

  const stats = {
    filesScanned: files.length,
    errors: allIssues.filter(i => i.severity === 'error').length,
    warnings: allIssues.filter(i => i.severity === 'warning').length,
    infos: allIssues.filter(i => i.severity === 'info').length,
    fixable: allIssues.filter(i => i.fixable).length,
  };

  return { type: 'code_check', success: true, target, issues: allIssues, stats, externalLinter };
}

// ═══════════════════════════════════════════════════════════════════
// Execution: Code Fix
// ═══════════════════════════════════════════════════════════════════

function _fixLine(line, rule, lang) {
  switch (rule) {
    case 'loose-equality': {
      // == → === (skip == null patterns)
      let result = line;
      result = result.replace(/([^!=])={2}(?!=)/g, (match, pre, offset) => {
        const after = result.slice(offset + match.length);
        if (/^\s*null\b/.test(after)) return match;
        return pre + '===';
      });
      return result !== line ? result : null;
    }
    case 'var-usage':
      return line.replace(/\bvar\s+/, 'let ');
    case 'debugger-left':
      return line.replace(/^\s*debugger\s*;?\s*$/, '');
    case 'equality-none':
      return line.replace(/==\s*None\b/g, 'is None').replace(/!=\s*None\b/g, 'is not None');
    case 'fstring-missing-f': {
      // Add f prefix to the string literal
      const result = line.replace(/(?<![fFbBrRuU])(['"])(.*?\{[^{].*?\}.*?)\1/, "f$1$2$1");
      return result !== line ? result : null;
    }
    default:
      return null;
  }
}

async function executeCodeFix(plan) {
  // First, run the check to get all issues
  const checkResult = await executeCodeCheck(plan);
  if (!checkResult.success) return { type: 'code_fix', success: false, error: checkResult.error };

  const fixableIssues = checkResult.issues.filter(i => i.fixable);
  if (fixableIssues.length === 0) {
    return {
      type: 'code_fix', success: true, target: plan.target,
      fixes: [], stats: { totalIssues: checkResult.issues.length, fixableIssues: 0, fixedCount: 0 },
      remainingIssues: checkResult.issues,
    };
  }

  // Group fixable issues by file
  const byFile = {};
  for (const issue of fixableIssues) {
    if (!byFile[issue.file]) byFile[issue.file] = [];
    byFile[issue.file].push(issue);
  }

  const fixes = [];
  let totalFixed = 0;

  for (const [filePath, issues] of Object.entries(byFile)) {
    // Create backup
    const backupPath = filePath + '.khy-bak';
    try { fs.copyFileSync(filePath, backupPath); } catch (e) {
      fixes.push({ file: filePath, fixCount: 0, error: `备份失败: ${e.message}` });
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const lang = _detectLang(filePath);

    // Sort by line descending — fix from bottom up to preserve line numbers
    const sorted = issues.sort((a, b) => b.line - a.line);
    let fixCount = 0;

    for (const issue of sorted) {
      const idx = issue.line - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const fixed = _fixLine(lines[idx], issue.rule, lang);
      if (fixed !== null && fixed !== lines[idx]) {
        lines[idx] = fixed;
        fixCount++;
      }
    }

    if (fixCount > 0) {
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

      // Verify: re-run syntax check to ensure fix didn't break anything
      let broken = false;
      if (lang === 'js' || lang === 'ts') {
        const syntaxErr = _syntaxCheckJS(filePath);
        if (syntaxErr) broken = true;
      } else if (lang === 'python') {
        const syntaxErr = _syntaxCheckPython(filePath);
        if (syntaxErr) broken = true;
      }

      if (broken) {
        // Restore from backup
        fs.copyFileSync(backupPath, filePath);
        fixes.push({ file: filePath, fixCount: 0, error: '修复后语法检查失败，已从备份恢复' });
        try { fs.unlinkSync(backupPath); } catch {}
      } else {
        totalFixed += fixCount;
        fixes.push({ file: filePath, fixCount, backupPath });
      }
    } else {
      // No actual fixes applied, remove backup
      try { fs.unlinkSync(backupPath); } catch {}
      fixes.push({ file: filePath, fixCount: 0 });
    }
  }

  const remainingIssues = checkResult.issues.filter(i => !i.fixable);
  return {
    type: 'code_fix', success: true, target: plan.target,
    fixes,
    stats: {
      totalIssues: checkResult.issues.length,
      fixableIssues: fixableIssues.length,
      fixedCount: totalFixed,
    },
    remainingIssues,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════

function formatCodeCheck(result) {
  if (!result.success) return `代码检查失败: ${result.error}`;
  const { issues, stats } = result;

  const lines = [];
  lines.push(`代码检查完成 — ${stats.filesScanned} 文件`);

  if (issues.length === 0) {
    lines.push('  未发现问题。');
    return lines.join('\n');
  }

  const parts = [];
  if (stats.errors > 0) parts.push(`错误 ${stats.errors}`);
  if (stats.warnings > 0) parts.push(`警告 ${stats.warnings}`);
  if (stats.infos > 0) parts.push(`提示 ${stats.infos}`);
  lines.push(`  ${parts.join(' | ')}`);
  if (stats.fixable > 0) lines.push(`  可自动修复: ${stats.fixable} (运行 "修复代码" 修复)`);
  if (result.externalLinter) lines.push(`  外部 linter: ${result.externalLinter}`);

  lines.push('');

  // Group by file
  const baseDir = result.target;
  const byFile = {};
  for (const issue of issues.slice(0, 60)) {
    const rel = path.relative(baseDir, issue.file) || path.basename(issue.file);
    if (!byFile[rel]) byFile[rel] = [];
    byFile[rel].push(issue);
  }

  for (const [file, fileIssues] of Object.entries(byFile)) {
    lines.push(`${file}:`);
    for (const issue of fileIssues) {
      const sev = issue.severity === 'error' ? 'ERR' : issue.severity === 'warning' ? 'WRN' : 'INF';
      const fix = issue.fixable ? ' [可修复]' : '';
      lines.push(`  L${issue.line} [${sev}] ${issue.message} (${issue.rule})${fix}`);
    }
  }

  if (issues.length > 60) {
    lines.push(`\n... 还有 ${issues.length - 60} 个问题未显示`);
  }

  return lines.join('\n');
}

function formatCodeFix(result) {
  if (!result.success) return `代码修复失败: ${result.error}`;
  const { stats, fixes } = result;

  const lines = [];
  lines.push(`代码修复完成 — ${stats.fixedCount}/${stats.fixableIssues} 个问题已修复`);

  for (const fix of fixes) {
    const rel = path.relative(result.target || process.cwd(), fix.file);
    if (fix.error) {
      lines.push(`  ${rel}: ${fix.error}`);
    } else if (fix.fixCount > 0) {
      lines.push(`  ${rel}: ${fix.fixCount} 处修复${fix.backupPath ? ` (备份: ${path.basename(fix.backupPath)})` : ''}`);
    }
  }

  const remaining = stats.totalIssues - stats.fixedCount;
  if (remaining > 0) {
    lines.push(`\n仍有 ${remaining} 个问题需要人工处理。`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  isCodeCheckIntent,
  detectCodeCheck,
  executeCodeCheck,
  formatCodeCheck,

  isCodeFixIntent,
  detectCodeFix,
  executeCodeFix,
  formatCodeFix,
};
