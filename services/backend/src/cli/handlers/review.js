/**
 * Multi-Round AI Code Review Handler
 *
 * Flow: Review → Fix → Verify → repeat until clean or max rounds.
 * Inspired by Claude Code's multi-pass review workflow.
 */
const chalk = require('chalk').default || require('chalk');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { printSuccess, printError, printInfo, printWarn, printTable, printDivider, withSpinner } = require('../formatters');

const MAX_ROUNDS = 5;
const MAX_DIFF_CHARS = 30000;

const SEVERITY_COLORS = {
  P0: chalk.red.bold,
  P1: chalk.red,
  P2: chalk.yellow,
  P3: chalk.dim,
};

// ── Git Diff Collection ─────────────────────────────────────────────

/**
 * Gather git diff (unstaged + staged).
 * @returns {{ diff: string, stats: string, files: string[] }}
 */
function gatherDiff() {
  const cwd = process.env.KHYQUANT_CWD || process.cwd();
  const opts = { encoding: 'utf-8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, cwd };

  let stats = '';
  let diff = '';

  // Try unstaged first
  try {
    stats = execSync('git diff --stat', opts).trim();
    diff = execSync('git diff', opts).trim();
  } catch { /* not a git repo or no changes */ }

  // If no unstaged changes, try staged
  if (!diff) {
    try {
      stats = execSync('git diff --cached --stat', opts).trim();
      diff = execSync('git diff --cached', opts).trim();
    } catch { /* ignore */ }
  }

  // Extract changed file list from stats
  const files = [];
  if (stats) {
    for (const line of stats.split('\n')) {
      const match = line.match(/^\s*(.+?)\s*\|/);
      if (match) files.push(match[1].trim());
    }
  }

  return { diff, stats, files };
}

// ── AI Prompt Templates ─────────────────────────────────────────────

function buildReviewPrompt(diff, stats) {
  const truncated = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + `\n... (truncated, ${diff.length} chars total)`
    : diff;

  return `你是一位资深代码审查专家。请严格审查以下 Git diff，找出所有问题。

按严重程度分类：
- P0: 致命问题（安全漏洞、数据丢失、崩溃、认证绕过）
- P1: 严重问题（逻辑错误、内存泄漏、性能问题、未处理异常）
- P2: 一般问题（输入验证缺失、冗余代码、变量未使用、注释误导）
- P3: 建议（命名改进、最佳实践、代码风格）

请以 JSON 格式输出，放在 \`\`\`json 代码块中：

\`\`\`json
[
  {
    "id": "P0-001",
    "severity": "P0",
    "file": "path/to/file.js",
    "line": 42,
    "description": "问题描述",
    "suggestion": "修复建议（含具体代码）"
  }
]
\`\`\`

如果没有发现问题，输出空数组 \`[]\`。

变更概览:
${stats || '(no stats)'}

\`\`\`diff
${truncated}
\`\`\``;
}

function buildFixPrompt(issue, fileContent, ext) {
  return `你是一位代码修复专家。请修复以下问题。

## 问题
- ID: ${issue.id}
- 严重程度: ${issue.severity}
- 文件: ${issue.file}
- 行号: ${issue.line}
- 描述: ${issue.description}
- 建议: ${issue.suggestion}

## 当前文件内容
\`\`\`${ext}
${fileContent}
\`\`\`

请输出修复后的完整文件内容，放在 \`\`\`${ext} 代码块中。
只修复上述问题，不要改动其他代码。不要添加额外注释或功能。
如果无法修复，仅输出一行: CANNOT_FIX: 原因`;
}

function buildVerifyPrompt(fixedIssues, diff) {
  const truncated = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + `\n... (truncated, ${diff.length} chars total)`
    : diff;

  const issuesSummary = fixedIssues.map(i =>
    `- ${i.id} [${i.severity}] ${i.file}:${i.line} — ${i.description}`
  ).join('\n');

  return `你是一位代码审查验证专家。请验证以下修复是否正确，并检查是否引入了新问题。

## 已修复的问题列表
${issuesSummary}

## 修复后的 Git diff
\`\`\`diff
${truncated}
\`\`\`

请以 JSON 格式输出验证结果，放在 \`\`\`json 代码块中：

\`\`\`json
{
  "verified": ["P0-001"],
  "newIssues": [
    {
      "id": "P2-NEW-001",
      "severity": "P2",
      "file": "path/to/file.js",
      "line": 50,
      "description": "修复引入的新问题",
      "suggestion": "修复建议"
    }
  ]
}
\`\`\`

如果所有修复都正确且无新问题，newIssues 为空数组。`;
}

// ── JSON Parsing (3-tier fallback) ──────────────────────────────────

/**
 * Parse AI response into Issue[]. Three-tier fallback:
 * 1. Fenced ```json block → JSON.parse
 * 2. Bare JSON array regex → JSON.parse
 * 3. Regex extraction of P0:/P1: patterns
 */
function parseIssueList(aiReply) {
  if (!aiReply) return [];

  // Tier 1: fenced json block
  const fenceMatch = aiReply.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return _validateIssues(parsed);
    } catch { /* fall through */ }
  }

  // Tier 2: bare JSON array
  const bareMatch = aiReply.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (bareMatch) {
    try {
      const parsed = JSON.parse(bareMatch[0]);
      if (Array.isArray(parsed)) return _validateIssues(parsed);
    } catch { /* fall through */ }
  }

  // Tier 3: regex extraction
  const issues = [];
  const re = /(P[0-3])[:-]\s*(\d+)?[.:\s]*([^\n]+)/g;
  let m;
  let idx = 0;
  while ((m = re.exec(aiReply)) !== null) {
    idx++;
    issues.push({
      id: `${m[1]}-${String(idx).padStart(3, '0')}`,
      severity: m[1],
      file: '',
      line: 0,
      description: m[3].trim(),
      suggestion: '',
      status: 'open',
    });
  }
  return issues;
}

