'use strict';

/**
 * restore-verify-complete.js — 还原「解包完整性」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-verify-complete.js <还原目录>            # 对账：磁盘落地文件数是否等于快照期望
 *   node scripts/restore-verify-complete.js <还原目录> --json      # 机器可读（陌生机器上的自驱 agent 读它判是否真完整）
 *   node scripts/restore-verify-complete.js --gen-doc              # 重新生成 OPS-MAN-095 说明
 *
 * 为谁而写：`khy restore` 只看 tar 退出码就打印「源码已完整还原」，从不拿快照头里的 fileCount
 * 跟磁盘上真正落地的文件数对账。tar 退出 0 却少解文件的情况真实存在（磁盘写满 / 路径过长 /
 * 条目被跳过）——用户看到绿字却缺文件。本 CLI 是那个缺失的对账器：把「完整」从一句口号变成
 * 一次可离线验证的数量核对。
 *
 * 设计：**对账判定全在纯叶子** scripts/lib/restoreCompletenessVerifier.js（零 IO、可离线全测）；
 * 本文件是**采事实的接线壳**——读快照头拿 expected、数磁盘拿 actual，喂给纯叶给出裁决。
 * 所有 IO（读 snapshot.json、递归数文件）都在此、fail-soft、绝不让异常冒泡成崩溃。
 */

const fs = require('fs');
const path = require('path');

const {
  verifyExtractionCompleteness,
} = require('./lib/restoreCompletenessVerifier');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-095] 还原解包完整性对账.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const SNAPSHOT_META_NAME = 'snapshot.json';
const SNAPSHOT_ENC_NAME = 'snapshot.enc';
// 快照 sidecar：这些是包内元数据，不是被还原的源码，数文件时须排除。
const SNAPSHOT_SIDECAR_NAMES = new Set([SNAPSHOT_META_NAME, SNAPSHOT_ENC_NAME]);

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ── 采事实：读快照期望 + 数磁盘实际 ───────────────────────────────────────────

/** 安全读 JSON，失败返回 null（绝不抛）。 */
function _readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 从快照头（snapshot.json）里取 expectedFileCount。找不到 / 非法 → null。
 * 优先用 overrides 注入（离线可测），否则在还原目录及其常见 sidecar 位置找 snapshot.json。
 */
function _readExpectedFileCount(destDir, overrides = {}) {
  if (overrides.expectedFileCount != null) return overrides.expectedFileCount;
  const candidates = [
    overrides.snapshotMetaPath,
    path.join(destDir, SNAPSHOT_META_NAME),
    path.join(destDir, '_source', SNAPSHOT_META_NAME),
    path.join(path.dirname(destDir), '_source', SNAPSHOT_META_NAME),
  ].filter(Boolean);
  for (const p of candidates) {
    const header = _readJsonSafe(p);
    if (header && typeof header.fileCount === 'number') return header.fileCount;
  }
  return null;
}

/**
 * 递归数目标目录里的常规文件数（与 git archive 落地口径对齐：数 blob）。
 * 排除 .git 与快照 sidecar；符号链接不跟随（git archive 落地的是常规文件）。fail-soft，绝不抛。
 */
function _countRegularFiles(destDir) {
  let count = 0;
  const stack = [destDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const name = ent.name;
      if (ent.isDirectory()) {
        if (name === '.git') continue; // 还原目录通常无 .git；有也不计入源码文件
        stack.push(path.join(dir, name));
      } else if (ent.isFile()) {
        // 仅在还原根一层排除 sidecar（_source 内层不会误伤同名源码文件）。
        if (dir === destDir && SNAPSHOT_SIDECAR_NAMES.has(name)) continue;
        count += 1;
      }
      // 符号链接 / 其它类型：不计入（git archive 落地的是常规文件）。
    }
  }
  return count;
}

/**
 * 采齐事实喂给纯叶，返回 { facts, verdict, destDir }。不抛。
 * overrides 全可注入以便离线测试。
 */
