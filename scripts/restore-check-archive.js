'use strict';

/**
 * restore-check-archive.js — 还原「解密后内层归档形制可提取性」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-check-archive.js <还原目录 / 快照目录>          # 判：解密后那团归档，本机解包器认不认识？
 *   node scripts/restore-check-archive.js <目录> --json                  # 机器可读（陌生机器上的自驱 agent 据此决定是否敢解包）
 *   node scripts/restore-check-archive.js --gen-doc                      # 重新生成 OPS-MAN-108 说明
 *
 * 为谁而写：还原 / 自愈路径的解包器（sourceHealService._extractTarGz、cli/handlers/publish.js 的 restore）
 * 把 `tar -xzf` **写死**，从不读快照头里的 `plaintextFormat` / `layout`——这两个描述**解密后内层归档形制**
 * 的字段在整个还原代码库里零消费者。陌生机器上，一个未来 `plaintextFormat='tar.zst'` / `'zip'` 的快照
 * 会被旧还原代码盲目 `tar -xzf`（gzip 头对不上 → 抛解包天书，或部分字节被误解析吐出半个目录）。本 CLI
 * 是那个缺失的**解包前**对账器：在信封格式门（105）之后、完整性对账（095）之前，先把「本机解包器认不认识
 * 这团解密归档」从无人过问变成一次可离线验证的裁决。
 *
 * 设计：**判定全在纯叶子** scripts/lib/archiveExtractCompat.js（零 IO、可离线全测）；
 * 本文件是**采事实的接线壳**——读 snapshot.json 头喂给纯叶给出裁决。所有 IO（读 snapshot.json）
 * 都在此、fail-soft、绝不让异常冒泡成崩溃。
 */

const fs = require('fs');
const path = require('path');