function _validateIssues(arr) {
  return arr
    .filter(i => i && (i.description || i.desc))
    .map(i => ({
      id: i.id || `P2-${String(Math.random()).slice(2, 6)}`,
      severity: ['P0', 'P1', 'P2', 'P3'].includes(i.severity) ? i.severity : 'P2',
      file: i.file || '',
      line: Number(i.line) || 0,
      description: i.description || i.desc || '',
      suggestion: i.suggestion || i.fix || '',
      status: 'open',
    }));
}

/**
 * Parse AI verify response into { verified: string[], newIssues: Issue[] }.
 */
function parseVerifyResult(aiReply) {
  if (!aiReply) return { verified: [], newIssues: [] };

  const fenceMatch = aiReply.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      return {
        verified: Array.isArray(parsed.verified) ? parsed.verified : [],
        newIssues: Array.isArray(parsed.newIssues) ? _validateIssues(parsed.newIssues) : [],
      };
    } catch { /* fall through */ }
  }

  // Fallback: try bare JSON object
  const objMatch = aiReply.match(/\{\s*"verified"[\s\S]*?\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      return {
        verified: Array.isArray(parsed.verified) ? parsed.verified : [],
        newIssues: Array.isArray(parsed.newIssues) ? _validateIssues(parsed.newIssues) : [],
      };
    } catch { /* fall through */ }
  }

  return { verified: [], newIssues: [] };
}

// ── Code Extraction ─────────────────────────────────────────────────

/**
 * Extract code content from AI response (fenced code block).
 */
function extractCode(aiReply, ext) {
  if (!aiReply) return null;

  // Check for CANNOT_FIX
  if (/^CANNOT_FIX:/m.test(aiReply)) return null;

  // Try language-specific fence
  const langRe = new RegExp('```' + ext + '\\s*\\n([\\s\\S]*?)```');
  const langMatch = aiReply.match(langRe);
  if (langMatch) return langMatch[1];

  // Try generic fence (first code block that is >10 lines)
  const allFences = [...aiReply.matchAll(/```\w*\s*\n([\s\S]*?)```/g)];
  for (const fence of allFences) {
    if (fence[1].split('\n').length > 5) return fence[1];
  }

  return null;
}

// ── Round Execution ─────────────────────────────────────────────────