function buildCompletenessCheck(destDir, overrides = {}) {
  const dest = path.resolve(destDir || '.');
  const expectedFileCount = _readExpectedFileCount(dest, overrides);
  const actualFileCount = overrides.actualFileCount != null
    ? overrides.actualFileCount
    : _countRegularFiles(dest);
  const facts = {
    expectedFileCount,
    actualFileCount,
    // restore 主路径在解包前已做 sha256 与 tar 退出码校验；离线复核时默认视为已通过，
    // 除非调用方显式注入 false（便于测 corrupt 档）。
    sha256Verified: overrides.sha256Verified,
    tarExitZero: overrides.tarExitZero,
  };
  const verdict = verifyExtractionCompleteness(facts);
  return { facts, verdict, destDir: dest };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function runVerifyComplete(opts = {}) {
  const destArg = opts.destDir || '.';
  const { verdict, destDir } = buildCompletenessCheck(destArg, opts.overrides || {});

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: verdict.status,
      ok: verdict.ok,
      expected: verdict.expected,
      actual: verdict.actual,
      missing: verdict.missing,
      extra: verdict.extra,
      dir: destDir,
      reason: verdict.reason,
    }, null, 2) + '\n');
    // incomplete / corrupt / unverifiable → 非零退出（陌生机器上的 agent 据此不当作已完整）。
    return verdict.ok ? 0 : 2;
  }

  const statusColor = {
    complete: C.green, 'over-extracted': C.yellow,
    incomplete: C.red, corrupt: C.red, unverifiable: C.yellow,
  }[verdict.status] || C.dim;

  let out = `${C.bold}Khy-OS 还原解包完整性对账（磁盘文件数 vs 快照期望）${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${statusColor}${C.bold}[${verdict.status}]${C.reset} `
    + `期望 ${verdict.expected == null ? '?' : verdict.expected} · 实际 ${verdict.actual == null ? '?' : verdict.actual}`;
  if (verdict.missing > 0) out += ` · ${C.red}缺 ${verdict.missing}${C.reset}`;
  if (verdict.extra > 0) out += ` · ${C.yellow}多 ${verdict.extra}${C.reset}`;
  out += '\n';
  out += `  ${C.bold}目录：${C.reset}${destDir}\n`;
  out += `  ${C.dim}判据：${verdict.reason}${C.reset}\n`;
  out += `\n${C.dim}诚实边界：证据不足绝不谎报 complete；只有数量吻合且前置校验通过才判「完整还原」。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-095] 还原解包完整性对账.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.ok ? 0 : 2;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-095] 还原解包完整性对账');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-verify-complete.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 对账逻辑改在 `scripts/lib/restoreCompletenessVerifier.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：fileCount 是个死字段');
  lines.push('');
  lines.push('快照构建期 `makeSourceSnapshot.js` 用 `git ls-tree -r --name-only` 数出 tar 里应有的文件数，');
  lines.push('写进 `snapshot.json` 的 `fileCount`，随 pip/npm 包送到陌生机器。但还原侧 `khy restore`');
  lines.push('只在成功横幅里**打印**它（"共 N 个文件"），**从不拿它跟磁盘上真正落地的文件数对账**——');
  lines.push('`_extractTarGz` 只看 `tar` 的退出码。tar 退出 0 却少解文件的情况真实存在：');
  lines.push('磁盘中途写满、路径过长（Windows MAX_PATH）、不被支持的条目类型、权限/符号链接被跳过……');
  lines.push('此时用户看到绿字「源码已完整还原」，磁盘上却缺文件 = **对用户最重要那条路径上的最毒假绿**。');
  lines.push('本层就是那个缺失的消费者：把「期望文件数」与「实际落地文件数」对账，给出诚实裁决。');
  lines.push('');
  lines.push('```bash');
  lines.push('khy restore ./Khy-OS                          # 解包源码快照');
  lines.push('node scripts/restore-verify-complete.js ./Khy-OS --json   # 再对账一次：数量真吻合吗？');
  lines.push('```');
  lines.push('');
  lines.push('## 判定档：对账 + 前置门（最保守优先）');
  lines.push('');
  lines.push('| 档 | 条件 | 裁决 | ok |');
  lines.push('|----|------|------|----|');
  lines.push('| 1 | 期望非正 / 实际缺失或非法 | `unverifiable`：证据不足，绝不默认 complete | ✗ |');
  lines.push('| 2 | `sha256Verified===false` 或 `tarExitZero===false` | `corrupt`：前置校验已失败 | ✗ |');
  lines.push('| 3 | 实际 **<** 期望 | `incomplete`：**静默少解**（断桥要抓的假绿） | ✗ |');
  lines.push('| 4 | 实际 **>** 期望 | `over-extracted`：残留 / 口径漂移，提示人核对 | ✗ |');
  lines.push('| 5 | 实际 **===** 期望 且前置通过 | `complete`：唯一可安心说「完整还原」 | ✓ |');
  lines.push('');
  lines.push('- **对账口径**：`expected` 取自快照头 `fileCount`（= `git ls-tree -r` 的 blob 数）；');
  lines.push('  `actual` 递归数还原目录里的常规文件（排除 `.git` 与快照 sidecar，不跟随符号链接），');
  lines.push('  与 `git archive` 落地口径对齐。');
  lines.push('- `--json` 在非 `complete` 时**退出码 2**：陌生机器上的自驱 agent 据此**不把还原当完整**。');
  lines.push('');
  lines.push('## 恒久红线（继承全家族）');
  lines.push('');
  lines.push('- 证据不足绝不谎报 `complete`：任何字段缺失 / 非法 → 保守 `unverifiable`。');
  lines.push('- `ok===true` 仅当 `status === complete`；其余一律 `ok:false`。');
  lines.push('- 叶子纯计算、零 IO、绝不抛；真正数磁盘、读 `snapshot.json` 的 IO 在 CLI 里、fail-soft。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原解包完整性对账说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const destDir = argv.find((a) => a && !a.startsWith('-')) || '.';
    const code = runVerifyComplete({ destDir, json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runVerifyComplete,
  buildCompletenessCheck,
  _countRegularFiles,
  _readExpectedFileCount,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
