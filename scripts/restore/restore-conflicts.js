'use strict';

/**
 * restore-conflicts.js — 三面镜子「矛盾冲突」检测 CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-conflicts.js            # 采集三面镜子 → 检测彼此是否矛盾
 *   npm run restore-conflicts                     # 同上（经 npm 别名）
 *   node scripts/restore-conflicts.js --json      # 机器可读（landing agent 先读这个）
 *   node scripts/restore-conflicts.js --gen-doc   # 重新生成 OPS-MAN-076 说明
 *
 * 设计：检测逻辑全在纯叶子 scripts/lib/restoreConflictDetector.js（零 IO、可离线全测）；
 * 本文件只做两件事——
 *   (1) **复用** restore-plan.js 的 gatherAssessments 采集三面镜子评估（零重复）；
 *   (2) 呈现 / 落盘。
 *
 * 为谁而写：一个落地在陌生机器上的 agent，在信任合成的还原方案、开始无人值守自动
 * 还原**之前**，先跑 `khy restore-conflicts --json`。若 safeToAutodrive 为 false
 * （存在硬矛盾），agent 必须停下：重探或升级交人，绝不在自相矛盾的世界模型上自动行动。
 */

const fs = require('fs');
const path = require('path');

const { detectRestoreConflicts, _CONFLICT_RULES, SEVERITY_CONTRADICTION } =
  require('../lib/restoreConflictDetector');
// 复用 restore-plan 的三面镜子采集器（零重复；它已 fail-soft 包好三个探测器）。
const { gatherAssessments } = require('./restore-plan');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-076] 三面镜子矛盾冲突检测.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', magenta: '\x1b[35m',
};

// ── 呈现层 ───────────────────────────────────────────────────────────────────

