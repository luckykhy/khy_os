#!/usr/bin/env node
/**
 * @pattern Template Method, Visitor
 *
 * check-build-artifacts.js — 守住「可再生构建产物不进版本库」这条线。
 *
 *   node scripts/ci/check-build-artifacts.js            # 违规则 exit 1
 *   node scripts/ci/check-build-artifacts.js --json     # 机器可读
 *   node scripts/ci/check-build-artifacts.js --worktree # 另查工作树是否有未忽略的产物
 *
 * 为什么查的是**已跟踪集合**而不是磁盘：`apps/khy-mobile/android/app/build`
 * 现在躺着 118 MB，这完全正常——它本来就该在磁盘上、被 .gitignore 挡住。
 * 真正的事故是它被跟踪。二进制一旦进了 git 历史，`git rm` 也删不掉体积，
 * 只能改写历史。所以这道门必须在 commit 之前就拦住，而不是事后算总账。
 *
 * `--worktree` 是配套的诊断态：构建完跑一次，确认 Gradle 没有往 ignore 规则
 * 之外的地方吐东西（计划里的「Android 构建后 git status 无生成物」验收项）。
 * 它只报告、不改任何文件。
 *
 * 判定逻辑全在纯叶子 scripts/lib/buildArtifactGuard.js；本文件只负责调 git。
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const guard = require('../lib/buildArtifactGuard');

const ROOT = path.resolve(__dirname, '..', '..');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const alsoWorktree = argv.includes('--worktree');

/**
 * git 输出取行。失败时返回 null 而不是空数组——「查不到」和「确实没有」
 * 必须可区分，否则 git 不可用时这道门会伪装成通过。
 */
function gitLines(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function main() {
  const tracked = gitLines(['ls-files']);
  if (tracked === null) {
    console.error('check-build-artifacts: 无法执行 git ls-files（不是 git 仓库或 git 不可用）。');
    process.exit(2);
  }

  const result = guard.inspect(tracked);

  // 工作树态：--porcelain 已经排除了被忽略的文件，所以这里剩下的
  // 都是「ignore 规则没盖住」的产物，正是我们要发现的漏网之鱼。
  let worktree = null;
  if (alsoWorktree) {
    const status = gitLines(['status', '--porcelain']);
    const paths = (status || []).map((line) => line.slice(3).replace(/^"|"$/g, ''));
    worktree = guard.inspect(paths);
  }

  if (asJson) {
    console.log(JSON.stringify({ tracked: result, worktree }, null, 2));
  } else {
    console.log(guard.render(result));
    if (worktree) {
      console.log('');
      console.log('工作树（未被 .gitignore 覆盖的产物）：');
      console.log(guard.render(worktree));
    }
  }

  const failed = result.violations.length > 0
    || (worktree !== null && worktree.violations.length > 0);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { gitLines };
