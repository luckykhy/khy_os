'use strict';

/**
 * flagSlashArgRouting.test.js — 经典 REPL 带参 flag-slash 命令路由修复
 * （门控 KHY_FLAG_SLASH_ARG_FIX，默认开）。
 *
 * 真 bug：`/thinking on`、`/plan on` 这类**只含 flag、无 route**的开关型命令带参输入时，
 * 被 repl.js:3477 的 `!/^\/\w+\s/` 守卫排除出 slash 拦截器 → 落通用路由 → route() 返 false
 * → 误当 AI 消息转发（用户痛点「这命令不对那个部队的」）。TUI 侧不受影响（App.js:851
 * handleFlag 先读 parsed.flag）。
 *
 * 拦截器本体深耦合 REPL 闭包（_planMode/_vimHandler/rl/ai()…），无法脱壳单测；本测**逐字复刻**
 * repl.js 新增的入口判据（`_flagArgEntry` + 原守卫的并集），对真实 slash 命令表断言分派决策：
 *   - flag-only 带参 → 进入拦截器（in-process 分派，不再误发 AI）
 *   - 带 route 的命令带参（/model gpt-4）→ 不进入（保留其参数走通用路由）
 *   - 门控关 → `_flagArgEntry` 恒 null → 逐字节回退今日守卫
 */

const test = require('node:test');
const assert = require('node:assert');

const cmdReg = require('../../src/cli/commandRegistry');

const OFF_WORDS = ['0', 'false', 'off', 'no', 'disable', 'disabled'];

/** 逐字复刻 repl.js:3477 区新增的入口判据。 */
function decideEntry(trimmed, gateVal) {
  const cmds = cmdReg.toSlashCommands();
  const fixOn = !OFF_WORDS.includes(String(gateVal || '').trim().toLowerCase());
  let flagArgEntry = null;
  if (fixOn && trimmed.startsWith('/') && /^\/\w+\s+\S/.test(trimmed)) {
    const tok = '/' + trimmed.slice(1).split(/\s+/)[0].toLowerCase();
    const cand = cmds.find((sc) => sc && typeof sc.cmd === 'string' && sc.cmd.toLowerCase() === tok);
    if (cand && cand.flag && !cand.route) flagArgEntry = cand;
  }
  const origGuard = (trimmed.startsWith('/') && trimmed.length > 1 && trimmed.length <= 16 && !/^\/\w+\s/.test(trimmed));
  return { enters: !!(flagArgEntry || origGuard), viaFlagArg: !!flagArgEntry };
}

test('flag-only 命令带参 → 进入拦截器 in-process 分派（不再误发 AI）', () => {
  const d1 = decideEntry('/thinking on');
  assert.equal(d1.enters, true);
  assert.equal(d1.viaFlagArg, true);

  const d2 = decideEntry('/plan on');
  assert.equal(d2.enters, true);
  assert.equal(d2.viaFlagArg, true);
});

test('裸 flag 命令仍经原守卫进入（回归不破）', () => {
  const d = decideEntry('/thinking');
  assert.equal(d.enters, true);
  assert.equal(d.viaFlagArg, false); // 走原守卫，非新入口
});

test('带 route 的命令带参 → 不进入拦截器（保留参数走通用路由）', () => {
  // /model gpt-4 若被 flag-arg 入口吞掉会丢参数;必须让它落通用路由。
  const d = decideEntry('/model gpt-4');
  assert.equal(d.viaFlagArg, false, '带 route 的命令不应经 flag-arg 入口');
  // 长度>16 或带空格 → 原守卫也不接 → enters=false → 落通用路由（route 展开保参数）。
  assert.equal(d.enters, false);
});

test('自然语言 / 未知命令不受影响', () => {
  assert.equal(decideEntry('随便说一句话').enters, false);
  assert.equal(decideEntry('/nonexistentflag on').enters, false);
});

test('门控 KHY_FLAG_SLASH_ARG_FIX 关 → 字节回退今日行为', () => {
  // 关闭后带参 flag 命令重新落回「不进拦截器」（今日的误路由行为）。
  const d1 = decideEntry('/thinking on', 'off');
  assert.equal(d1.enters, false);
  assert.equal(d1.viaFlagArg, false);
  // 裸命令不受门控影响（走原守卫）。
  assert.equal(decideEntry('/thinking', 'off').enters, true);
});

test('flag-only 命令的 flag 字段确实存在于命令表（判据前提成立）', () => {
  const cmds = cmdReg.toSlashCommands();
  const thinking = cmds.find((sc) => sc.cmd && sc.cmd.toLowerCase() === '/thinking');
  assert.ok(thinking, '/thinking 命令应存在');
  assert.ok(thinking.flag, '/thinking 应带 flag');
  assert.ok(!thinking.route, '/thinking 应无 route（flag-only）');
});
