'use strict';

/**
 * Verification Agent — adversarial post-implementation testing.
 *
 * After code changes, spawns a lightweight verification pass that:
 *   1. Runs syntax checks on modified files
 *   2. Runs linters (if configured)
 *   3. Runs test suites (if present)
 *   4. Runs build (if configured)
 *   5. Reports pass/fail with actionable feedback
 *
 * Inspired by Claude Code's verification agent that runs adversarially
 * against implementation changes.
 *
 * @module verificationAgent
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const { findPython } = require('../utils/pythonPath');
const path = require('path');
const log = require('../utils/logger');
const { extractFirstJson } = require('./gateway/safeJsonParse');

// ── Constants ──────────────────────────────────────────────────────

const VERIFICATION_TIMEOUT = 60000; // 60s per step
const MAX_OUTPUT_CHARS = 5000;

// ── Detectors ──────────────────────────────────────────────────────

/**
 * Detect project type and available verification steps.
 * @param {string} cwd - Project root
 * @returns {{ type: string, steps: string[] }}
 */
function detectProject(cwd) {
  const steps = [];
  let type = 'unknown';

  // Node.js
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    type = 'node';
    steps.push('syntax');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts) {
        if (pkg.scripts.lint) steps.push('lint');
        if (pkg.scripts.test) steps.push('test');
        if (pkg.scripts.build) steps.push('build');
        if (pkg.scripts.typecheck || pkg.scripts['type-check']) steps.push('typecheck');
      }
    } catch { /* skip */ }
    return { type, steps };
  }

  // Python
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
    type = 'python';
    steps.push('syntax');
    if (_commandExists('ruff')) steps.push('lint');
    else if (_commandExists('flake8')) steps.push('lint');
    if (_commandExists('pytest')) steps.push('test');
    return { type, steps };
  }

  // Rust
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    type = 'rust';
    steps.push('build'); // cargo check
    if (_commandExists('cargo')) {
      steps.push('test');
      steps.push('lint'); // clippy
    }
    return { type, steps };
  }

  // Go
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    type = 'go';
    steps.push('build'); // go build
    steps.push('test');
    if (_commandExists('golangci-lint')) steps.push('lint');
    return { type, steps };
  }

  return { type, steps };
}

function _commandExists(cmd) {
  try {
    const check = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── Step Runners ───────────────────────────────────────────────────

/**
 * Run syntax check on modified files.
 * @param {string[]} files - Modified file paths
 * @param {string} projectType
 * @param {string} cwd
 * @returns {{ pass: boolean, output: string }}
 */
function _runSyntaxCheck(files, projectType, cwd) {
  const errors = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    try {
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        execSync(`node -c "${file}"`, { cwd, timeout: 10000, stdio: 'pipe' });
      } else if (ext === '.py') {
        const pyBin = findPython();
        execSync(`"${pyBin}" -c "import py_compile; py_compile.compile('${file}', doraise=True)"`, {
          cwd, timeout: 10000, stdio: 'pipe',
        });
      } else if (ext === '.json') {
        JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf-8'));
      }
    } catch (err) {
      errors.push(`${file}: ${(err.stderr || err.message || '').toString().slice(0, 200)}`);
    }
  }

  return {
    pass: errors.length === 0,
    output: errors.length > 0 ? errors.join('\n') : 'All files pass syntax check',
  };
}

/**
 * Run a npm/yarn/pnpm script.
 * @param {string} script - Script name
 * @param {string} cwd
 * @returns {{ pass: boolean, output: string }}
 */
