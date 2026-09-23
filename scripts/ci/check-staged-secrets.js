#!/usr/bin/env node
'use strict';

/**
 * check-staged-secrets.js — 暂存区敏感信息检查（读 hygiene-allowlist.json 豁免）
 *
 * 取代 .githooks/pre-commit 第 3 步原来的裸 `grep -iE`。原实现有两个问题：
 *
 *   1. **不读白名单**：仓内已有 scripts/release/hygiene-allowlist.json
 *      （由 scripts/lib/releaseHygieneGuard.js 的 matchExemption() 消费），
 *      但发布期扫描器 source-hygiene-scan.js 是 S1（只记录、恒 exit 0），
 *      挡不住提交 ⇒ 提交期只能靠裸 grep，于是测试夹具与白名单自身全部误拦。
 *   2. **无词边界**：`sk-[a-z0-9]{16,}` 会把 `ta`**`sk-t`**`emplate-hint-injection`
 *      这类标识符判成密钥形态 ⇒ CODEOWNERS / 维护映射表 等大批假红。
 *
 * 用法: node scripts/ci/check-staged-secrets.js [--json]
 * 退出: 0 干净 / 1 有 finding / 2 用法错误
 *
 * ⚠ 形态集合与 scripts/lib/releaseHygieneGuard.js 的 SECRET_PATTERNS **有意不同**：
 *   此处**行为兼容**原钩子（不扩大检出面），只补 `\b` 词边界。
 *   SECRET_PATTERNS 更宽（多 slack-token / jwt-bearer，且字符集含 `-` `_`），
 *   直接切换会让 13 处测试夹具新增阻断 —— 那是把问题放大而非修误报，
 *   属于单独的守卫设计变更，不在本次夹带。两者的统一应另开一轮。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { matchExemption } = require('../lib/releaseHygieneGuard');

const REPO_ROOT = process.env.KHY_RULEGUARD_ROOT
  ? path.resolve(process.env.KHY_RULEGUARD_ROOT)
  : path.resolve(__dirname, '..', '..');

const ALLOWLIST_REL = 'scripts/release/hygiene-allowlist.json';

// 提交期形态集合 —— 与原 .githooks/pre-commit 第 3 步行为兼容，仅补 `\b`。
const COMMIT_PATTERNS = Object.freeze([
  ['provider-key', /\bsk-[a-z0-9]{16,}\b/i],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bghp_[A-Za-z0-9]{20,}\b/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
]);

// 白名单文件自身的处理：它的内容**只由**「密钥形态字面量」构成（每条豁免的 match
// 字段就是那个字面量），因此扫它必然自指命中。
//
// ⚠ 试过「给它加自指条目」的做法，不成立：每新增 N 条夹具豁免，就往同一个文件里
//   新增 N 个字面量，又各需一条自指条目 —— 平方级增长（实测：加了 4 条夹具豁免，
//   立刻多出 4 处自指命中，批次 06 被拦）。
// ⚠ 也试过「整文件跳过」，不成立：那会漏掉「有人把真钥匙粘进白名单的 reason 字段」。
//
// 最终判据：**凡作为白名单 `match` 字段出现的值，本身就是豁免集，扫它属同义反复** ——
// 因此对白名单文件，仅豁免这些值；写在 reason / $note / 其它字段里的密钥形态
// 仍然照拦。精确、可扩展、无需自指条目。
function exemptValuesOf(exemptions) {
  return new Set((exemptions || []).map((e) => e && e.match).filter(Boolean));
}

function loadExemptions() {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, ALLOWLIST_REL), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.exemptions) ? data.exemptions : [];
  } catch {
    return [];
  }
}

/** 解析 `git diff --cached -U0`，返回 Map<文件, 新增行[]> */
function stagedAddedLines() {
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write('无法读取暂存区 diff：' + error.message + '\n');
    process.exit(2);
  }

  const byFile = new Map();
  let current = null;
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('+++ b/')) {
      current = line.slice(6);
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      current = null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('diff --git')) continue;
    if (!line.startsWith('+') || current === null) continue;
    if (!byFile.has(current)) byFile.set(current, []);
    byFile.get(current).push(line.slice(1));
  }
  return byFile;
}

function run() {
  const json = process.argv.includes('--json');
  const exemptions = loadExemptions();
  const exemptValues = exemptValuesOf(exemptions);
  const byFile = stagedAddedLines();

  const findings = [];
  for (const [file, lines] of byFile) {
    const isAllowlist = file === ALLOWLIST_REL;
    lines.forEach((line, index) => {
      for (const [patternName, pattern] of COMMIT_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;
        if (matchExemption(exemptions, file, match[0])) continue;
        // 白名单文件里作为 match 字段出现的值 = 豁免集本身，扫它属同义反复
        if (isAllowlist && exemptValues.has(match[0])) continue;
        findings.push({ file, line: index + 1, pattern: patternName, value: match[0] });
      }
    });
  }

  if (json) {
    process.stdout.write(JSON.stringify({ findings }, null, 2) + '\n');
  } else if (findings.length === 0) {
    process.stdout.write('  ✅ 无敏感信息（已按 hygiene-allowlist.json 豁免过滤）\n');
  } else {
    process.stdout.write('❌ 错误：暂存区检测到可能的密钥泄露（' + findings.length + ' 处）：\n');
    for (const f of findings) {
      process.stdout.write('  ' + f.file + '  [' + f.pattern + ']  ' + f.value.slice(0, 12) + '…\n');
    }
    process.stdout.write('\n');
    process.stdout.write('如确认是测试夹具等假值，请在 ' + ALLOWLIST_REL + ' 中按\n');
    process.stdout.write('「具体文件 + 完整匹配值 + reason + until」逐条豁免（禁止目录级豁免）。\n');
    process.stdout.write('真实密钥请移入环境变量 / .env，不要提交。\n');
  }

  return findings.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(run());
}

module.exports = { run, stagedAddedLines, COMMIT_PATTERNS, ALLOWLIST_REL };
