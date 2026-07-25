'use strict';

/**
 * restore-check-format.js — 还原「快照格式兼容性」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-check-format.js <还原目录 / 快照目录>          # 判：本机 khy 看得懂这个快照格式吗？
 *   node scripts/restore-check-format.js <目录> --json                  # 机器可读（陌生机器上的自驱 agent 据此决定是否敢解密）
 *   node scripts/restore-check-format.js --gen-doc                      # 重新生成 OPS-MAN-105 说明
 *
 * 为谁而写：还原/自愈路径只校验 `crypto.algo`，从不校验快照头里的 `format` / `formatVersion`——
 * `'khy-source-snapshot'` 在整个还原代码库里零消费者。陌生机器上，一个**未来** formatVersion=2
 * 的快照会被**旧**还原代码盲目解密（要么抛密码学天书、要么静默误读）；一个根本不是 khy 快照的
 * 目录也没有任何一层先问一句「这是我认识的格式吗」。本 CLI 是那个缺失的**前置**对账器：在完整性
 * 对账（095）之前，先把「格式兼容性」从无人过问变成一次可离线验证的裁决。
 *
 * 设计：**判定全在纯叶子** scripts/lib/snapshotFormatCompat.js（零 IO、可离线全测）；
 * 本文件是**采事实的接线壳**——读 snapshot.json 头喂给纯叶给出裁决。所有 IO（读 snapshot.json）
 * 都在此、fail-soft、绝不让异常冒泡成崩溃。
 */

const fs = require('fs');
const path = require('path');