// Decide HOW to obtain auto-fix approval, without performing any I/O. Pure +
// exported so the "never call inquirer under the Ink TUI" guard is unit
// testable (the full handler needs a live git diff + AI). Returns one of:
//   'auto'     — autoApprove set: proceed, print info
//   'tui'      — Ink TUI owns stdin: default-allow + warn, MUST NOT use inquirer
//   'non-tty'  — piped/non-interactive: default-allow + warn
//   'prompt'   — interactive classic REPL: ask via inquirer.confirm
// `env` is injected so tests can vary the flags without touching process.env.
function decideAutoFixApproval({ autoApprove, stdinTTY, stdoutTTY, inkActive } = {}) {
  if (autoApprove) return 'auto';
  if (inkActive) return 'tui';
  if (!stdinTTY || !stdoutTTY) return 'non-tty';
  return 'prompt';
}

/**
 * Run a review round: send diff to AI, parse structured issues.
 */
async function runReviewRound(ai, diff, stats) {
  const prompt = buildReviewPrompt(diff, stats);
  const result = await ai.chat(prompt, { effort: 'max' });

  if (!result || result.errorType) {
    throw new Error(result?.reply || 'AI 不可用，请检查 AI 配置 (ai config)');
  }

  return parseIssueList(result.reply);
}

/**
 * Run a fix round: for each open issue, read file → AI fix → write file.
 */
async function runFixRound(ai, issues) {
  const fixed = [];
  const failed = [];
  const cwd = process.env.KHYQUANT_CWD || process.cwd();

  for (const issue of issues) {
    if (!issue.file) {
      failed.push(issue);
      continue;
    }

    const filePath = path.resolve(cwd, issue.file);
    const ext = path.extname(issue.file).slice(1) || 'txt';

    // Read file
    let fileContent;
    try {
      fileContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
      printWarn(`  无法读取 ${issue.file}，跳过`);
      issue.status = 'failed';
      failed.push(issue);
      continue;
    }

    // Truncate very large files: use context window around the target line
    if (fileContent.length > 50000 && issue.line > 0) {
      const lines = fileContent.split('\n');
      const start = Math.max(0, issue.line - 50);
      const end = Math.min(lines.length, issue.line + 50);
      fileContent = lines.slice(start, end).join('\n');
    }

    // Ask AI to fix
    const fixPrompt = buildFixPrompt(issue, fileContent, ext);
    const result = await ai.chat(fixPrompt, { effort: 'max' });

    if (!result || result.errorType) {
      issue.status = 'failed';
      failed.push(issue);
      continue;
    }

    const newContent = extractCode(result.reply, ext);
    if (!newContent) {
      issue.status = 'failed';
      failed.push(issue);
      continue;
    }

    // Write fixed content
    try {
      fs.writeFileSync(filePath, newContent, 'utf-8');
      issue.status = 'fixed';
      fixed.push(issue);
      console.log(`    ${chalk.green('✓')} ${issue.id} ${chalk.dim(issue.file)}`);
    } catch (err) {
      printWarn(`  写入 ${issue.file} 失败: ${err.message}`);
      issue.status = 'failed';
      failed.push(issue);
    }
  }

  return { fixed, failed };
}

/**
 * Run a verify round: check if fixes are correct, detect regressions.
 */
async function runVerifyRound(ai, fixedIssues, diff) {
  const prompt = buildVerifyPrompt(fixedIssues, diff);
  const result = await ai.chat(prompt, { effort: 'max' });

  if (!result || result.errorType) {
    return { verified: [], newIssues: [] };
  }

  return parseVerifyResult(result.reply);
}

// ── Output Formatting ───────────────────────────────────────────────

function printIssueTable(issues) {
  if (issues.length === 0) return;

  console.log('');
  printTable(
    ['ID', '等级', '文件', '描述'],
    issues.map(i => [
      i.id,
      (SEVERITY_COLORS[i.severity] || chalk.dim)(i.severity),
      chalk.cyan(i.file ? `${i.file}${i.line ? ':' + i.line : ''}` : '-'),
      i.description.length > 50 ? i.description.slice(0, 47) + '...' : i.description,
    ])
  );
  console.log('');
}