function _runNpmScript(script, cwd) {
  // Detect package manager
  let pm = 'npm';
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) pm = 'pnpm';
  else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) pm = 'yarn';

  try {
    const result = spawnSync(pm, ['run', script], {
      cwd,
      timeout: VERIFICATION_TIMEOUT,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.slice(0, MAX_OUTPUT_CHARS);
    return { pass: result.status === 0, output };
  } catch (err) {
    return { pass: false, output: err.message.slice(0, MAX_OUTPUT_CHARS) };
  }
}

/**
 * Run Python linter.
 * @param {string[]} files
 * @param {string} cwd
 * @returns {{ pass: boolean, output: string }}
 */
function _runPythonLint(files, cwd) {
  const pyFiles = files.filter(f => f.endsWith('.py'));
  if (pyFiles.length === 0) return { pass: true, output: 'No Python files to lint' };

  const linter = _commandExists('ruff') ? 'ruff check' : 'flake8';
  try {
    const result = spawnSync(linter.split(' ')[0], [...linter.split(' ').slice(1), ...pyFiles], {
      cwd, timeout: VERIFICATION_TIMEOUT, encoding: 'utf-8', stdio: 'pipe',
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.slice(0, MAX_OUTPUT_CHARS);
    return { pass: result.status === 0, output };
  } catch (err) {
    return { pass: false, output: err.message };
  }
}

/**
 * Run Rust verification (cargo check + clippy).
 * @param {string} step - 'build', 'lint', or 'test'
 * @param {string} cwd
 * @returns {{ pass: boolean, output: string }}
 */
function _runCargoStep(step, cwd) {
  const commands = {
    build: ['cargo', ['check', '--quiet']],
    lint: ['cargo', ['clippy', '--', '-D', 'warnings']],
    test: ['cargo', ['test', '--quiet']],
  };
  const [cmd, args] = commands[step] || commands.build;
  try {
    const result = spawnSync(cmd, args, {
      cwd, timeout: VERIFICATION_TIMEOUT, encoding: 'utf-8', stdio: 'pipe',
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.slice(0, MAX_OUTPUT_CHARS);
    return { pass: result.status === 0, output };
  } catch (err) {
    return { pass: false, output: err.message };
  }
}

/**
 * Run Go verification.
 * @param {string} step
 * @param {string} cwd
 * @returns {{ pass: boolean, output: string }}
 */
function _runGoStep(step, cwd) {
  const commands = {
    build: ['go', ['build', './...']],
    test: ['go', ['test', './...']],
    lint: ['golangci-lint', ['run']],
  };
  const [cmd, args] = commands[step] || commands.build;
  try {
    const result = spawnSync(cmd, args, {
      cwd, timeout: VERIFICATION_TIMEOUT, encoding: 'utf-8', stdio: 'pipe',
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.slice(0, MAX_OUTPUT_CHARS);
    return { pass: result.status === 0, output };
  } catch (err) {
    return { pass: false, output: err.message };
  }
}

// ── Main Verification Pipeline ─────────────────────────────────────

/**
 * Run the full verification pipeline against changed files.
 *
 * @param {object} params
 * @param {string[]} params.files - List of modified file paths (relative to cwd)
 * @param {string} [params.cwd] - Project root directory
 * @param {string[]} [params.skipSteps] - Steps to skip
 * @param {boolean} [params.failFast=false] - Stop at first failure
 * @returns {{ passed: boolean, steps: Array<{ name: string, pass: boolean, output: string, durationMs: number }>, summary: string }}
 */
function verify(params) {
  const cwd = params.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const files = params.files || [];
  const skipSteps = new Set(params.skipSteps || []);
  const failFast = params.failFast || false;

  const { type, steps } = detectProject(cwd);
  const results = [];
  let allPassed = true;

  for (const step of steps) {
    if (skipSteps.has(step)) continue;

    const start = Date.now();
    let result;

    try {
      switch (step) {
        case 'syntax':
          result = _runSyntaxCheck(files, type, cwd);
          break;
        case 'lint':
          if (type === 'node') result = _runNpmScript('lint', cwd);
          else if (type === 'python') result = _runPythonLint(files, cwd);
          else if (type === 'rust') result = _runCargoStep('lint', cwd);
          else if (type === 'go') result = _runGoStep('lint', cwd);
          else result = { pass: true, output: 'No linter available' };
          break;
        case 'typecheck':
          result = _runNpmScript(step === 'typecheck' ? 'typecheck' : 'type-check', cwd);
          break;
        case 'test':
          if (type === 'node') result = _runNpmScript('test', cwd);
          else if (type === 'python') {
            try {
              const r = spawnSync('pytest', ['--tb=short', '-q'], {
                cwd, timeout: VERIFICATION_TIMEOUT, encoding: 'utf-8', stdio: 'pipe',
              });
              result = { pass: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.slice(0, MAX_OUTPUT_CHARS) };
            } catch (e) {
              result = { pass: false, output: e.message };
            }
          }
          else if (type === 'rust') result = _runCargoStep('test', cwd);
          else if (type === 'go') result = _runGoStep('test', cwd);
          else result = { pass: true, output: 'No test runner available' };
          break;
        case 'build':
          if (type === 'node') result = _runNpmScript('build', cwd);
          else if (type === 'rust') result = _runCargoStep('build', cwd);
          else if (type === 'go') result = _runGoStep('build', cwd);
          else result = { pass: true, output: 'No build step available' };
          break;
        default:
          result = { pass: true, output: `Unknown step: ${step}` };
      }
    } catch (err) {
      result = { pass: false, output: `Step error: ${err.message}` };
    }

    const durationMs = Date.now() - start;
    results.push({ name: step, pass: result.pass, output: result.output, durationMs });

    if (!result.pass) {
      allPassed = false;
      if (failFast) break;
    }
  }

  // Build summary
  const passCount = results.filter(r => r.pass).length;
  const failCount = results.filter(r => !r.pass).length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const failNames = results.filter(r => !r.pass).map(r => r.name);

  let summary;
  if (results.length === 0) {
    summary = `No verification steps detected for ${type} project.`;
  } else if (allPassed) {
    summary = `All ${passCount} verification step(s) passed (${totalMs}ms).`;
  } else {
    summary = `${failCount}/${results.length} step(s) failed: ${failNames.join(', ')} (${totalMs}ms).`;
  }

  return { passed: allPassed, steps: results, summary, projectType: type };
}

/**
 * Quick syntax-only verification for a list of files.
 * Used as a lightweight post-edit check.
 *
 * @param {string[]} files - Absolute or relative paths
 * @param {string} [cwd]
 * @returns {{ pass: boolean, errors: string[] }}
 */
function quickSyntaxCheck(files, cwd) {
  cwd = cwd || process.env.KHYQUANT_CWD || process.cwd();
  const result = _runSyntaxCheck(files, 'auto', cwd);
  return {
    pass: result.pass,
    errors: result.pass ? [] : result.output.split('\n').filter(Boolean),
  };
}

// ── Adversarial Verification (借鉴 Claude Code verificationAgent.ts) ──

/**
 * VERDICT 协议: 结构化输出裁定。
 * 解析 AI 验证 agent 的输出，提取 VERDICT: PASS/FAIL/PARTIAL。
 */
const VERDICT_RE = /VERDICT\s*:\s*(PASS|FAIL|PARTIAL)/i;

/**
 * 对抗性验证 — 使用 AI 审查变更，尝试找出边界用例和遗漏。
 *
 * 设计借鉴 Claude Code 的 Verification Agent:
 * - read-only: 只允许读取工具，禁止写入
 * - 反躲避指令: 要求执行实际检查命令而非解释
 * - VERDICT 协议: 结构化裁定输出
 *
 * @param {object} params
 * @param {string[]} params.files - 变更文件列表
 * @param {string} [params.cwd]
 * @param {string} [params.taskDescription] - 原始任务描述
 * @param {function} [params.executeAI] - AI 执行函数 (prompt) => response
 * @param {object} [params.toolResults] - 之前的工具执行结果
 * @returns {Promise<{ verdict: 'PASS'|'FAIL'|'PARTIAL'|'SKIP', checks: object[], rawOutput: string, summary: string }>}
 */
async function adversarialVerify(params) {
  const cwd = params.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const files = params.files || [];
  const taskDescription = params.taskDescription || '';

  // 如果没有 AI 执行函数，退回静态验证
  if (!params.executeAI) {
    const staticResult = verify({ files, cwd, failFast: false });
    return {
      verdict: staticResult.passed ? 'PASS' : 'FAIL',
      checks: staticResult.steps.map(s => ({
        command: s.name, output: s.output, result: s.pass ? 'PASS' : 'FAIL',
      })),
      rawOutput: staticResult.summary,
      summary: staticResult.summary,
      _source: 'static',
    };
  }

  // 构建对抗性验证 prompt
  const fileList = files.map(f => `- ${f}`).join('\n');
  const prompt = _buildAdversarialPrompt(taskDescription, fileList, cwd);

  try {
    const response = await params.executeAI(prompt);
    const rawOutput = typeof response === 'string' ? response : (response.content || response.text || '');

    // Primary channel: a structured JSON verdict block. The model is asked to
    // emit { "verdict": "...", "checks": [...] } so the control flow consuming
    // this result reads machine-typed fields rather than scraping prose.
    const structured = _parseStructuredVerdict(rawOutput);
    const verdict = structured ? structured.verdict
      // Fallback: recover the verdict from the human-readable VERDICT: line.
      : (rawOutput.match(VERDICT_RE) ? rawOutput.match(VERDICT_RE)[1].toUpperCase() : 'PARTIAL');

    // Prefer structured checks; fall back to line-oriented prose parsing.
    const checks = structured && structured.checks.length
      ? structured.checks
      : _parseAdversarialChecks(rawOutput);

    // 生成摘要
    const passCount = checks.filter(c => c.result === 'PASS').length;
    const failCount = checks.filter(c => c.result === 'FAIL').length;
    const summary = `对抗性验证: ${verdict} (${passCount} 通过, ${failCount} 失败, ${checks.length} 项检查)`;

    return { verdict, checks, rawOutput, summary, _source: 'adversarial' };
  } catch (err) {
    return {
      verdict: 'SKIP',
      checks: [],
      rawOutput: `对抗性验证失败: ${err.message}`,
      summary: `对抗性验证跳过: ${err.message}`,
      _source: 'error',
    };
  }
}

/**
 * 构建对抗性验证 prompt (借鉴 Claude Code VERIFICATION_SYSTEM_PROMPT).
 * @private
 */
function _buildAdversarialPrompt(taskDescription, fileList, cwd) {
  return `你是一个**验证代理**。你的唯一任务是验证以下变更是否正确完成。

## 规则 (不可违反)
1. 你只能使用**只读工具**: read_file、grep、glob、shell(仅限 cat/ls/git diff/node -c/python -c 等只读命令)
2. **禁止**修改任何文件
3. 每项检查必须执行实际命令并记录结果
4. 完成后**必须**输出一个结构化 JSON 裁决块(机器读取的唯一权威通道),用 \`\`\`json 围栏包裹:
   \`\`\`json
   {"verdict": "PASS|FAIL|PARTIAL", "checks": [{"command": "你执行的命令", "output": "实际输出摘要", "result": "PASS|FAIL"}]}
   \`\`\`

## 已知失败模式 (反躲避指令)
- 如果你发现自己在写解释而不是运行命令 → 停下来，运行命令
- 如果前 80% 通过就想判 PASS → 检查最后 20%
- 如果某个检查无法运行 → 判 PARTIAL，不要判 PASS

## 任务描述
${taskDescription || '(未提供)'}

## 变更文件
${fileList || '(无)'}

## 工作目录
${cwd}

## 验证清单
1. 所有变更文件语法正确 (node -c / python -c)
2. 变更是否符合任务描述的要求
3. 是否有明显的边界条件遗漏
4. 导入/导出是否一致 (新增的函数是否在 module.exports 中)
5. 是否引入了安全风险 (硬编码密钥/路径遍历/注入)

开始验证，结束时输出上述 JSON 裁决块:`;
}

/**
 * 解析结构化 JSON 裁决块(机器读取的权威通道)。
 * 容忍模型在 JSON 前后附带散文/代码围栏;无法恢复合法裁决时返回 null,
 * 由调用方退回到 VERDICT/Result 散文正则兜底。
 * @private
 * @returns {{ verdict: 'PASS'|'FAIL'|'PARTIAL', checks: object[] } | null}
 */
function _parseStructuredVerdict(output) {
  const obj = extractFirstJson(output, null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const verdict = String(obj.verdict || '').toUpperCase();
  if (!['PASS', 'FAIL', 'PARTIAL'].includes(verdict)) return null;

  const checks = Array.isArray(obj.checks)
    ? obj.checks.map(c => ({
        command: String(c?.command || '').trim(),
        output: String(c?.output || '').trim(),
        result: String(c?.result || 'PASS').toUpperCase() === 'FAIL' ? 'FAIL' : 'PASS',
      }))
    : [];

  return { verdict, checks };
}

/**
 * 解析对抗性验证输出中的检查项。
 * @private
 */
function _parseAdversarialChecks(output) {
  const checks = [];
  const lines = output.split('\n');
  let currentCheck = null;

  for (const line of lines) {
    const cmdMatch = line.match(/Command\s*run\s*:\s*(.+)/i);
    if (cmdMatch) {
      if (currentCheck) checks.push(currentCheck);
      currentCheck = { command: cmdMatch[1].trim(), output: '', result: 'PASS' };
      continue;
    }

    const outputMatch = line.match(/Output\s*observed\s*:\s*(.+)/i);
    if (outputMatch && currentCheck) {
      currentCheck.output = outputMatch[1].trim();
      continue;
    }

    const resultMatch = line.match(/Result\s*:\s*(PASS|FAIL)/i);
    if (resultMatch && currentCheck) {
      currentCheck.result = resultMatch[1].toUpperCase();
      continue;
    }
  }

  if (currentCheck) checks.push(currentCheck);
  return checks;
}

/**
 * Lightweight evidence-sufficiency self-check for NON-edit, multi-step work
 * (research / shell / API tasks that produced no file modifications).
 *
 * The adversarial file gate above is meaningless when nothing was written, but
 * a research or shell task can still conclude prematurely on thin evidence. This
 * runs a single cheap model probe: given the task, the gathered evidence, and
 * the draft conclusion, is the conclusion actually supported? It is deliberately
 * NOT the full adversarialVerify (no syntax/test/build steps) to keep cost low.
 *
 * @param {object} params
 * @param {string} params.taskDescription - The user's task.
 * @param {Array}  [params.toolResults]   - toolCallLog-style entries for evidence.
 * @param {string} [params.draftConclusion] - The model's about-to-be-final reply.
 * @param {function} params.executeAI     - async (prompt) => string.
 * @returns {Promise<{verdict:string, gaps:string[], summary:string, _source:string}>}
 */
async function evidenceSufficiencyCheck(params = {}) {
  const taskDescription = String(params.taskDescription || '').slice(0, 1500);
  const draftConclusion = String(params.draftConclusion || '').slice(0, 2000);
  const toolResults = Array.isArray(params.toolResults) ? params.toolResults : [];

  if (!params.executeAI) {
    return { verdict: 'SKIP', gaps: [], summary: 'no executeAI provided', _source: 'static' };
  }

  // Compact evidence digest — tool name + a short slice of each result.
  const evidence = toolResults.slice(-12).map((t, i) => {
    const out = t && t.result
      ? String(t.result.output || t.result.content || t.result.text || (t.result.success === false ? `error: ${t.result.error || ''}` : ''))
      : '';
    return `  ${i + 1}. ${t.tool || 'tool'} → ${out.replace(/\s+/g, ' ').slice(0, 200)}`;
  }).join('\n') || '  (no tool output captured)';

  const prompt = [
    'You are a strict reviewer checking whether a draft answer is actually supported by the evidence gathered so far.',
    'This task produced NO file changes, so judge research/command sufficiency, not code correctness.',
    '',
    `TASK:\n${taskDescription || '(unspecified)'}`,
    '',
    `EVIDENCE GATHERED (tool calls and their outputs):\n${evidence}`,
    '',
    `DRAFT CONCLUSION:\n${draftConclusion || '(empty)'}`,
    '',
    'Decide: is the draft conclusion sufficiently and accurately supported by the evidence above?',
    'A FAIL means key claims are unverified, evidence is missing/contradictory, or the task is not actually complete.',
    'Reply with a single JSON object only:',
    '{ "verdict": "PASS" | "FAIL", "gaps": ["concrete missing-evidence or unfinished item", ...] }',
  ].join('\n');

  // Optional single-lens constraint (used by the ensemble layer to make each
  // skeptic review from ONE perspective). Absent → unchanged behaviour.
  const finalPrompt = params.lens
    ? `${prompt}\n\n本轮你**只**从以下角度审查,发现该角度任何问题即判 FAIL:\n${params.lens}`
    : prompt;

  try {
    const response = await params.executeAI(finalPrompt);
    const rawOutput = typeof response === 'string' ? response : (response.content || response.text || '');
    const obj = extractFirstJson(rawOutput, null);
    let verdict = 'PASS';
    let gaps = [];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      verdict = String(obj.verdict || '').toUpperCase() === 'FAIL' ? 'FAIL' : 'PASS';
      if (Array.isArray(obj.gaps)) {
        gaps = obj.gaps.map(g => String(g || '').trim()).filter(Boolean).slice(0, 8);
      }
    } else if (/\bFAIL\b/i.test(rawOutput)) {
      verdict = 'FAIL';
    }
    const summary = `证据充分性自检: ${verdict}${gaps.length ? ` (${gaps.length} 项待补)` : ''}`;
    return { verdict, gaps, summary, _source: 'evidence' };
  } catch (err) {
    return { verdict: 'SKIP', gaps: [], summary: `证据自检跳过: ${err.message}`, _source: 'error' };
  }
}

// ── Ensemble adversarial voting (multi-skeptic, diverse lenses) ─────
//
// A single verifier can miss failure modes a different perspective would
// catch. The ensemble layer fans out N skeptic probes, each constrained to
// ONE lens, then tallies a deterministic majority vote. It is OFF by default:
// KHY_VERIFY_ENSEMBLE=1 (or unset) delegates straight to the single-verifier
// functions above, so behaviour is byte-identical to today.

// Diverse review angles. Each skeptic gets exactly one, so the ensemble covers
// failure modes that a single all-purpose pass tends to blur together.
const ADVERSARIAL_LENSES = [
  '正确性:逐项核对变更是否真正实现任务要求,功能逻辑有无错误。',
  '安全与边界:检查边界条件遗漏、空/越界/异常输入、硬编码密钥、路径遍历、注入风险。',
  '契约一致性:检查导入/导出是否齐全(新增函数是否在 module.exports)、调用方与被调方签名是否匹配、返回形状是否一致。',
];

const EVIDENCE_LENSES = [
  '事实支撑:逐条核对结论中的关键断言是否有对应证据支撑,有无未经验证即下结论。',
  '完整性:检查任务是否真正完成,是否有要求点被遗漏或只做了一半。',
  '内部矛盾:检查结论内部、或结论与所获证据之间是否存在自相矛盾。',
];

/** Clamp an env/param integer into [min,max], falling back to def. @private */
function _clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/**
 * Deterministic, model-free vote tally over per-skeptic verdicts.
 *
 * Only voters that returned a decisive verdict ('PASS'|'FAIL') count toward the
 * quorum: 'SKIP'/'PARTIAL'/error voters are abstentions (NOT failures), so model
 * jitter or timeouts can never by themselves block delivery. FAIL wins when the
 * number of FAIL votes reaches the quorum of *successful* voters (default
 * majority = ceil(ok/2)). Aggregated FAIL evidence is de-duplicated.
 *
 * @param {Array<{verdict:string, checks?:object[], gaps?:string[]}>} votes
 * @param {{quorum?:number|string, kind?:'checks'|'gaps'}} [opts]
 * @returns {{verdict:string, votes:number, ok:number, fail:number, _source:string, checks?:object[], gaps?:string[]}}
 * @private
 */
function _tallyVotes(votes, opts = {}) {
  const list = Array.isArray(votes) ? votes : [];
  const kind = opts.kind === 'gaps' ? 'gaps' : 'checks';
  const decisive = list.filter(v => v && (v.verdict === 'PASS' || v.verdict === 'FAIL'));
  const ok = decisive.length;
  const fail = decisive.filter(v => v.verdict === 'FAIL').length;

  // No decisive voter at all → abstain (SKIP is treated as pass downstream).
  if (ok === 0) {
    return { verdict: 'SKIP', [kind]: [], votes: list.length, ok: 0, fail: 0, _source: 'ensemble' };
  }

  const quorum = _clampInt(opts.quorum, Math.ceil(ok / 2), 1, ok);
  const verdict = fail >= quorum ? 'FAIL' : 'PASS';

  // Aggregate evidence from FAIL voters, de-duplicated.
  const seen = new Set();
  const aggregated = [];
  for (const v of decisive) {
    if (kind === 'checks') {
      for (const c of (v.checks || [])) {
        if (!c || c.result !== 'FAIL') continue;
        const key = `${c.command}::${c.output}`;
        if (seen.has(key)) continue;
        seen.add(key);
        aggregated.push(c);
      }
    } else {
      for (const g of (v.gaps || [])) {
        const key = String(g || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        aggregated.push(key);
      }
    }
  }

  return { verdict, [kind]: aggregated, votes: list.length, ok, fail, _source: 'ensemble' };
}

/**
 * One lens-constrained adversarial probe. Never throws — a failed probe
 * abstains ('SKIP') rather than counting as a FAIL.
 * @private
 */
async function _oneAdversarialVote(params, lens) {
  const cwd = params.cwd || process.env.KHYQUANT_CWD || process.cwd();
  const files = params.files || [];
  const fileList = files.map(f => `- ${f}`).join('\n');
  const prompt = _buildAdversarialPrompt(params.taskDescription || '', fileList, cwd)
    + `\n\n## 本轮视角约束\n本轮你**只**从以下角度审查,发现该角度任何问题即判 FAIL:\n${lens}`;
  try {
    const response = await params.executeAI(prompt);
    const rawOutput = typeof response === 'string' ? response : (response.content || response.text || '');
    const structured = _parseStructuredVerdict(rawOutput);
    const verdict = structured ? structured.verdict
      : (rawOutput.match(VERDICT_RE) ? rawOutput.match(VERDICT_RE)[1].toUpperCase() : 'PARTIAL');
    const checks = structured && structured.checks.length ? structured.checks : _parseAdversarialChecks(rawOutput);
    return { verdict, checks };
  } catch (err) {
    return { verdict: 'SKIP', checks: [] };
  }
}

/**
 * Multi-skeptic adversarial verification for code changes. Drop-in superset of
 * adversarialVerify: with n<=1 (default) or no executeAI it delegates to the
 * single verifier unchanged; with n>1 it fans out diverse-lens probes and
 * tallies a majority FAIL vote.
 *
 * @param {object} params - adversarialVerify params + { n?, quorum? }
 * @returns {Promise<{verdict:string, checks:object[], summary:string, votes?:number, _source:string}>}
 */
async function adversarialVerifyEnsemble(params = {}) {
  const n = _clampInt(params.n != null ? params.n : process.env.KHY_VERIFY_ENSEMBLE, 1, 1, 5);
  if (n <= 1 || !params.executeAI) {
    return adversarialVerify(params);
  }
  const quorum = params.quorum != null ? params.quorum : process.env.KHY_VERIFY_ENSEMBLE_QUORUM;
  const votes = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      _oneAdversarialVote(params, ADVERSARIAL_LENSES[i % ADVERSARIAL_LENSES.length])),
  );
  const tally = _tallyVotes(votes, { quorum, kind: 'checks' });
  tally.summary = `集成对抗验证: ${tally.verdict} (${n} 视角, ${tally.fail}/${tally.ok} 判否, ${(tally.checks || []).length} 项失败证据)`;
  tally.rawOutput = tally.summary;
  return tally;
}

/**
 * Multi-skeptic evidence-sufficiency check for non-edit work. Drop-in superset
 * of evidenceSufficiencyCheck with the same delegation rule.
 *
 * @param {object} params - evidenceSufficiencyCheck params + { n?, quorum? }
 * @returns {Promise<{verdict:string, gaps:string[], summary:string, votes?:number, _source:string}>}
 */
async function evidenceSufficiencyEnsemble(params = {}) {
  const n = _clampInt(params.n != null ? params.n : process.env.KHY_VERIFY_ENSEMBLE, 1, 1, 5);
  if (n <= 1 || !params.executeAI) {
    return evidenceSufficiencyCheck(params);
  }
  const quorum = params.quorum != null ? params.quorum : process.env.KHY_VERIFY_ENSEMBLE_QUORUM;
  const votes = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      evidenceSufficiencyCheck({ ...params, lens: EVIDENCE_LENSES[i % EVIDENCE_LENSES.length] })
        .then(r => ({ verdict: r.verdict, gaps: r.gaps || [] }))
        .catch(() => ({ verdict: 'SKIP', gaps: [] }))),
  );
  const tally = _tallyVotes(votes, { quorum, kind: 'gaps' });
  tally.summary = `集成证据自检: ${tally.verdict} (${n} 视角, ${tally.fail}/${tally.ok} 判否, ${(tally.gaps || []).length} 项待补)`;
  return tally;
}

module.exports = {
  verify,
  quickSyntaxCheck,
  detectProject,
  adversarialVerify,
  evidenceSufficiencyCheck,
  adversarialVerifyEnsemble,
  evidenceSufficiencyEnsemble,
  _tallyVotes,
  ADVERSARIAL_LENSES,
  EVIDENCE_LENSES,
  VERIFICATION_TIMEOUT,
};
