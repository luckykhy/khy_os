'use strict';

/**
 * restore-field-attribution.js — 字段-消费者归属探针（label preservation）CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-field-attribution.js <还原目录 / 快照目录>          # 人读表：每个 header 字段驱动的是不是它声明的属主门？
 *   node scripts/restore-field-attribution.js <目录> --json                  # 机读（CI / 自驱 agent 据此判归属有无回归）
 *   node scripts/restore-field-attribution.js --gen-doc                      # 重新生成 OPS-MAN-114 说明
 *
 * 为谁而写：效应探针（OPS-113）只**数**「某字段动了几道还原门」——breadth-blind，只问「≥1 门吗？」。
 * 但一次重构若把某字段的效应**挪到了错的门**（如 `crypto.algo` 的效应跑去左右 `provenance(107)`），
 * OPS-113 依旧全绿（字段仍 ≥1 门反应），却是**真串扰**：来源门（git 溯源）的裁决被加密算法左右
 * = 关注点泄漏（加密字段影响非加密裁决还是安全隐患）。本 CLI 是那个缺失的**归属回归守卫**：
 * 把每个契约字段的「实际反应门集」与它 `wiredBy` 声明的**属主门**比对——只反应属主门 = faithful，
 * 反应了非属主门 = cross-talk（红），缺失声明的属主门 = partial（红），一门不反应 = dead（红）。
 *
 * 这是「雅可比透镜」的 §4.3.2 **label preservation** 在 khy 上的落地（源自 Anthropic《Verbalizable
 * Representations Form a Global Workspace in Language Models》）：广播头须同时过 gain（放大得够广，
 * ≈ OPS-113 有没有效应）与 label preservation（把方向忠实映回自己而非与别的方向打散）两关。
 * OPS-113 是 gain 关；本层是 label-preservation 关——两者正交，本层专抓 OPS-113 看不见的错接/串扰。
 *
 * 设计：判定全在纯叶 scripts/lib/restoreFieldAttribution.js（零 IO、可离线全测）；采事实**复用**
 * OPS-113 CLI 的 buildEffectProbe（读 snapshot.json 头、装门面板、跑有限差分），本文件把它的
 * 结果喂给归属纯叶。所有 IO 都在 buildEffectProbe 里、fail-soft、绝不让异常冒泡成崩溃。
 *
 * 密钥卫生（红线）：本 CLI 与叶子**绝不读、绝不打印、绝不扰动任何密钥/口令/明文材料**——
 *   probeResult 已由 OPS-113 保证不含快照头取值；输出只含字段路径、门名、OPS 号、归属标签。
 */

const fs = require('fs');
const path = require('path');

const { assessFieldAttribution } = require('../lib/restoreFieldAttribution');
const { buildEffectProbe } = require('./restore-effect-probe');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-114] 还原字段归属探针（label preservation）.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ── 采齐事实喂给纯叶 ─────────────────────────────────────────────────────────

