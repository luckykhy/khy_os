'use strict';

/**
 * restore-effect-probe.js — 雅可比透镜（有限差分效应探针）CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-effect-probe.js <还原目录 / 快照目录>          # 人读表：每个 header 字段动不动得了还原门？
 *   node scripts/restore-effect-probe.js <目录> --json                  # 机读（自驱 agent / CI 据此判还原字段接线有无回归）
 *   node scripts/restore-effect-probe.js --gen-doc                      # 重新生成 OPS-MAN-113 说明
 *
 * 为谁而写：还原家族已逐层给快照头字段接了消费者（信封 105 / 来源 107 / 内层归档 108 /
 * 解密套件 110）。但「某字段是否真的驱动某道门」一直靠人肉 grep 静态确认——grep 会被
 * 「读了但读完即弃」的假消费者骗过。本 CLI 是那个缺失的**动态回归守卫**：对每个契约字段做
 * 有限差分（扰动它、跑还原门面板、量输出 delta），在一批**隔离上下文语料**上求并集。
 * 任一契约字段在整个语料上都不动任何门 = 死字段（消费者被摘 / 从未接线）→ 退出码 2。
 *
 * 这是「雅可比透镜」在 khy 上的落地（源自 Anthropic「Verbalizable Representations Form a
 * Global Workspace in Language Models」的 Jacobian lens 思想）：不看字段在某一次运行里
 * 「是不是被用到」，而看它对最终裁决的**一阶因果效应、在一批上下文上求平均**。求平均是关键——
 * 单个上下文会被门内部的冗余 OR 信号掩盖，把 load-bearing 的字段误判成死。
 *
 * 设计：判定全在纯叶子 scripts/lib/restoreEffectProbe.js（零 IO、零加密、可离线全测）；
 * 本文件是采事实的接线壳——读 snapshot.json 头、装配还原门面板、派生上下文语料，喂给纯叶。
 * 所有 IO 都在此、fail-soft、绝不让异常冒泡成崩溃。
 *
 * 密钥卫生（红线）：本 CLI 与叶子**绝不读、绝不打印、绝不扰动任何密钥/口令/明文材料**——
 *   契约字段不含 crypto.salt / iv / authTag，extras 只扫顶层键不下探 crypto；输出只含字段路径、
 *   效应标签、上下文名、门名，绝不含快照头的任何取值。
 */

const fs = require('fs');
const path = require('path');

const {
  probeHeaderEffects,
  buildContextCorpus,
} = require('./lib/restoreEffectProbe');

const { checkSnapshotFormatCompat } = require('./lib/snapshotFormatCompat');
const { checkCryptoSuiteCompat } = require('./lib/cryptoSuiteCompat');
const { checkArchiveExtractCompat } = require('./lib/archiveExtractCompat');
const { assessRestoreProvenance } = require('./lib/restoreProvenance');

const ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-113] 还原字段效应探针（雅可比透镜）.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const SNAPSHOT_META_NAME = 'snapshot.json';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

/** 还原门面板：还原家族的纯叶（信封 105 / 解密套件 110 / 内层归档 108 / 来源 107）。 */
function _gatePanel() {
  return [
    { name: 'format(105)', fn: checkSnapshotFormatCompat },
    { name: 'crypto(110)', fn: checkCryptoSuiteCompat },
    { name: 'archive(108)', fn: checkArchiveExtractCompat },
    { name: 'provenance(107)', fn: assessRestoreProvenance },
  ];
}

// ── 采事实：读快照头 ─────────────────────────────────────────────────────────

function _readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

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