function printRoundSummary(round, stats) {
  const parts = [];
  if (stats.found !== undefined) parts.push(`发现 ${stats.found}`);
  if (stats.fixed !== undefined) parts.push(`修复 ${chalk.green(stats.fixed)}`);
  if (stats.failed > 0) parts.push(`失败 ${chalk.red(stats.failed)}`);
  if (stats.verified !== undefined) parts.push(`验证通过 ${chalk.green(stats.verified)}`);
  if (stats.newIssues > 0) parts.push(`新问题 ${chalk.yellow(stats.newIssues)}`);
  if (stats.remaining > 0) parts.push(`剩余 ${chalk.yellow(stats.remaining)}`);

  printSuccess(`第 ${round} 轮: ${parts.join(' · ')}`);
}

function printFinalSummary(roundHistory, issueMap) {
  console.log('');
  printDivider(`审查完成 (${roundHistory.length} 轮)`);
  console.log('');

  if (roundHistory.length > 0) {
    printTable(
      ['轮次', '发现', '修复', '失败', '剩余'],
      roundHistory.map(r => [
        String(r.round),
        String(r.found),
        r.fixed >= 0 ? chalk.green(String(r.fixed)) : '-',
        r.failed > 0 ? chalk.red(String(r.failed)) : '0',
        r.remaining > 0 ? chalk.yellow(String(r.remaining)) : chalk.green('0'),
      ])
    );
    console.log('');
  }

  const remaining = [...issueMap.values()].filter(i => i.status === 'open' || i.status === 'failed');
  if (remaining.length === 0) {
    printSuccess('所有问题已修复！');
  } else {
    printWarn(`剩余 ${remaining.length} 个未修复问题:`);
    for (const i of remaining) {
      const color = SEVERITY_COLORS[i.severity] || chalk.dim;
      console.log(`  ${color(i.id)} ${i.file}${i.line ? ':' + i.line : ''} — ${i.description}`);
    }
  }
  console.log('');
}

// ── Main Entry Point ────────────────────────────────────────────────

/**
 * Multi-round AI code review.
 * @param {object} [options]
 * @param {number} [options.maxRounds=5]
 * @param {boolean} [options.autoFix=true]
 */