/** 复用 OPS-113 的 buildEffectProbe 拿 probeResult，再判归属。不抛。overrides 供离线测试注入。 */
function buildAttribution(destDir, overrides = {}) {
  const dest = path.resolve(destDir || '.');
  const { verdict: probeResult } = buildEffectProbe(dest, overrides);
  const attribution = assessFieldAttribution({ probeResult });
  return { probeResult, attribution, destDir: dest };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

const _ATTR_MARK = {
  faithful: { c: C.green, m: '✓ faithful' },
  'cross-talk': { c: C.red, m: '✗ 串扰' },
  partial: { c: C.red, m: '✗ 缺属主' },
  dead: { c: C.red, m: '✗ 死字段' },
  unattributed: { c: C.yellow, m: '? 无属主声明' },
};

function runFieldAttribution(opts = {}) {
  const destArg = opts.destDir || '.';
  const { attribution, destDir } = buildAttribution(destArg, opts.overrides || {});

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: attribution.status,
      ok: attribution.ok,
      summary: attribution.summary,
      fields: attribution.fields.map((f) => ({
        path: f.path, wiredBy: f.wiredBy, attribution: f.attribution,
        ownerGates: f.ownerGates, foreignGates: f.foreignGates, missingNums: f.missingNums,
      })),
      offenders: attribution.offenders.map((f) => ({
        path: f.path, attribution: f.attribution, foreignGates: f.foreignGates, missingNums: f.missingNums,
      })),
      dir: destDir,
      reason: attribution.reason,
    }, null, 2) + '\n');
    // 非 ok（有串扰/缺属主/死字段/无声明，或证据不足）→ 退出码 2。
    return attribution.ok ? 0 : 2;
  }

  const statusColor = { ok: C.green, miswired: C.red, unverifiable: C.yellow }[attribution.status] || C.dim;
  const s = attribution.summary;
  let out = `${C.bold}Khy-OS 还原字段归属探针 · label preservation（每个 header 字段驱动的是不是它声明的属主门？）${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${statusColor}${C.bold}[${attribution.status}]${C.reset} `
    + `契约 ${s.contract} · faithful ${s.faithful} · 串扰 ${s.crossTalk} · 缺属主 ${s.partial} · 死 ${s.dead} · 无声明 ${s.unattributed}\n\n`;
  for (const f of attribution.fields) {
    const mk = _ATTR_MARK[f.attribution] || { c: C.dim, m: f.attribution };
    let tail = f.wiredBy || '(无 wiredBy)';
    if (f.attribution === 'faithful') tail += ` · 属主门 ${f.ownerGates.join('/')}`;
    else if (f.attribution === 'cross-talk') tail += ` · ${C.red}泄漏到非属主门 ${f.foreignGates.join('/')}${C.reset}${C.dim}`;
    else if (f.attribution === 'partial') tail += ` · 缺属主编号 ${f.missingNums.join('/')}`;
    else if (f.attribution === 'dead') tail += ' · 一门不反应';
    out += `  ${mk.c}${mk.m}${C.reset} ${f.path.padEnd(20)} ${C.dim}${tail}${C.reset}\n`;
  }
  out += `\n  ${C.bold}目录：${C.reset}${destDir}\n`;
  out += `  ${C.dim}判据：${attribution.reason}${C.reset}\n`;
  out += `\n${C.dim}诚实边界：本层是 OPS-113 的正交对偶——OPS-113 数「有没有效应」，本层看「效应打在对的门上没」；证据不足（上游无字段）判 unverifiable 不臆断绿；只报字段路径与门名，绝不碰密钥。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-114] 还原字段归属探针（label preservation）.md${C.reset}\n`;
  process.stdout.write(out);
  return attribution.ok ? 0 : 2;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-114] 还原字段归属探针（label preservation）');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-field-attribution.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 判定逻辑改在 `scripts/lib/restoreFieldAttribution.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：效应探针「数得到」但「看不见打在哪」的盲区');
  lines.push('');
  lines.push('效应探针（OPS-113）只**数**「某快照头字段动了几道还原门」——它是 breadth-blind，只问');
  lines.push('「≥1 门反应吗？」。这抓得住「消费者被摘」（死字段），却抓不住**消费者被挪到错的门**。');
  lines.push('');
  lines.push('设想一次重构把 `crypto.algo` 的效应从 `crypto(110)` 挪到了 `provenance(107)`（来源门的');
  lines.push('裁决开始随加密算法而变）。OPS-113 依旧**全绿**——`crypto.algo` 仍然 ≥1 门反应。但这是');
  lines.push('**真串扰**：git 溯源的诚实裁决竟被加密算法左右 = 关注点泄漏；而且加密字段一旦能左右');
  lines.push('非加密裁决，还是**安全隐患**。本层就是那个缺失的**归属回归守卫**。');
  lines.push('');
  lines.push('## 思想来源：Jacobian lens 的 §4.3.2「label preservation」');
  lines.push('');
  lines.push('源自 Anthropic《Verbalizable Representations Form a Global Workspace in Language Models》。');
  lines.push('论文里，广播头（broadcast head）必须**同时**过两道独立评分：');
  lines.push('');
  lines.push('- **gain**：把一个方向放大得够广（≈ 本字段**有没有**效应）；');
  lines.push('- **label preservation**：把方向 `v_i` 忠实地映**回它自己**（`cos(W_OV v_i, v_i)` 高），');
  lines.push('  而不是把它和别的方向 `v_j` **打散**混在一起（scrambled label）。');
  lines.push('');
  lines.push('两条正交。落到 khy 还原家族：');
  lines.push('');
  lines.push('| 论文 | khy 探针 | 问的问题 | 抓的回归 |');
  lines.push('|------|----------|----------|----------|');
  lines.push('| gain / breadth | 效应探针 OPS-113 | 字段**有没有**效应？ | 消费者被摘（死字段） |');
  lines.push('| label preservation | 归属探针 OPS-114（本层） | 效应打在**对的门**上没？ | 消费者被挪错门（串扰） |');
  lines.push('');
  lines.push('## 怎么判：实际反应门集 vs 声明属主门');
  lines.push('');
  lines.push('声明属主直接取自 OPS-113 `CONTRACT_FIELDS` 每字段的 `wiredBy`（如 `OPS-107`），与门名里的');
  lines.push('编号（如 `provenance(107)`）按**数字令牌**匹配。对每个契约字段：');
  lines.push('');
  lines.push('| 归属档 | 条件 | 裁决 | ok |');
  lines.push('|--------|------|------|----|');
  lines.push('| `faithful` | 恰好只反应其声明的属主门 | label preserved | ✓ |');
  lines.push('| `cross-talk` | 反应了**非**属主门 | 串扰 / 关注点泄漏（OPS-113 看不见） | ✗ |');
  lines.push('| `partial` | 缺失某个声明的属主门（仅多属主 `wiredBy` 可能） | 声明的消费者掉了一个 | ✗ |');
  lines.push('| `dead` | 一门都不反应 | OPS-113 领域，此处照实报 | ✗ |');
  lines.push('| `unattributed` | 字段无 `wiredBy` / 取不出编号 | 无从判归属，保守非 ok | ✗ |');
  lines.push('');
  lines.push('- `ok===true` 仅当**每个**契约字段都 `faithful`；否则 `miswired`。');
  lines.push('- 若某字段**本应**被多道门消费（真正的广播字段），把 `wiredBy` 写成含多个编号的串');
  lines.push('  （如 `OPS-105+108`）——本层按「门名含其中任一编号即算属主」，缺任一属主门 → `partial`。');
  lines.push('- `--json` 在非 `ok` 时**退出码 2**：CI / 自驱 agent 据此发现「还原字段归属出现回归」。');
  lines.push('');
  lines.push('## 恒久红线（继承全家族 + 密钥卫生）');
  lines.push('');
  lines.push('- 证据不足（上游效应探针无字段：无门 / 无语料 / 结果畸形）一律判 `unverifiable`：绝不臆造绿灯。');
  lines.push('- **绝不读、绝不打印、绝不扰动任何密钥/口令/明文材料**：入参 `probeResult` 已由 OPS-113 保证');
  lines.push('  不含快照头取值；本层只碰字段路径与门名，输出只含路径、门名、OPS 号、归属标签，绝不含 header 取值。');
  lines.push('- 叶子纯计算、零 IO、绝不改入参、绝不抛；采事实复用 OPS-113 的 `buildEffectProbe`（确定性扰动）。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原字段归属探针说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const destDir = argv.find((a) => a && !a.startsWith('-')) || '.';
    const code = runFieldAttribution({ destDir, json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runFieldAttribution,
  buildAttribution,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
