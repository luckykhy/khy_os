'use strict';

/**
 * shellEmptyOutputNote — 「成功但零输出」确定性说明的单测(node:test)。
 *
 * 回归目标(goal 截图 Image #4):`jest ... | grep ... | head` 这类过滤器收尾的管道
 * exit 0 但 stdout 空 → 旧行为渲染裸「(无输出)」令用户困惑。验证:过滤器末段给出
 * 「上游无匹配/无可显示行」说明、非过滤器给通用成功说明、门控关字节回退 null、
 * RTK/sudo/env/路径前缀正确剥离、fail-soft 绝不抛。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/tools/shellEmptyOutputNote');

test('buildEmptyOutputNote:过滤器/分页器末段 → 指出上游无可显示行(含命令名)', () => {
  const cases = [
    ['jest x 2>&1 | grep -iE "Tests:|PASS|FAIL" | head', 'head'],
    ['cat log | grep error', 'grep'],
    ['dmesg | tail -20', 'tail'],
    ['ps aux | rg node', 'rg'],
    ['find . -name "*.js" | wc -l', 'wc'],
  ];
  for (const [cmd, tail] of cases) {
    const note = mod.buildEmptyOutputNote(cmd, {});
    assert.ok(note, cmd);
    assert.ok(/✓/.test(note), '应以 ✓ 起头示成功: ' + cmd);
    assert.ok(/退出码 0/.test(note), '应说明退出码 0: ' + cmd);
    assert.ok(note.includes('`' + tail + '`'), '应含末段命令名 ' + tail + ': ' + cmd);
    assert.ok(/echo/.test(note), '应引导用 echo 成功标记: ' + cmd);
  }
});

test('buildEmptyOutputNote:非过滤器末段 → 通用成功说明(不臆测原因)', () => {
  for (const cmd of ['node build.js', 'make', 'touch /tmp/x', 'mkdir -p a/b/c']) {
    const note = mod.buildEmptyOutputNote(cmd, {});
    assert.ok(note, cmd);
    assert.ok(/✓/.test(note), cmd);
    assert.ok(/没有产生任何输出/.test(note), cmd);
    // 通用分支不应臆测「过滤器/上游无匹配」
    assert.ok(!/过滤器/.test(note), '非过滤器不应提过滤器: ' + cmd);
  }
});

test('buildEmptyOutputNote:门控关 → null(字节回退保持空串)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.strictEqual(
      mod.buildEmptyOutputNote('cat x | head', { KHY_SHELL_EMPTY_OUTPUT_NOTE: off }),
      null,
      off,
    );
  }
  // 显式开 / 未设 → 非 null
  assert.ok(mod.buildEmptyOutputNote('cat x | head', { KHY_SHELL_EMPTY_OUTPUT_NOTE: 'on' }));
  assert.ok(mod.buildEmptyOutputNote('cat x | head', {}));
});

test('emptyOutputNoteEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.emptyOutputNoteEnabled({}), true);
  assert.strictEqual(mod.emptyOutputNoteEnabled({ KHY_SHELL_EMPTY_OUTPUT_NOTE: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.strictEqual(mod.emptyOutputNoteEnabled({ KHY_SHELL_EMPTY_OUTPUT_NOTE: off }), false, off);
  }
});

test('_tailBaseCommand:取管道/逻辑链末段并剥前缀', () => {
  assert.strictEqual(mod._tailBaseCommand('cat f | grep x | head'), 'head');
  assert.strictEqual(mod._tailBaseCommand('a && b && grep z'), 'grep');
  assert.strictEqual(mod._tailBaseCommand('/usr/bin/head -5'), 'head');   // 路径 basename
  assert.strictEqual(mod._tailBaseCommand('rtk head file'), 'head');      // 剥 RTK 前缀
  assert.strictEqual(mod._tailBaseCommand('sudo tail -f log'), 'tail');   // 剥 sudo
  assert.strictEqual(mod._tailBaseCommand('FOO=1 grep p f'), 'grep');     // 剥 env 赋值
  assert.strictEqual(mod._tailBaseCommand(''), '');
  assert.strictEqual(mod._tailBaseCommand(null), '');
});

test('buildEmptyOutputNote:fail-soft — 异常输入绝不抛', () => {
  // 传入非字符串 command,内部 String() 归一,绝不抛
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.doesNotThrow(() => mod.buildEmptyOutputNote(bad, {}));
  }
});

test('RTK 前缀的过滤器管道仍被识别为过滤器', () => {
  const note = mod.buildEmptyOutputNote('rtk grep pattern | rtk head', {});
  assert.ok(note);
  assert.ok(note.includes('`head`'), '剥 RTK 后末段应为 head');
  assert.ok(/过滤器/.test(note));
});

// ── Pit 2:列举/枚举命令零输出 → 提示「路径不存在/写错」而非「扫过没结果」 ──

test('_looksLikeEnumeration:PowerShell cmdlet 整串匹配', () => {
  const yes = [
    "powershell -Command \"Get-ChildItem -Path 'D:\\x'\"",
    'pwsh -c "Get-Item C:\\a"',
    'powershell -Command "gci -Recurse"',
  ];
  for (const c of yes) assert.strictEqual(mod._looksLikeEnumeration(c), true, c);
});

test('_looksLikeEnumeration:dir/ls/find/tree 仅在命令位置匹配(不撞路径子串)', () => {
  const yes = [
    'dir C:\\Users',
    'ls -la /tmp',
    'find . -name "*.csv"',
    'tree /F',
    'powershell -Command "dir D:\\"',
    'cmd /c "dir C:\\"',
  ];
  for (const c of yes) assert.strictEqual(mod._looksLikeEnumeration(c), true, c);
  // 路径里含 dir/find 子串,但不在命令位置 → 不误判
  const no = [
    'cat /home/dir/file.txt',
    'node scripts/finder.js',
    'echo tree',
    'cat findings.log',
  ];
  for (const c of no) assert.strictEqual(mod._looksLikeEnumeration(c), false, c);
});

test('buildEmptyOutputNote:列举命令零输出 → 提示路径不存在/写错 + 核实建议', () => {
  const cases = [
    "powershell -Command \"Get-ChildItem -Path 'D:\\不存在'\"",
    'pwsh -c "gci C:\\Users\\25789\\Downloads"',
    'dir D:\\HuaweiMoveData',
    'ls -la /nonexistent',
    'find /data -name "*.csv"',
  ];
  for (const cmd of cases) {
    const note = mod.buildEmptyOutputNote(cmd, {});
    assert.ok(note, cmd);
    assert.ok(/✓/.test(note), '应以 ✓ 起头示成功: ' + cmd);
    assert.ok(/退出码 0/.test(note), cmd);
    assert.ok(/路径不存在或写错/.test(note), '应提示路径问题: ' + cmd);
    assert.ok(/Test-Path|ls -d/.test(note), '应给核实建议: ' + cmd);
    // 不应错报成过滤器分支
    assert.ok(!/过滤器/.test(note), cmd);
  }
});

test('buildEmptyOutputNote:列举命令门控关 → null(字节回退)', () => {
  assert.strictEqual(
    mod.buildEmptyOutputNote("powershell -Command \"Get-ChildItem 'D:\\x'\"", { KHY_SHELL_EMPTY_OUTPUT_NOTE: '0' }),
    null,
  );
});

test('buildEmptyOutputNote:过滤器末段优先于列举(dir | grep 走过滤器分支)', () => {
  // 末段是过滤器 grep,即便前段是 dir,也应走过滤器说明(末段决定退出码/输出)
  const note = mod.buildEmptyOutputNote('dir C:\\ | grep foo', {});
  assert.ok(note);
  assert.ok(/过滤器/.test(note), '末段过滤器应优先: ');
});
