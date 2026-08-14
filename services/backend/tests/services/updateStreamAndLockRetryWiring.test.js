'use strict';

/**
 * updateStreamAndLockRetryWiring.test.js —— `khy update` 两处修复的源级接线断言(node:test)。
 *
 * routerDispatchOps 无法脱离 CLI 上下文整体执行,故仿 pipResiduePurgeWiring 以 readFileSync + 正则
 * 断言接线要点。覆盖用户两诉求:
 *   ① 「更新时不显示下载进度」——pip 升级改为流式 tee(spawn + process.stdout.write),门控
 *      KHY_UPDATE_STREAM_PROGRESS,关时逐字节回退 execSync 捕获。
 *   ② 「pip 安装往往要第二次才成功」——file-locked(WinError 32)时消费 buildLockRetryPlan,
 *      停占用进程 + 清残骸 + 等待后以 --force-reinstall 一次性自动重试。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'cli', 'routerDispatchOps.js'),
  'utf-8'
);

// ── ① 流式下载进度 ──────────────────────────────────────────────────────────────────

test('定义了 runPipUpgrade 流式壳(Promise 形态)', () => {
  assert.match(SRC, /const runPipUpgrade\s*=\s*\(\{[^}]*\}\)\s*=>\s*new Promise\(/);
});

test('流式路径用 spawn 起 pip', () => {
  assert.match(SRC, /const \{ spawn \} = require\(['"]child_process['"]\)/);
  assert.match(SRC, /spawn\(cmd,\s*\{[^}]*shell:\s*true[^}]*\}\)/s);
});

test('把 pip 输出实时 tee 到终端(process.stdout.write)', () => {
  assert.match(SRC, /process\.stdout\.write\(s\)/);
});

test('实时 tee 的同时累积到 buffer(供残骸清理/成功判定/失败分类)', () => {
  assert.match(SRC, /buf\s*\+=\s*s/);
});

test('门控 KHY_UPDATE_STREAM_PROGRESS,关时逐字节回退 execSync 捕获', () => {
  assert.match(SRC, /KHY_UPDATE_STREAM_PROGRESS/);
  // 门关分支仍走 execSync 捕获(旧行为)。
  const gateOffIdx = SRC.indexOf('if (!streamEnabled)');
  assert.ok(gateOffIdx > 0, '应有 streamEnabled 门关分支');
  const tail = SRC.slice(gateOffIdx, gateOffIdx + 260);
  assert.match(tail, /execSync\(/);
});

test('升级循环用 await runPipUpgrade(替换旧 execSync 捕获)', () => {
  assert.match(SRC, /output\s*=\s*await runPipUpgrade\(\s*\{\s*pkgName,\s*bypassProxy,\s*forceReinstall\s*\}\s*\)/);
});

test('非零退出抛出带 .stdout 的错误(供 classifyPipFailure 消费)', () => {
  assert.match(SRC, /e\.stdout\s*=\s*buf/);
});

// ── ② 文件占用一次性自动重试 ─────────────────────────────────────────────────────────

test('声明 lockRetried 一次性标志(提到 try 外)', () => {
  assert.match(SRC, /let lockRetried = false;/);
});

test('file-locked 分支消费纯叶子 buildLockRetryPlan', () => {
  assert.match(SRC, /pipPolicy\.buildLockRetryPlan\(\s*\{[^}]*kind:\s*cls\.kind[^}]*alreadyRetried:\s*lockRetried[^}]*\}\s*\)/s);
});

test('重试前:停守护进程 + 清 pip 残骸', () => {
  const planIdx = SRC.indexOf('buildLockRetryPlan');
  const branch = SRC.slice(planIdx, planIdx + 900);
  assert.match(branch, /daemonManager['"]\)\.daemonStop\(\)/);
  assert.match(branch, /purgePipResidue\(detail\)/);
});

test('重试等待句柄释放后,以 forceReinstall 重试(--force-reinstall --no-cache-dir)', () => {
  assert.match(SRC, /await new Promise\(\(r\)\s*=>\s*setTimeout\(r,\s*lockPlan\.waitMs\)\)/);
  assert.match(SRC, /forceReinstall\s*=\s*lockPlan\.forceReinstall/);
  // buildPipCmd 在 forceReinstall 时拼上 --force-reinstall --no-cache-dir。
  assert.match(SRC, /--force-reinstall --no-cache-dir/);
});

test('重试是一次性(先置 lockRetried=true 再 continue)', () => {
  const planIdx = SRC.indexOf('buildLockRetryPlan');
  const branch = SRC.slice(planIdx, planIdx + 1400);
  const setIdx = branch.indexOf('lockRetried = true');
  const contIdx = branch.indexOf('continue');
  assert.ok(setIdx > 0, '应有 lockRetried = true');
  assert.ok(contIdx > setIdx, '应先置 lockRetried=true 再 continue');
});

test('file-locked 重试位于代理重试之后、放弃(break)之前', () => {
  const proxyRetryIdx = SRC.indexOf('proxyRetried = true');
  const lockPlanIdx = SRC.indexOf('buildLockRetryPlan');
  assert.ok(proxyRetryIdx > 0 && lockPlanIdx > proxyRetryIdx, 'file-locked 重试应在代理重试分支之后');
});