/** 采齐事实喂给纯叶，返回 { header, verdict, destDir }。不抛。overrides 可注入以便离线测试。 */
function buildEffectProbe(destDir, overrides = {}) {
  const dest = path.resolve(destDir || '.');
  const header = _readHeader(dest, overrides);
  const contexts = buildContextCorpus(header);
  const verdict = probeHeaderEffects({
    contexts,
    gates: overrides.gates || _gatePanel(),
    extrasFrom: header,
  });
  return { header, verdict, destDir: dest };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function runEffectProbe(opts = {}) {
  const destArg = opts.destDir || '.';
  const { verdict, destDir } = buildEffectProbe(destArg, opts.overrides || {});

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: verdict.status,
      ok: verdict.ok,
      deadFields: verdict.deadFields,
      summary: verdict.summary,
      contexts: verdict.contexts,
      fields: verdict.fields.map((f) => ({
        path: f.path, wiredBy: f.wiredBy, effect: f.effect, reactingGates: f.hits.length,
      })),
      extras: verdict.extras.map((f) => ({ path: f.path, effect: f.effect })),
      dir: destDir,
      reason: verdict.reason,
    }, null, 2) + '\n');
    // 非 ok（有 dead 契约字段或证据不足）→ 退出码 2。
    return verdict.ok ? 0 : 2;
  }

  const statusColor = { ok: C.green, regression: C.red, unverifiable: C.yellow }[verdict.status] || C.dim;
  let out = `${C.bold}Khy-OS 还原字段效应探针 · 雅可比透镜（每个 header 字段真的驱动某道还原门吗？）${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${statusColor}${C.bold}[${verdict.status}]${C.reset} `
    + `契约 ${verdict.summary.contract} · load-bearing ${verdict.summary.loadBearing} · `
    + `dead ${verdict.summary.dead} `
    + `${C.dim}(${verdict.summary.contexts} 上下文语料 × ${verdict.summary.gates} 门有限差分)${C.reset}\n`;
  out += `  ${C.dim}上下文：${verdict.contexts.join(' · ')}${C.reset}\n\n`;
  for (const f of verdict.fields) {
    const color = f.effect === 'load-bearing' ? C.green : C.red;
    const mark = f.effect === 'load-bearing' ? '✓' : '✗ 死字段';
    out += `  ${color}${mark}${C.reset} ${f.path.padEnd(20)} ${C.dim}${f.wiredBy} · ${f.hits.length} 处门反应${C.reset}\n`;
  }
  if (verdict.extras.length > 0) {
    out += `\n  ${C.dim}非契约字段（本面板外消费，仅供参考）：${C.reset}\n`;
    for (const f of verdict.extras) {
      const tag = f.effect === 'unmonitored' ? 'unmonitored（本面板不消费；应由别处消费，如 095/完整性/横幅——若无则是新死字段）' : 'load-bearing-extra（本面板已消费但未登记进契约，值得补进契约）';
      out += `    ${C.dim}· ${f.path.padEnd(16)} ${tag}${C.reset}\n`;
    }
  }
  out += `  ${C.bold}目录：${C.reset}${destDir}\n`;
  out += `  ${C.dim}判据：${verdict.reason}${C.reset}\n`;
  out += `\n${C.dim}诚实边界：单上下文会被门内冗余 OR 信号掩盖 → 用隔离语料求并集；证据不足（无门/无语料）判 unverifiable 不臆断绿；只报字段路径与效应，绝不碰密钥。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-113] 还原字段效应探针（雅可比透镜）.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.ok ? 0 : 2;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-113] 还原字段效应探针（雅可比透镜）');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-effect-probe.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 判定逻辑改在 `scripts/lib/restoreEffectProbe.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：把「死字段」的静态狩猎升级成动态守卫');
  lines.push('');
  lines.push('还原家族已逐层给快照头字段接了消费者：信封 `format`/`formatVersion`（105）、来源');
  lines.push('`captureMode`/`includesUncommitted`/`dirty`/`gitCommit`（107）、内层归档');
  lines.push('`plaintextFormat`/`layout`（108）、解密套件 `crypto.algo`/`crypto.kdf`（110）。');
  lines.push('');
  lines.push('但「某字段是否**真的**驱动某道门」一直靠人肉 `grep` 静态确认——而 `grep` 会被');
  lines.push('**「读了但读完即弃」的假消费者**骗过（字段被读、结果被丢，语法上「有消费者」，行为上却是死的）。');
  lines.push('本层是那个缺失的**动态回归守卫**：对每个契约字段做**有限差分**——扰动它（删除 / 换成同类型');
  lines.push('的异物值）、跑还原门面板、量最终裁决 `(status, ok)` 的改变。字段的「雅可比」≈0');
  lines.push('（任何上下文扰动它、任何门都不反应）= **行为上证死**，无论它语法上是否被读。');
  lines.push('');
  lines.push('## 为什么必须「一批上下文」而不是单个真头');
  lines.push('');
  lines.push('思想源自 Anthropic《Verbalizable Representations Form a Global Workspace in Language');
  lines.push('Models》的 **Jacobian lens**：用一个中间量对输出的一阶因果效应、**在一大批上下文上求平均**，');
  lines.push('才能把「恰好在这条 trace 里被用到」和「随时准备被用到（load-bearing）」区分开。');
  lines.push('');
  lines.push('落到还原家族：来源门 `restoreProvenance` 用的是**冗余 OR** 信号——');
  lines.push('`includesUncommitted===true || dirty===true` 判脏，`captureMode==="HEAD" || includesUncommitted===false` 判净。');
  lines.push('在真头上两个脏信号同时为真，单独扰动其一、另一仍兜住裁决 → **单上下文会把');
  lines.push('`captureMode`/`includesUncommitted`/`dirty` 误报成死字段**。用「隔离语料」后各信号能被单独证明：');
  lines.push('');
  lines.push('| 上下文 | 构造 | 隔离出的字段 |');
  lines.push('|--------|------|--------------|');
  lines.push('| `real` | 真快照头原样 | format/formatVersion/crypto.*/plaintextFormat/layout/gitCommit |');
  lines.push('| `clean-head` | `captureMode=HEAD`、删 includesUncommitted/dirty | `captureMode` |');
  lines.push('| `clean-worktree` | `captureMode=working-tree`、`includesUncommitted=false`、删 dirty | `includesUncommitted` |');
  lines.push('| `dirty-flag` | `captureMode=working-tree`、删 includesUncommitted、`dirty=true` | `dirty` |');
  lines.push('');
  lines.push('字段在**任一**上下文动了**任一**门 → `load-bearing`；在整个语料上都不动 → `dead`。');
  lines.push('');
  lines.push('## 判定档');
  lines.push('');
  lines.push('| 档 | 条件 | 裁决 | ok |');
  lines.push('|----|------|------|----|');
  lines.push('| 1 | 未注入门面板 / 上下文语料为空 | `unverifiable`：证据不足，绝不臆断字段有效 | ✗ |');
  lines.push('| 2 | 有契约字段在整个语料上不动任何门 | `regression`：死字段（消费者被摘 / 从未接线） | ✗ |');
  lines.push('| 3 | 全部契约字段均 load-bearing | `ok`：还原家族字段接线无回归 | ✓ |');
  lines.push('');
  lines.push('- 契约字段（`CONTRACT_FIELDS`）= 各门**被接线去消费**的 header 字段；契约里出现即代表');
  lines.push('  「必须有门消费它」，`dead` 就是红灯。新增门后按叶子 HOW-TO-EXTEND 同步契约 + 隔离语料。');
  lines.push('- 非契约字段（`archive`/`sha256`/`fileCount`/`version`/`createdAt`/`notes` 等）本面板不消费，');
  lines.push('  报为 `unmonitored`（仅供参考）：它们应由**别处**消费（`fileCount` → 095 完整性对账、');
  lines.push('  `sha256` → 传输完整性、`version` → 横幅）；若某个 `unmonitored` 字段其实哪儿都没消费，');
  lines.push('  那就是一个**新的死字段**，值得顺着查。');
  lines.push('- `--json` 在非 `ok` 时**退出码 2**：CI / 自驱 agent 据此发现「还原字段接线出现回归」。');
  lines.push('');
  lines.push('## 恒久红线（继承全家族 + 密钥卫生）');
  lines.push('');
  lines.push('- 证据不足（无门 / 无语料）一律判 `unverifiable`：绝不臆造绿灯。');
  lines.push('- **绝不读、绝不打印、绝不扰动任何密钥/口令/明文材料**：契约字段不含 `crypto.salt`/`iv`/`authTag`，');
  lines.push('  extras 只扫顶层键、绝不下探 `crypto`；输出只含字段路径、效应标签、上下文名、门名，绝不含快照头取值。');
  lines.push('- 扰动全部**确定性**（删除 + 写死的异物值，绝不用随机 / 时间）；叶子纯计算、零 IO、绝不改入参、绝不抛。');
  lines.push('- `ok===true` 仅当 `status === ok`（有门、有语料、零 dead）。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原字段效应探针说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const destDir = argv.find((a) => a && !a.startsWith('-')) || '.';
    const code = runEffectProbe({ destDir, json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runEffectProbe,
  buildEffectProbe,
  _readHeader,
  _gatePanel,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
