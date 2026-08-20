'use strict';

/**
 * triage.js — 症状分诊 CLI + 速查表生成器
 *
 * 用法：
 *   node extensions/scripts/khy-diagnostics/triage.js "识图老是404还落剪贴板"     # 分诊：症状→子系统+读哪些文件+跑哪条命令
 *   npm run maintainer:triage -- "守护进程端口漂移"                # 同上（经 npm 别名）
 *   node extensions/scripts/khy-diagnostics/triage.js --gen-doc                    # 重新生成 OPS-MAN-067 症状分诊速查表
 *
 * 设计：分诊逻辑全在纯叶子 scripts/lib/maintainerTriage.js；本文件只做 IO 与呈现。
 */

const fs = require('fs');
const path = require('path');
const { triageSymptom, loadMap } = require('../../../scripts/lib/maintainerTriage');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOC_PATH = path.join(ROOT, 'docs', '07_OPS_运维', '[OPS-MAN-067] 症状分诊速查表.md');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
};

/** 分诊并彩色打印。纯呈现，不抛。 */
function runTriage(symptom) {
  const map = loadMap();
  const results = triageSymptom(symptom, { map, limit: 3 });
  if (!results.length) {
    process.stdout.write(
      `${C.yellow}没有匹配到明确的子系统。${C.reset}\n` +
      `建议：把报错原文或更具体的现象再描述一遍；或直接查总入口 docs/00_INDEX_文档索引.md。\n` +
      `也可以打开速查表逐条对照：docs/07_OPS_运维/[OPS-MAN-067] 症状分诊速查表.md\n`
    );
    return;
  }
  process.stdout.write(`${C.bold}症状：${C.reset}${symptom}\n\n`);
  results.forEach((r, i) => {
    const rank = i === 0 ? `${C.green}最可能${C.reset}` : `${C.dim}也看看${C.reset}`;
    process.stdout.write(`${rank} ${C.cyan}${C.bold}${r.label}${C.reset} ${C.dim}(${r.id}, 匹配分 ${r.score})${C.reset}\n`);
    if (r.firstFile) process.stdout.write(`  先读：${r.firstFile}\n`);
    if (r.paths.length > 1) process.stdout.write(`  ${C.dim}相关文件：${r.paths.slice(1, 4).join('、')}${r.paths.length > 4 ? ' …' : ''}${C.reset}\n`);
    if (r.firstVerify) process.stdout.write(`  ${C.green}跑这条验证：${C.reset}${r.firstVerify}\n`);
    if (r.docs && r.docs.length) process.stdout.write(`  ${C.dim}参考文档：${r.docs[0]}${C.reset}\n`);
    process.stdout.write('\n');
  });
  process.stdout.write(`${C.dim}提示：按 B1 先说清「改什么/为什么/影响面」，改完跑上面的验证命令，绿灯才算修好（B2）。${C.reset}\n`);
}

/** 生成 OPS-MAN-067 速查表 Markdown（反向索引：每个子系统的触发词→文件→命令）。确定性。 */
function buildDoc() {
  const map = loadMap();
  const lines = [];
  lines.push('# [OPS-MAN-067] Khy-OS 症状分诊速查表');
  lines.push('');
  lines.push('> 出问题时的第一站：用 `Ctrl-F` 搜你看到的现象/报错词，跳到对应子系统，照着「先读文件」和「跑这条验证」做。');
  lines.push('> 本表由 `docs/_维护者/维护映射表.json` 确定性生成，子系统长大后重跑 `npm run maintenance:triage-doc` 即自动覆盖。');
  lines.push('');
  lines.push('## 更快的用法：直接问分诊器');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run maintainer:triage -- "识图老是404还落剪贴板"     # 症状 → 子系统 + 读哪些文件 + 跑哪条命令');
  lines.push('npm run maintainer:triage -- "守护进程端口漂移连不上"');
  lines.push('npm run maintainer:triage -- "slash command missing"');
  lines.push('```');
  lines.push('');
  lines.push('## 通用纪律（改动前必读）');
  lines.push('');
  lines.push('- **B1 先想再写**：动手前一句话说清「改什么 / 为什么 / 影响面」。');
  lines.push('- **B2 验证到绿**：改完必须跑本表给的验证命令，**没跑过验证不许说「修好了」**。');
  lines.push('- **B3 外科手术式改动**：只动该动的，不顺手重构。');
  lines.push('- **红线**：不 AI 自动 commit/push；真 key/token 绝不进源码/包/提交/对话。');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 分诊索引（共 ' + map.length + ' 个子系统）');
  lines.push('');

  for (const a of map) {
    lines.push(`### ${a.label}  \`${a.id}\``);
    lines.push('');
    if (a.whenToUse.length) {
      lines.push('**什么时候来这里（症状触发词）：**');
      for (const w of a.whenToUse) lines.push(`- ${w}`);
      lines.push('');
    }
    if (a.paths.length) {
      lines.push('**先读这些文件：**');
      for (const p of a.paths.slice(0, 8)) lines.push('- `' + p + '`');
      lines.push('');
    }
    if (a.docs.length) {
      lines.push('**参考文档：**');
      for (const d of a.docs) lines.push('- ' + d);
      lines.push('');
    }
    if (a.verify.length) {
      lines.push('**跑这些验证命令（绿灯＝这块没坏）：**');
      lines.push('');
      lines.push('```bash');
      for (const v of a.verify) lines.push(v);
      lines.push('```');
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  lines.push('## 都不对？');
  lines.push('');
  lines.push('- 把报错原文完整贴给分诊器：`npm run maintainer:triage -- "<把报错粘这里>"`。');
  lines.push('- 仍无匹配就查总入口 `docs/00_INDEX_文档索引.md`，或读 `.ai/MAP.md` 了解全局骨架。');
  lines.push('- 新子系统请先登记进 `docs/_维护者/维护映射表.json`，本表下次重生会自动收录它。');
  lines.push('');
  return lines.join('\n');
}

function writeDoc() {
  const md = buildDoc();
  fs.writeFileSync(DOC_PATH, md, 'utf8');
  return { path: DOC_PATH, bytes: Buffer.byteLength(md, 'utf8') };
}

module.exports = { runTriage, buildDoc, writeDoc, DOC_PATH };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    const res = writeDoc();
    process.stdout.write(`OK 写出速查表 → ${path.relative(ROOT, res.path)} (${res.bytes} bytes)\n`);
  } else {
    const symptom = argv.join(' ').trim();
    if (!symptom) {
      process.stdout.write('用法: node extensions/scripts/khy-diagnostics/triage.js "<症状/报错文本>"  或  --gen-doc\n');
      process.exit(0);
    }
    runTriage(symptom);
  }
}
