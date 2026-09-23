'use strict';

/**
 * noticeShape — 转录消息的键名契约（BUG-30）。
 *
 * `Transcript.js` 的 MessageBlock 只按 `msg.role` 分派，末尾 `return null`。
 * 于是 `{ type: 'notice' }` 这种写法不会报错，只会**静默不显示**：用户永远看不到
 * 那条通知（复现见 `.khy/feedback/tui-ux-audit-20260919/V/repro-before.txt`，
 * 唯一变量 = 键名：同一对象 `role` 上屏、`type` 不上屏）。
 * 本守卫钉住「进 messages 的字面量必须带 role」，防止这个拼法再回来。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TUI = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui');
const APP = path.join(TUI, 'ink-components', 'App.js');
const BRIDGE = path.join(TUI, 'hooks', 'useQueryBridge.js');

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

// 消息字面量里的 `type:` 键 = 死形状。`chunk.type === 'notice'` 那类是桥事件，
// 不是消息，故只匹配对象字面量写法。
const DEAD_KEY = /type:\s*'(notice|error|user|assistant)'/;

function deadShapeOffenders(file) {
  const lines = readLines(file);
  const hits = [];
  lines.forEach((ln, i) => {
    if (!DEAD_KEY.test(ln)) return;
    const body = lines.slice(Math.max(0, i - 3), i + 5).join(' ');
    if (!/\brole:/.test(body)) hits.push(`${path.basename(file)}:${i + 1}`);
  });
  return hits;
}

test('no transcript message literal is keyed by `type`', () => {
  assert.deepStrictEqual(deadShapeOffenders(APP), []);
  assert.deepStrictEqual(deadShapeOffenders(BRIDGE), []);
});

test('the four formerly-dead notices are keyed by `role`', () => {
  const app = fs.readFileSync(APP, 'utf8');
  const bridge = fs.readFileSync(BRIDGE, 'utf8');
  // 自维护顾问人面（两处）
  assert.ok(app.includes("{ role: 'notice', content: adv.humanLine"));
  assert.ok(bridge.includes("{ role: 'notice', content: adv.humanLine"));
  // 更新生命周期通知（发现更新 / 已阻止 / 已跳过 / 已暂存）
  assert.ok(app.includes("{ role: 'notice', content: String(content)"));
  // @ 引用敏感文件的安全拦截提示（多行字面量：定位到那一处再判其键名，
  // 否则 `role: 'notice',` 在别处也出现，断言会变成永真）
  const atSite = app.slice(app.indexOf('const notices = at.blocked.map'));
  assert.ok(atSite.length > 40, '@-mention notice site not found');
  assert.ok(/^const notices = at\.blocked\.map\(\(b\) => \(\{\s*\r?\n\s*role: 'notice',/.test(atSite));
  assert.ok(atSite.includes('安全：已拦截通过'));
});