const {
  checkArchiveExtractCompat,
} = require('./lib/archiveExtractCompat');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-108] 还原归档形制可提取性对账.md'
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
function buildArchiveCheck(destDir, overrides = {}) {
  const dest = path.resolve(destDir || '.');
  const header = _readHeader(dest, overrides);
  const verdict = checkArchiveExtractCompat(header);
  return { header, verdict, destDir: dest };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function runCheckArchive(opts = {}) {
  const destArg = opts.destDir || '.';
  const { verdict, destDir } = buildArchiveCheck(destArg, opts.overrides || {});

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: verdict.status,
      ok: verdict.ok,
      plaintextFormat: verdict.plaintextFormat,
      layout: verdict.layout,
      supportedFormats: verdict.supportedFormats,
      supportedLayouts: verdict.supportedLayouts,
      dir: destDir,
      reason: verdict.reason,
    }, null, 2) + '\n');
    // 非 supported → 非零退出（陌生机器上的 agent 据此不敢盲目解包）。
    return verdict.ok ? 0 : 2;
  }

  const statusColor = {
    supported: C.green,
    'unsupported-format': C.red, 'unknown-layout': C.red,
    unverifiable: C.yellow,
  }[verdict.status] || C.dim;

  let out = `${C.bold}Khy-OS 还原归档形制可提取性对账（解密后那团归档，本机解包器认识吗？）${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${statusColor}${C.bold}[${verdict.status}]${C.reset} `
    + `plaintextFormat=${verdict.plaintextFormat == null ? '?' : verdict.plaintextFormat} · `
    + `layout=${verdict.layout == null ? '(缺省)' : verdict.layout} `
    + `${C.dim}(本机支持 [${verdict.supportedFormats.join(', ')}] / [${verdict.supportedLayouts.join(', ')}])${C.reset}\n`;
  out += `  ${C.bold}目录：${C.reset}${destDir}\n`;
  out += `  ${C.dim}判据：${verdict.reason}${C.reset}\n`;
  out += `\n${C.dim}诚实边界：形制陌生 / 证据不足一律拒绝放行，绝不盲目 tar -xzf；layout 缺省是老快照的合法情形，格式支持即可放行。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-108] 还原归档形制可提取性对账.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.ok ? 0 : 2;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-108] 还原归档形制可提取性对账');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-check-archive.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 判定逻辑改在 `scripts/lib/archiveExtractCompat.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：plaintextFormat / layout 是死字段');
  lines.push('');
  lines.push('快照构建期 `makeSourceSnapshot.js` 给每个快照头（`snapshot.json`）盖两枚**内层归档**印章：');
  lines.push('');
  lines.push('- `plaintextFormat: "tar.gz"` —— 「密文解密后是一团 tar.gz，请用 gzip+tar 解包」；');
  lines.push('- `layout: "git-archive"` —— 「这团 tar 的内部布局是 git archive（尊重 .gitignore、无 .git）」。');
  lines.push('');
  lines.push('这两枚印章描述的是**解密之后**那层归档的形制，随 pip/npm 包漂洋过海到陌生机器。但还原 / 自愈侧的');
  lines.push('解包器（`sourceHealService._extractTarGz`、`cli/handlers/publish.js` 的 restore 提取）');
  lines.push('**把 `tar -xzf` 写死**，从不读 `plaintextFormat` / `layout`——这两个字段在整个还原代码库里');
  lines.push('**零消费者**。后果在离机场景最毒：');
  lines.push('');
  lines.push('- 未来某版 khy 改用 `tar.zst` / `zip` 打包源码（`plaintextFormat` 变），陌生机器上的**旧** khy');
  lines.push('  仍盲目 `tar -xzf`：gzip 头对不上 → 抛一句解包天书，或更糟——部分字节被误当 gzip 流吐出半个目录；');
  lines.push('- `layout` 若从 `git-archive` 变成含 `.git` 的全量 tar，语义已不同（还原横幅仍印「目录布局原样」骗人），');
  lines.push('  却没有任何一层先问「这归档形制我认得吗」。');
  lines.push('');
  lines.push('`plaintextFormat` / `layout` 上游花心思盖章、跨渠道送达、下游能读，却**在解包前无人据此把关**');
  lines.push('= 死字段（断桥）。本层就是那个缺失的**解包前**消费者。');
  lines.push('');
  lines.push('## 它和家族其它层的正交关系（别混淆）');
  lines.push('');
  lines.push('| 层 | 管什么 | 一句话 |');
  lines.push('|----|--------|--------|');
  lines.push('| 105 `snapshotFormatCompat` | 外层快照信封契约（`format`/`formatVersion`） | 「这是不是 khy 快照」 |');
  lines.push('| 107 `restoreProvenance` | git 来源（`captureMode`/`includesUncommitted`） | 「这源码等于哪个提交」 |');
  lines.push('| 095 `completenessVerifier` | 解包后文件数 | 「落地数量对得上清单吗」 |');
  lines.push('| **108 本层 `archiveExtractCompat`** | **解密后、解包前的内层归档形制**（`plaintextFormat`/`layout`） | **「我的 tar -xzf 认不认识这团解密归档」** |');
  lines.push('');
  lines.push('位置恰在「信封看得懂(105)」之后、「解包完整(095)」之前。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-check-format.js  ./Khy-OS --json   # ① 信封格式：本机看得懂吗？（105）');
  lines.push('node scripts/restore-check-archive.js ./Khy-OS --json   # ② 内层归档：本机解包器解得开吗？（本层 108）');
  lines.push('khy restore ./Khy-OS                                    # ③ 两门都过才敢解密解包还原');
  lines.push('node scripts/restore-verify-complete.js ./Khy-OS --json # ④ 再对账数量：真完整吗？（095）');
  lines.push('```');
  lines.push('');
  lines.push('## 判定档：解包能力门（最保守优先）');
  lines.push('');
  lines.push('| 档 | 条件 | 裁决 | ok |');
  lines.push('|----|------|------|----|');
  lines.push('| 1 | 头非对象 / 数组 / `plaintextFormat` 非非空串 | `unverifiable`：证据不足，绝不谎报 supported | ✗ |');
  lines.push('| 2 | `plaintextFormat` ∉ 支持集 | `unsupported-format`：本机 `tar -xzf` 解不开，**先升级 khy** | ✗ |');
  lines.push('| 3 | 格式可解压但 `layout` 存在且 ∉ 支持集 | `unknown-layout`：能解开却不认识内部布局，别当「原样」 | ✗ |');
  lines.push('| 4 | `plaintextFormat` ∈ 支持集且（`layout` 缺省 / ∈ 支持集） | `supported`：唯一可安心交给解包器的档 | ✓ |');
  lines.push('');
  lines.push('- 本机解包器真能解开的形制由叶子常量 `SUPPORTED_PLAINTEXT_FORMATS` / `SUPPORTED_LAYOUTS` 定义');
  lines.push('  （当前 `["tar.gz"]` / `["git-archive"]`）；解包实现新增支持时按叶子 HOW-TO-EXTEND 同步——');
  lines.push('  **只有解包器真支持了才加进支持集**，别为绿灯谎报。');
  lines.push('- `--json` 在非 `supported` 时**退出码 2**：陌生机器上的自驱 agent 据此**不敢盲目解包**。');
  lines.push('');
  lines.push('## 恒久红线（继承全家族）');
  lines.push('');
  lines.push('- 形制陌生 / 证据不足一律**拒绝放行**：绝不臆造 `supported`，绝不盲目 `tar -xzf`。');
  lines.push('- `ok===true` 仅当 `status === supported`；其余一律 `ok:false`。');
  lines.push('- `layout` 缺省是老快照的合法向后兼容情形（格式支持即放行）；但 `layout` 一旦**存在**就必须是认识的形制。');
  lines.push('- 叶子纯计算、零 IO、绝不抛；真正读 `snapshot.json` 的 IO 在 CLI 里、fail-soft。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原归档形制可提取性对账说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const destDir = argv.find((a) => a && !a.startsWith('-')) || '.';
    const code = runCheckArchive({ destDir, json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runCheckArchive,
  buildArchiveCheck,
  _readHeader,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