/** 采集 → 检测 → 彩色打印。返回退出码（0=可自动还原，1=有硬矛盾须止步）。不抛。 */
function runRestoreConflicts(opts = {}) {
  const mirrors = gatherAssessments();
  const report = detectRestoreConflicts(mirrors);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ mirrors, report }, null, 2) + '\n');
    return report.safeToAutodrive ? 0 : 1;
  }
  const head = report.safeToAutodrive
    ? `${C.green}${C.bold}✔ ${report.summary}${C.reset}`
    : `${C.red}${C.bold}✘ ${report.summary}${C.reset}`;
  let out = `${C.bold}Khy-OS 三面镜子矛盾冲突检测${C.reset}\n`;
  out += `${C.dim}渠道：pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n`;
  out += `${C.dim}比对：restore-check ✕ verify-install ✕ hydration-doctor${C.reset}\n\n`;
  out += head + '\n\n';
  if (report.conflicts.length === 0) {
    out += `${C.green}三面镜子彼此一致，合成的还原方案可信。${C.reset}\n`;
  } else {
    for (const c of report.conflicts) {
      const tag = c.severity === SEVERITY_CONTRADICTION
        ? `${C.red}硬矛盾${C.reset}`
        : `${C.yellow}分级分歧${C.reset}`;
      out += `${C.bold}• [${tag}${C.bold}] ${c.title}${C.reset}\n`;
      out += `   ${C.dim}涉及镜子：${c.mirrors.join(' ✕ ')}｜信谁：${c.trust}｜自主度：${c.autonomy}${C.reset}\n`;
      out += `   ${C.dim}处置：${c.advice}${C.reset}\n`;
    }
    out += '\n';
    if (!report.safeToAutodrive) {
      out += `${C.magenta}存在硬矛盾——agent 禁止自动还原，须先重探或升级交人。${C.reset}\n`;
    } else {
      out += `${C.green}仅分级分歧，不阻断自动还原；按更悲观口径权衡即可。${C.reset}\n`;
    }
  }
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-076] 三面镜子矛盾冲突检测.md${C.reset}\n`;
  process.stdout.write(out);
  return report.safeToAutodrive ? 0 : 1;
}

// ── 文档生成（与规则表同源，防手改漂移）──────────────────────────────────────

/** 由 _CONFLICT_RULES 确定性生成说明 markdown。纯函数，不做 IO。 */
function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-076] 三面镜子矛盾冲突检测');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-conflicts.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 规则改在 `scripts/lib/restoreConflictDetector.js` 的 `_CONFLICT_RULES`，再重新生成。');
  lines.push('');
  lines.push('## 这份检测是干什么的');
  lines.push('');
  lines.push('khyos 有三面独立还原镜子，探同一批事实却走不同代码路径：');
  lines.push('');
  lines.push('- `restore-check`（OPS-MAN-068）：这台机器能不能还原？');
  lines.push('- `verify-install`（OPS-MAN-069）：已装副本完整吗？');
  lines.push('- `hydration-doctor`（OPS-MAN-070）：首启水合成功了吗？');
  lines.push('');
  lines.push('`restore-plan`（OPS-MAN-075）把三者**合成**成一份有序还原方案——但它**默认三面镜子一致**。');
  lines.push('不同代码路径可能给出**互相矛盾的结论**。一个 agent 若拿着**自相矛盾的世界模型**');
  lines.push('去无人值守自动还原，会照着一面绿灯猛冲、无视另一面红灯。本检测补上这层**元诊断**：');
  lines.push('在 agent 信任方案、开始自动还原**之前**，先问「三面镜子彼此一致吗？」。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-conflicts.js --json   # landing agent 先读这个');
  lines.push('# safeToAutodrive=false（有硬矛盾）→ agent 必须停下：重探或升级交人');
  lines.push('```');
  lines.push('');
  lines.push('## 两级冲突');
  lines.push('');
  lines.push('- **`contradiction`（硬矛盾）**：两面镜子对重叠事实给出逻辑不相容的结论，');
  lines.push('  或某面镜子自身顶层判定与明细自相矛盾。→ 世界模型不可信，**禁止自动还原**。');
  lines.push('- **`severity`（分级分歧）**：两面镜子认同同一事实但给了不同严重度');
  lines.push('  （如 node_modules 尚未水合：一面当首启正常提醒、一面当拦路项）。→ 事实一致、');
  lines.push('  不阻断自动还原，但如实标注供 agent 权衡。');
  lines.push('');
  lines.push('消解取向恒为**安全优先**：矛盾时一律信更悲观那面镜子；每条冲突的自主度恒为');
  lines.push('`human`（不确定就交人，绝不让 agent 替你赌）。`safeToAutodrive` 为 false 当且仅当');
  lines.push('存在 `contradiction` 级冲突。');
  lines.push('');
  lines.push('## 检测的冲突规则');
  lines.push('');
  lines.push('| 规则 id | 级别 | 涉及镜子 | 信谁 | 症状 |');
  lines.push('|---------|------|----------|------|------|');
  for (const r of _CONFLICT_RULES) {
    const level = r.severity === SEVERITY_CONTRADICTION ? '硬矛盾' : '分级分歧';
    const mirrors = (Array.isArray(r.mirrors) ? r.mirrors : []).join(' ✕ ');
    const title = String(r.title).replace(/\|/g, '\\|');
    lines.push(`| \`${r.id}\` | ${level} | ${mirrors} | ${r.trust} | ${title} |`);
  }
  lines.push('');
  lines.push('> 注：`ready-but-hydration-blocked` 会在运行期按 hydration 的 blocker 内容动态降级——');
  lines.push('> 若 blocker 全是首启正常态（node_modules 尚未水合）则降为 `severity`，否则维持硬矛盾。');
  lines.push('');
  lines.push('## 保证（继承项目章程）');
  lines.push('');
  lines.push('- 纯比对、零 IO、绝不抛：异常退化为「不放行自动还原」（不确定不自动，安全优先）。');
  lines.push('- 处置建议绝不含 commit/push/rm/curl/publish 类危险动作；来源若不慎命中则隐去。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(`OK 写出矛盾检测说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`);
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const code = runRestoreConflicts({ json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runRestoreConflicts,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
