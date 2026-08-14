'use strict';

/**
 * restore-provenance.js — 还原「来源可溯性」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-provenance.js <还原目录 / 快照目录>        # 判：这份还原源码到底等于哪个 git 状态？
 *   node scripts/restore-provenance.js <目录> --json                # 机器可读（陌生机器上的自驱 agent 据此判是否「就是那个提交」）
 *   node scripts/restore-provenance.js --gen-doc                    # 重新生成 OPS-MAN-107 说明
 *
 * 为谁而写：还原成功横幅只打印 gitCommit（"commit 44a491fb · 目录布局原样"），从不读快照头里
 * 忠实记录的 captureMode / includesUncommitted——`grep includesUncommitted` 在还原代码里零消费者。
 * 真实 shipped 快照恰恰是**脏捕获**（含未提交增量），于是维护者看到「commit X」会误判「我还原的
 * 就是提交 X」，拿去 diff / 当发布代码全错。本 CLI 是那个缺失的消费者：把「这份源码到底等于哪个
 * git 状态」从一句会误导的「commit X」，变成一次诚实的、可离线验证的裁决。
 *
 * 设计：**判定全在纯叶子** scripts/lib/restoreProvenance.js（零 IO、可离线全测）；
 * 本文件是**采事实的接线壳**——读 snapshot.json 头喂给纯叶给出裁决。所有 IO 都在此、fail-soft。
 */

const fs = require('fs');
const path = require('path');

const {
  assessRestoreProvenance,
} = require('../lib/restoreProvenance');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-107] 还原来源可溯性对账.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const SNAPSHOT_META_NAME = 'snapshot.json';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ── 采事实：读快照头 ─────────────────────────────────────────────────────────

/** 安全读 JSON，失败返回 null（绝不抛）。 */
function _readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 定位并读取快照头（snapshot.json）。找不到 → null。
 * 优先用 overrides.header 直接注入（离线可测），否则在目录及其常见 sidecar 位置找 snapshot.json。
 */
function _readHeader(destDir, overrides = {}) {
  if (overrides.header !== undefined) return overrides.header;
  const candidates = [
    overrides.snapshotMetaPath,
    path.join(destDir, SNAPSHOT_META_NAME),
    path.join(destDir, '_source', SNAPSHOT_META_NAME),
    path.join(path.dirname(destDir), '_source', SNAPSHOT_META_NAME),
  ].filter(Boolean);
  for (const p of candidates) {
    const header = _readJsonSafe(p);
    if (header && typeof header === 'object') return header;
  }
  return null;
}

/**
 * 采齐事实喂给纯叶，返回 { header, verdict, destDir }。不抛。
 * overrides 全可注入以便离线测试。
 */