async function handleReview(options = {}) {
  const ai = require('../ai');
  const maxRounds = options.maxRounds || MAX_ROUNDS;
  const autoFix = options.autoFix !== false;
  const autoApprove = options.autoApprove === true
    || options.yes === true
    || String(options.autoApprove || '').toLowerCase() === 'true'
    || String(options.yes || '').toLowerCase() === 'true';

  const issueMap = new Map(); // id → Issue
  const roundHistory = [];
  let previousFixed = [];

  for (let round = 1; round <= maxRounds; round++) {
    console.log('');
    printDivider(round === 1 ? `第 ${round} 轮审查` : `第 ${round} 轮验证`);

    // A. Gather diff
    let diffData;
    try {
      diffData = await withSpinner('收集 Git 差异', async () => gatherDiff());
    } catch (err) {
      printError(`Git 操作失败: ${err.message}`);
      printInfo('请确认当前目录是 Git 仓库');
      return;
    }

    if (!diffData.diff) {
      if (round === 1) {
        printInfo('没有检测到 Git 改动，无需审查');
        return;
      }
      printSuccess('所有改动已清理干净');
      break;
    }

    // B. Review or Verify
    let openIssues = [];

    if (round === 1) {
      // First round: full review
      const issues = await withSpinner('AI 审查中', async () =>
        runReviewRound(ai, diffData.diff, diffData.stats)
      );

      if (issues.length === 0) {
        printSuccess('未发现问题，代码看起来不错！');
        roundHistory.push({ round, found: 0, fixed: -1, failed: 0, remaining: 0 });
        break;
      }

      for (const i of issues) issueMap.set(i.id, i);
      printIssueTable(issues);
      openIssues = issues;

    } else {
      // Subsequent rounds: verify previous fixes + detect regressions
      const verifyResult = await withSpinner('AI 验证修复', async () =>
        runVerifyRound(ai, previousFixed, diffData.diff)
      );

      // Mark verified issues
      for (const id of verifyResult.verified) {
        const iss = issueMap.get(id);
        if (iss) iss.status = 'verified';
      }

      // Add new issues
      for (const newIss of verifyResult.newIssues) {
        issueMap.set(newIss.id, newIss);
      }

      openIssues = [...issueMap.values()].filter(i => i.status === 'open');

      const roundStats = {
        verified: verifyResult.verified.length,
        newIssues: verifyResult.newIssues.length,
        remaining: openIssues.length,
      };

      if (verifyResult.newIssues.length > 0) {
        printIssueTable(verifyResult.newIssues);
      }

      if (openIssues.length === 0) {
        printRoundSummary(round, roundStats);
        roundHistory.push({ round, found: verifyResult.newIssues.length, fixed: -1, failed: 0, remaining: 0 });
        break;
      }

      printRoundSummary(round, roundStats);
    }

    // C. Fix phase
    if (!autoFix) {
      roundHistory.push({ round, found: openIssues.length, fixed: -1, failed: 0, remaining: openIssues.length });
      printInfo('审查完成 (自动修复已禁用)');
      break;
    }

    // Confirm with user before fixing
    if (round === 1) {
      const fileSet = new Set(openIssues.filter(i => i.file).map(i => i.file));
      console.log(`  ${chalk.cyan('?')} AI 将修复 ${openIssues.length} 个问题，涉及 ${fileSet.size} 个文件`);

      let proceed = true;
      const approvalMode = decideAutoFixApproval({
        autoApprove,
        stdinTTY: process.stdin.isTTY,
        stdoutTTY: process.stdout.isTTY,
        inkActive: process.env.KHY_INK_TUI_ACTIVE === '1',
      });
      if (approvalMode === 'auto') {
        printInfo('已启用自动确认，继续执行 AI 自动修复');
      } else if (approvalMode === 'tui') {
        // Under the Ink TUI, real inquirer would topple the UI (it fights ink
        // for stdin in raw mode; stdin.isTTY is still true so the non-TTY branch
        // never catches it). Phase 3: collect a REAL confirm through the native
        // uiPrompt bridge (FormFlow overlay) instead of the 0.2 default-allow
        // stopgap, so the user actually decides. promptCompat falls back to real
        // inquirer automatically if the bridge is somehow unregistered.
        const { promptCompat } = require('../uiPrompt');
        const answer = await promptCompat([{
          type: 'confirm',
          name: 'proceed',
          message: '是否允许 AI 自动修复？',
          default: true,
        }]);
        // A native Esc/cancel yields {} → treat as "no decision" = decline, the
        // safe default for a mutating action the user did not actively approve.
        proceed = answer && 'proceed' in answer ? !!answer.proceed : false;
      } else if (approvalMode === 'non-tty') {
        printWarn('非交互环境，默认允许 AI 自动修复（可用 autoApprove=false 关闭）');
      } else {
        const { promptCompat } = require('../uiPrompt');
        const answer = await promptCompat([{
          type: 'confirm',
          name: 'proceed',
          message: '是否允许 AI 自动修复？',
          default: true,
        }]);
        proceed = !!answer.proceed;
      }

      if (!proceed) {
        roundHistory.push({ round, found: openIssues.length, fixed: 0, failed: 0, remaining: openIssues.length });
        printInfo('已取消自动修复');
        break;
      }
    }

    console.log(`  ${chalk.cyan('⚡')} 修复中...`);
    const fixResult = await runFixRound(ai, openIssues);
    previousFixed = fixResult.fixed;

    const remaining = [...issueMap.values()].filter(i => i.status === 'open');
    const roundStats = {
      found: openIssues.length,
      fixed: fixResult.fixed.length,
      failed: fixResult.failed.length,
      remaining: remaining.length,
    };

    printRoundSummary(round, roundStats);
    roundHistory.push({ round, ...roundStats });

    // Check if done
    if (remaining.length === 0 && fixResult.fixed.length > 0) {
      // All fixed, but need one more verify round
      continue;
    }

    if (fixResult.fixed.length === 0) {
      // Nothing was fixed this round, stop to prevent infinite loop
      printWarn('本轮无法修复更多问题，停止审查');
      break;
    }
  }

  // Final summary
  printFinalSummary(roundHistory, issueMap);
}

module.exports = { handleReview, decideAutoFixApproval };
