#!/usr/bin/env node
/**
 * lint.mjs — 前端 lint 门禁（ESLint 程序化 API）。
 *
 * 为什么要这个脚本而不是直接在 package.json 里写 eslint 命令：
 *
 *   `npx eslint src/` 在 ESLint 8 下默认只扫 .js/.cjs/.mjs，**静默跳过 .vue**。
 *   前端 60+ 个 .vue 文件因此从未被 CI lint 过 —— 门禁存在真空，已放过 6 个
 *   error 级真 bug（useConfigSync 的 getAll 作用域错误、AIChat 的未定义 gw、
 *   AIGateway 的未定义 modelCatalog、GuiEvalRunDetail 的未导入 reactive、
 *   WebFrontendEvalDashboard 的 hasOwnProperty、AIChat 的 no-constant-condition）。
 *   本脚本用 extensions: ['.js', '.vue'] 把盲区补上。
 *
 * 为什么用 API 而不是 spawn CLI：eslint 8 的 package.json 有 exports 字段，
 *   不暴露 ./bin/eslint.js，require.resolve('eslint/bin/eslint.js') 直接抛
 *   ERR_PACKAGE_PATH_NOT_EXPORTED；而 node_modules/.bin/eslint 在 Windows 是
 *   .cmd 包装脚本，spawnSync 不带 shell 也解析不到。API 两条路都绕开，
 *   还省去一层 JSON 解析。
 *
 * 门槛设计：error 一律 0；warning 走「基线预算，只允许下降」。
 *   现状 1694 个 warning 里 1661 个是 vue/attributes-order（纯格式、可 --fix
 *   自动修，但会重排 50 个文件的模板属性顺序，diff 巨大且与功能无关）。
 *   把它一次性清干净属于独立的「模板属性排序统一」任务，不该阻塞功能改动合入。
 *   所以这里记录当前 warning 总数作为预算上限：只能持平或下降，涨了就失败。
 *   每次修掉一批就调低 BUDGET 数字。
 *
 * 退出码：0 = 通过；1 = error 非零或 warning 超预算；2 = eslint 执行异常。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ESLint } = require('eslint');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = ['.js', '.vue'];
const SRC_GLOBS = ['src/'];

// 2026-09-08 实测基线：1694（其中 1661 为 vue/attributes-order）。只允许下降。
const WARNINGS_BUDGET = 1694;
const BUDGET_NOTE =
  `warning 预算 ${WARNINGS_BUDGET}（2026-09-08 实测，其中 1661 为 vue/attributes-order 纯格式项）。` +
  '清零需一次独立的模板属性排序 --fix 任务，不阻塞功能改动。';

/** 汇总 lint 结果：总数、按规则计数、含 error 的文件。 */
function summarize(results) {
  let errors = 0;
  let warnings = 0;
  const byRule = new Map();
  const errorFiles = [];

  for (const file of results) {
    errors += file.errorCount || 0;
    warnings += file.warningCount || 0;
    if (file.errorCount) errorFiles.push(file.filePath);
    for (const message of file.messages || []) {
      const rule = message.ruleId || '(fatal)';
      byRule.set(rule, (byRule.get(rule) || 0) + 1);
    }
  }
  return { errors, warnings, byRule, errorFiles };
}

function printReport({ errors, warnings, byRule, errorFiles }) {
  console.log(`前端 lint（src/，含 ${EXTENSIONS.join(' + ')}）:`);
  console.log(`  errors:   ${errors}  ${errors === 0 ? 'OK' : 'FAIL 必须为 0'}`);
  console.log(
    `  warnings: ${warnings}  ${warnings <= WARNINGS_BUDGET ? 'OK 在预算内' : `FAIL 超出预算 ${WARNINGS_BUDGET}`}`,
  );
  console.log('  按规则:');
  for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(5)}  ${rule}`);
  }
  if (errorFiles.length) {
    console.log('  含 error 的文件:');
    for (const file of errorFiles) console.log(`    ${file}`);
  }
  console.log(`  ${BUDGET_NOTE}`);
}

try {
  const eslint = new ESLint({ extensions: EXTENSIONS, cwd: ROOT });
  const results = await eslint.lintFiles(SRC_GLOBS);
  const summary = summarize(results);
  printReport(summary);

  if (summary.errors > 0) process.exit(1);
  if (summary.warnings > WARNINGS_BUDGET) {
    console.error(
      `warning 数量 ${summary.warnings} 超过预算 ${WARNINGS_BUDGET}：预算只允许下降。` +
        '修掉新增告警，或在确认确有价值时调高本文件的 WARNINGS_BUDGET 并注明日期与理由。',
    );
    process.exit(1);
  }
  console.log('\n前端 lint 门禁通过。');
} catch (err) {
  console.error(`eslint 执行异常: ${err && err.message ? err.message : err}`);
  process.exit(2);
}
