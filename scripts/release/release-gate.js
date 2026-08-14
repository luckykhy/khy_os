#!/usr/bin/env node
'use strict';
/**
 * 发布门禁运行器(薄壳)。
 *
 * 把仓库既有、已验证的硬检查(check:* / test:maintainer:*)编排成一条可阻断的
 * 发布链:顺序执行确定性 must 阶段,首个失败即以退出码 1 阻断,并输出结构化的逐
 * 阶段 PASS/FAIL + 失败定位;对无法在本机确定性执行的环节(干净容器新装、真实升级、
 * 前后端实连、回滚)诚实标为 MANUAL 并打印确切命令,绝不静默放行。
 *
 * 所有阶段定义与判定逻辑在纯叶子 scripts/release/lib/releaseGateStages.js 内,本文件
 * 只负责执行命令、着色输出、决定退出码等副作用。
 *
 * 用法:
 *   node scripts/release/release-gate.js                 # tier=must(最小硬门槛)
 *   node scripts/release/release-gate.js --tier=all      # must + recommended(完整彩排)
 *   node scripts/release/release-gate.js --json          # 机器可消费 JSON,退出码同上
 *   node scripts/release/release-gate.js --keep-going     # 不在首个失败停,跑完全部再汇总
 *
 * 退出码:0 = 自动化门禁 GO(确定性检查全过);1 = NO-GO(存在 must 阶段失败)。
 */

const cp = require('child_process');
const path = require('path');
const gate = require('./lib/releaseGateStages');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = argv.slice(2);
  let tier = 'must';
  let json = false;
  let keepGoing = false;
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a === '--keep-going') keepGoing = true;
    else if (a === '--all') tier = 'all';
    else if (a.startsWith('--tier=')) tier = a.slice('--tier='.length).trim() || 'must';
  }
  return { tier, json, keepGoing };
}

// 颜色仅在 TTY 且非 JSON 模式启用,避免污染管道/日志。
function colorizer(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    green: wrap('32'),
    red: wrap('31'),
    yellow: wrap('33'),
    cyan: wrap('36'),
    dim: wrap('2'),
  };
}

/**
 * 执行一个确定性阶段。返回标准结果(pass/fail),带耗时与失败定位摘要。
 * 命令失败(非零退出、或二进制缺失)一律记为 fail —— 发布门禁宁可误报也不静默放行。
 */
function runStage(stage, { hrNow }) {
  const start = hrNow();
  let status = 'pass';
  let code = 0;
  let detail = '';
  try {
    cp.execSync(stage.command, {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      env: process.env,
      timeout: 30 * 60 * 1000, // 30min 硬上限:防单阶段挂死拖垮整条门禁。
    });
  } catch (err) {
    status = 'fail';
    code = typeof err.status === 'number' ? err.status : 1;
    const out = [err.stdout, err.stderr]
      .map((b) => (b ? b.toString('utf8') : ''))
      .join('\n')
      .trim();
    detail = out || (err.message || 'command failed');
  }
  const ms = Math.max(0, Math.round(hrNow() - start));
  return gate.makeResult(stage, { status, code, ms, detail });
}

function main() {
  const { tier, json, keepGoing } = parseArgs(process.argv);
  const useColor = !json && process.stdout.isTTY;
  const c = colorizer(useColor);
  const hrNow = () => Number(process.hrtime.bigint() / 1000000n);

  const { runnable, manual } = gate.selectStages(tier);

  if (!json) {
    process.stdout.write(
      `${c.cyan('发布门禁')} tier=${tier} —— ${runnable.length} 个确定性阶段, ` +
        `${manual.length} 个环境门(手动)\n`,
    );
    process.stdout.write('='.repeat(60) + '\n');
  }

  const results = [];
  let blocked = false;
  for (const stage of runnable) {
    if (blocked && !keepGoing) {
      results.push(gate.makeResult(stage, { status: 'skip' }));
      if (!json) {
        process.stdout.write(
          `${c.dim('[SKIP]')} ${stage.title} ${c.dim('(前序 must 已失败)')}\n`,
        );
      }
      continue;
    }
    if (!json) process.stdout.write(`${c.dim('· 运行')} ${stage.title} ...\n`);
    const r = runStage(stage, { hrNow });
    results.push(r);
    if (!json) {
      const mark =
        r.status === 'pass' ? c.green('[PASS]') : c.red('[FAIL]');
      process.stdout.write(`  ${mark} ${stage.title} ${c.dim(`(${r.ms}ms)`)}\n`);
      if (r.status === 'fail') {
        process.stdout.write(`  ${c.red('定位')}: ${gate.firstLines(r.detail, 4)}\n`);
      }
    }
    if (r.status === 'fail' && r.tier === 'must') blocked = true;
  }

  // 环境门:始终以 MANUAL 记录,永不参与自动 PASS。
  for (const stage of manual) {
    results.push(gate.makeResult(stage, { status: 'manual' }));
  }

  const verdict = gate.computeVerdict(results);

  if (json) {
    process.stdout.write(JSON.stringify(gate.toJson(results, verdict), null, 2) + '\n');
  } else {
    process.stdout.write('\n' + gate.formatReport(results, verdict) + '\n');
    const banner = verdict.automatedGo
      ? c.green('GO(自动化)')
      : c.red('NO-GO');
    process.stdout.write(`\n最终: ${banner}\n`);
  }

  process.exit(verdict.automatedGo ? 0 : 1);
}

main();
