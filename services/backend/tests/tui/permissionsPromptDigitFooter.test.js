'use strict';

/**
 * permissionsPromptDigitFooter.test.js — 授权框 footer 与 handler 能力一致性守卫(BUG-36)。
 *
 * 缺陷本体:PermissionsPrompt 的 useInput 对 L1/L2 共用同一段数字键直选逻辑
 * (`navCh >= '1' && navCh <= '9'` -> 立即 resolve,不看光标),但 footer 的 L2 两个分支
 * 唯独不写「数字键直选」——仓内其余浮层(QuestionPrompt / FormFlow / RewindPicker)以及
 * 本组件的 L1 分支都写了。用户照 footer 以为只能 ↑/↓+Enter,实际按一个数字键就定了。
 *
 * 这里挂**真实 ink + 真实组件**,喂真字节,锁两件事:
 *   1) footer 三种变体(L1 / L2 允许优先 / L2 高危 opt-out)都列全 handler 实际接受的键类;
 *   2) 数字键在 L2 上的真实后果(按 '2' = 本会话总是允许此类高危)——若将来改变该策略,
 *      本用例必须同步改,好让那次改变是显式的而非顺手发生(BUG-36b 的裁决点)。
 *
 * 跑法同 inkRenderSmoke:需 --experimental-vm-modules(见 scripts/run-ink-tui-tests.js)。
 */

const { EventEmitter } = require('events');
const { Writable } = require('stream');
const React = require('react');

const rt = require('../../src/cli/tui/inkRuntime');

process.env.KHY_TUI_PREWARM = '0';

const VM_MODULES = (process.env.NODE_OPTIONS || '').includes('experimental-vm-modules');
const describeOrSkip = VM_MODULES ? describe : describe.skip;

if (!VM_MODULES) {
  // eslint-disable-next-line no-console
  console.warn(
    '[permissionsPromptDigitFooter] skipped — needs NODE_OPTIONS=--experimental-vm-modules. ' +
      'Run: npm run --workspace backend test:tui'
  );
}

const ESC = String.fromCharCode(27);
const stripAnsi = (s) =>
  String(s)
    .replace(new RegExp(ESC + '\[[0-9;?]*[A-Za-z]', 'g'), '')
    .replace(/[\u2502\u2500\u250c\u2510\u2514\u2518]/g, '');

/** ink 的 stdin 契约:components/App.js 只 addListener('readable') + read(),不 resume。 */
function pressableStdin() {
  const stream = new EventEmitter();
  let queue = '';
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  stream.read = () => {
    if (!queue) return null;
    const out = queue;
    queue = '';
    return out;
  };
  stream.press = (bytes) => {
    queue += bytes;
    stream.emit('readable');
  };
  return stream;
}

function collectingStdout() {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buffer += chunk.toString();
      cb();
    },
  });
  stream.columns = 100;
  stream.rows = 30;
  stream.isTTY = true;
  stream.getBuffer = () => buffer;
  return stream;
}

const L2_REQ = {
  tool_name: 'Bash',
  input: { command: 'rm -rf /var/data', level: 'L2', action: 'delete', scope: 'filesystem', requireTyped: 'YES' },
};
const L1_REQ = {
  tool_name: 'Write',
  input: { command: '', level: 'L1', action: 'write', scope: 'workspace', description: '写一个文件' },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function mount(request, envOverride) {
  const saved = process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK;
  if (envOverride === undefined) delete process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK;
  else process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK = envOverride;
  const ink = await rt.loadInk();
  const Comp = require('../../src/cli/tui/ink-components/PermissionsPrompt');
  const stdin = pressableStdin();
  const stdout = collectingStdout();
  let resolved = '<<none>>';
  let hit = false;
  const instance = ink.render(
    React.createElement(Comp, { request, onResolve: (v) => { hit = true; resolved = v; } }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false }
  );
  await wait(60);
  return {
    frame: stripAnsi(stdout.getBuffer()),
    press: async (bytes) => { stdin.press(bytes); await wait(60); },
    got: () => ({ hit, resolved }),
    unmount: () => instance.unmount(),
    restore: () => {
      if (saved === undefined) delete process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK;
      else process.env.KHY_PERMISSION_ALLOW_FIRST_HIGHRISK = saved;
    },
  };
}

const footerOf = (frame) => (frame.split('\n').find((l) => /Enter 选择/.test(l)) || '').trim();

describeOrSkip('PermissionsPrompt footer 与实际接受的键类一致(BUG-36)', () => {
  test('L2 允许优先变体:footer 必须写明数字键直选', async () => {
    const m = await mount(L2_REQ);
    try {
      const f = footerOf(m.frame);
      expect(f).toContain('数字键');
      expect(f).toContain('默认「确认执行」');
    } finally { m.unmount(); m.restore(); }
  });

  test('L2 高危 opt-out 变体(默认拒绝):footer 同样写明数字键', async () => {
    const m = await mount(L2_REQ, 'off');
    try {
      const f = footerOf(m.frame);
      expect(f).toContain('数字键');
      expect(f).toContain('默认「拒绝」');
    } finally { m.unmount(); m.restore(); }
  });

  test('L1 变体:footer 三个键类齐全(回归对照)', async () => {
    const m = await mount(L1_REQ);
    try {
      const f = footerOf(m.frame);
      expect(f).toContain('数字键');
      expect(f).toContain('Enter');
      expect(f).toContain('Esc');
    } finally { m.unmount(); m.restore(); }
  });

  test('数字键在 L2 上的真实后果:按 1=确认执行,按 2=本会话总是允许此类(BUG-36b 裁决点)', async () => {
    const m1 = await mount(L2_REQ);
    try {
      await m1.press('1');
      expect(m1.got().hit).toBe(true);
      expect(m1.got().resolved).toEqual({ behavior: 'allow', typed: 'YES' });
    } finally { m1.unmount(); m1.restore(); }

    const m2 = await mount(L2_REQ);
    try {
      await m2.press('2');
      expect(m2.got().hit).toBe(true);
      expect(m2.got().resolved).toEqual({ behavior: 'allow-always', typed: 'YES', scope: 'session' });
    } finally { m2.unmount(); m2.restore(); }
  });

  test('高危 opt-out 态下数字键跟随排序:按 1 = 拒绝', async () => {
    const m = await mount(L2_REQ, 'off');
    try {
      await m.press('1');
      expect(m.got().hit).toBe(true);
      expect(m.got().resolved).toBe(false);
    } finally { m.unmount(); m.restore(); }
  });
});