const {
  checkSnapshotFormatCompat,
} = require('./lib/snapshotFormatCompat');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-105] 还原快照格式兼容性对账.md'
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
function buildFormatCheck(destDir, overrides = {}) {
  const dest = path.resolve(destDir || '.');
  const header = _readHeader(dest, overrides);
  const verdict = checkSnapshotFormatCompat(header);
  return { header, verdict, destDir: dest };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function runCheckFormat(opts = {}) {
  const destArg = opts.destDir || '.';
  const { verdict, destDir } = buildFormatCheck(destArg, opts.overrides || {});

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: verdict.status,
      ok: verdict.ok,
      format: verdict.format,
      formatVersion: verdict.formatVersion,
      understoodMin: verdict.understoodMin,
      understoodMax: verdict.understoodMax,
      dir: destDir,
      reason: verdict.reason,
    }, null, 2) + '\n');
    // 非 supported → 非零退出（陌生机器上的 agent 据此不敢盲目解密）。
    return verdict.ok ? 0 : 2;
  }

  const statusColor = {
    supported: C.green,
    'too-new': C.red, 'too-old': C.red, alien: C.red,
    unverifiable: C.yellow,
  }[verdict.status] || C.dim;

  let out = `${C.bold}Khy-OS 还原快照格式兼容性对账（本机 khy 看得懂这个快照吗？）${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${statusColor}${C.bold}[${verdict.status}]${C.reset} `
    + `format=${verdict.format == null ? '?' : verdict.format} · `
    + `formatVersion=${verdict.formatVersion == null ? '?' : verdict.formatVersion} `
    + `${C.dim}(本机理解区间 [${verdict.understoodMin},${verdict.understoodMax}])${C.reset}\n`;
  out += `  ${C.bold}目录：${C.reset}${destDir}\n`;
  out += `  ${C.dim}判据：${verdict.reason}${C.reset}\n`;
  out += `\n${C.dim}诚实边界：证据不足 / 格式陌生 / 版本超纲一律拒绝放行；只有格式认识且版本在理解区间才判「兼容」。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-105] 还原快照格式兼容性对账.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.ok ? 0 : 2;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-105] 还原快照格式兼容性对账');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-check-format.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 判定逻辑改在 `scripts/lib/snapshotFormatCompat.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：format / formatVersion 是死字段');
  lines.push('');
  lines.push('快照构建期 `makeSourceSnapshot.js` 给每个快照头（`snapshot.json`）盖两枚契约印章：');
  lines.push('');
  lines.push('- `format: "khy-source-snapshot"` —— 「这确实是 khy 源码快照，不是别的什么 tar」；');
  lines.push('- `formatVersion: 1` —— 「快照头 / 密文布局的 schema 版本」。');
  lines.push('');
  lines.push('这两枚印章随 pip/npm 包漂洋过海到陌生机器。但还原 / 自愈侧');
  lines.push('（`sourceHealService.decrypt`、`cli/handlers/publish.js` 的 restore 处理器）');
  lines.push('**只校验 `crypto.algo === "aes-256-gcm"`，从不校验 `format` / `formatVersion`**——');
  lines.push('`grep "khy-source-snapshot"` 在整个还原代码库里 **零消费者**。后果在离机场景最毒：');
  lines.push('');
  lines.push('- 陌生机器上装的是**旧** khy（旧还原代码），却拿到一个**未来** `formatVersion=2` 的快照');
  lines.push('  （密文 / 头布局已变但 `crypto.algo` 仍是 aes-256-gcm）→ 旧代码盲目解密：要么抛一句');
  lines.push('  密码学天书（`unable to authenticate data`），要么更糟——静默按旧布局误解析新快照；');
  lines.push('- 或者 `snapshot.json` 根本不是 khy 快照（复制错目录 / 第三方 tar）→ 没有任何一层');
  lines.push('  先问一句「这是我认识的格式吗」，直接进解密。');
  lines.push('');
  lines.push('`format` / `formatVersion` 上游花心思盖章、跨渠道送达、下游能读，却**在还原前无人据此把关**');
  lines.push('= 死字段（断桥）。本层就是那个缺失的**前置**消费者：在完整性对账（第十二层 095）之前，');
  lines.push('先回答最基础的一问——「这个快照的格式，本机 khy 的还原代码到底看不看得懂？」');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-check-format.js ./Khy-OS --json    # ① 先判格式：本机看得懂吗？');
  lines.push('khy restore ./Khy-OS                                    # ② 格式兼容才敢解密还原');
  lines.push('node scripts/restore-verify-complete.js ./Khy-OS --json # ③ 再对账数量：真完整吗？（095）');
  lines.push('```');
  lines.push('');
  lines.push('## 判定档：格式契约门（最保守优先）');
  lines.push('');
  lines.push('| 档 | 条件 | 裁决 | ok |');
  lines.push('|----|------|------|----|');
  lines.push('| 1 | 头非对象 / `format` 非串 / `formatVersion` 非有限数 | `unverifiable`：证据不足，绝不谎报 supported | ✗ |');
  lines.push('| 2 | `format !== "khy-source-snapshot"` | `alien`：这不是 khy 源码快照，别信别解密 | ✗ |');
  lines.push('| 3 | `formatVersion > MAX` | `too-new`：快照比本机还原代码更新，**先升级 khy** | ✗ |');
  lines.push('| 4 | `formatVersion < MIN` | `too-old`：格式过旧，勿用当前解析误读 | ✗ |');
  lines.push('| 5 | `MIN ≤ formatVersion ≤ MAX` 且档 2 通过 | `supported`：唯一可安心继续还原的档 | ✓ |');
  lines.push('');
  lines.push('- 本机能理解的区间由叶子常量 `MIN_FORMAT_VERSION` / `MAX_FORMAT_VERSION` 定义');
  lines.push('  （当前均为 `1`）；快照布局做不向后兼容变更时按叶子 HOW-TO-EXTEND 递增。');
  lines.push('- `--json` 在非 `supported` 时**退出码 2**：陌生机器上的自驱 agent 据此**不敢盲目解密**。');
  lines.push('');
  lines.push('## 恒久红线（继承全家族）');
  lines.push('');
  lines.push('- 证据不足 / 格式陌生 / 版本超纲一律**拒绝放行**：绝不臆造 `supported`。');
  lines.push('- `ok===true` 仅当 `status === supported`；其余一律 `ok:false`。');
  lines.push('- 这是**前置**门（先于完整性对账 095、授权 088、导航 090）——看不懂格式，后面所有诊断都无意义。');
  lines.push('- 叶子纯计算、零 IO、绝不抛；真正读 `snapshot.json` 的 IO 在 CLI 里、fail-soft。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原快照格式兼容性对账说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const destDir = argv.find((a) => a && !a.startsWith('-')) || '.';
    const code = runCheckFormat({ destDir, json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runCheckFormat,
  buildFormatCheck,
  _readHeader,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