function buildProvenanceCheck(destDir, overrides = {}) {
  const dest = path.resolve(destDir || '.');
  const header = _readHeader(dest, overrides);
  const verdict = assessRestoreProvenance(header);
  return { header, verdict, destDir: dest };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function runProvenance(opts = {}) {
  const destArg = opts.destDir || '.';
  const { verdict, destDir } = buildProvenanceCheck(destArg, opts.overrides || {});

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: verdict.status,
      ok: verdict.ok,
      gitCommit: verdict.gitCommit,
      shortCommit: verdict.shortCommit,
      captureMode: verdict.captureMode,
      includesUncommitted: verdict.includesUncommitted,
      version: verdict.version,
      dir: destDir,
      reason: verdict.reason,
    }, null, 2) + '\n');
    // 非 clean → 非零退出（陌生机器上的 agent 据此不把还原源码当「就是那个干净提交」）。
    return verdict.ok ? 0 : 2;
  }

  const statusColor = {
    clean: C.green,
    dirty: C.yellow, indeterminate: C.yellow,
    'no-provenance': C.red, unverifiable: C.red,
  }[verdict.status] || C.dim;

  let out = `${C.bold}Khy-OS 还原来源可溯性对账（这份源码到底等于哪个 git 状态？）${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${statusColor}${C.bold}[${verdict.status}]${C.reset} `
    + `commit=${verdict.shortCommit == null ? '?' : verdict.shortCommit} · `
    + `captureMode=${verdict.captureMode == null ? '?' : verdict.captureMode} · `
    + `includesUncommitted=${verdict.includesUncommitted == null ? '?' : verdict.includesUncommitted}`;
  if (verdict.version) out += ` · v${verdict.version}`;
  out += '\n';
  out += `  ${C.bold}目录：${C.reset}${destDir}\n`;
  out += `  ${C.dim}判据：${verdict.reason}${C.reset}\n`;
  out += `\n${C.dim}诚实边界：没有正面 clean 证据绝不谎称「就是那个提交」；脏捕获是合法完整的还原，只是不等于干净提交。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-107] 还原来源可溯性对账.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.ok ? 0 : 2;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-107] 还原来源可溯性对账');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-provenance.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 判定逻辑改在 `scripts/lib/restoreProvenance.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：captureMode / includesUncommitted 是死字段');
  lines.push('');
  lines.push('快照构建期 `makeSourceSnapshot.js` 忠实记录了这份快照是**怎么捕获**的：');
  lines.push('');
  lines.push('- `captureMode: "working-tree" | "HEAD"` —— 从工作树打包，还是从某个提交 archive；');
  lines.push('- `includesUncommitted: true | false` —— 是否含未提交改动（tracked 改动 + untracked）；');
  lines.push('- `dirty: true | false` —— 捕获时工作树是否脏；');
  lines.push('- `gitCommit: "<sha>"` —— 捕获时 HEAD 所在提交。');
  lines.push('');
  lines.push('这些随 pip/npm 包送到陌生机器。但还原侧 `cli/handlers/publish.js` 的成功横幅');
  lines.push('**只打印 `gitCommit`**（`commit 44a491fb · 目录布局原样`），');
  lines.push('**从不读 `includesUncommitted` / `captureMode`**——`grep includesUncommitted` 在还原代码里');
  lines.push('**零消费者**。后果对维护者最毒：');
  lines.push('');
  lines.push('- 真实 shipped 快照就是**脏捕获**（`captureMode="working-tree"` · `includesUncommitted=true`）——');
  lines.push('  还原出来的源码 = 提交 `44a491fb` **加上未提交增量**，**不等于** `44a491fb` 这个干净提交；');
  lines.push('- 但维护者在陌生机器上只看到横幅那句「commit 44a491fb · 目录布局原样」→ 合理地误判');
  lines.push('  「我还原的就是 44a491fb」→ 拿它去 `git diff 44a491fb` 看到一堆幻影差异、或把它当成');
  lines.push('  「发布的那份代码」——全错，因为它比那个提交多了未提交的活儿。');
  lines.push('');
  lines.push('`captureMode` / `includesUncommitted` 上游忠实记录、跨渠道送达、下游能读，却**在还原时');
  lines.push('无人据此向维护者澄清来源** = 死字段（断桥）。本层就是那个缺失的消费者：把「这份还原源码');
  lines.push('到底等于哪个 git 状态」从一句会误导的「commit X」，变成一次诚实的裁决。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-check-format.js ./Khy-OS --json     # ① 格式看得懂吗？（105）');
  lines.push('khy restore ./Khy-OS                                     # ② 解密还原');
  lines.push('node scripts/restore-verify-complete.js ./Khy-OS --json  # ③ 文件数对得上吗？（095）');
  lines.push('node scripts/restore-provenance.js ./Khy-OS --json       # ④ 这源码到底等于哪个 git 状态？（本层）');
  lines.push('```');
  lines.push('');
  lines.push('## 判定档：来源诚实门（最保守优先 · 没有正面证据绝不谎称 clean）');
  lines.push('');
  lines.push('| 档 | 条件 | 裁决 | ok |');
  lines.push('|----|------|------|----|');
  lines.push('| 1 | 头非对象 | `unverifiable`：无从判断来源 | ✗ |');
  lines.push('| 2 | 无 `gitCommit` | `no-provenance`：没记录任何提交，无从溯源 | ✗ |');
  lines.push('| 3 | `includesUncommitted===true` 或 `dirty===true` | `dirty`：== 提交 X + 未提交增量，**不等于干净提交** | ✗ |');
  lines.push('| 4 | HEAD 归档，或 working-tree 且 `includesUncommitted===false` | `clean`：可证 == 提交 X | ✓ |');
  lines.push('| 5 | 有提交、非脏，但无正面 clean 证据 | `indeterminate`：保守，不臆断 clean | ✗ |');
  lines.push('');
  lines.push('- `ok===true` **仅当** `status===clean`（还原源码可证等于某个干净提交）——「简单还原」里最强的一档：');
  lines.push('  维护者可以放心把它当成「就是那个提交」。');
  lines.push('- `--json` 在非 `clean` 时**退出码 2**：陌生机器上的自驱 agent 据此**不把还原源码当作发布快照**。');
  lines.push('- **只披露不阻拦**：`dirty` 是**合法且完整**的还原（内容一字不缺），只是不等于干净提交——');
  lines.push('  本层把「静默误导」变成「诚实标注」，不改变还原本身的成败。');
  lines.push('');
  lines.push('## 恒久红线（继承全家族）');
  lines.push('');
  lines.push('- 没有正面 clean 证据绝不谎称 `clean`：任何脏 / 不确定 / 缺来源 → `ok:false`，诚实披露。');
  lines.push('- `ok===true` 仅当 `status === clean`；其余一律 `ok:false`。');
  lines.push('- 叶子纯计算、零 IO、绝不抛；真正读 `snapshot.json` 的 IO 在 CLI 里、fail-soft。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原来源可溯性对账说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const destDir = argv.find((a) => a && !a.startsWith('-')) || '.';
    const code = runProvenance({ destDir, json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runProvenance,
  buildProvenanceCheck,
  _readHeader,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
