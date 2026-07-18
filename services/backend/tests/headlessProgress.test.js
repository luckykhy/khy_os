'use strict';

/**
 * headlessProgress.test.js — headless `khy -p` 人类友好进度反馈叶子的契约。
 *
 * 背景:headless 经 runToolUseLoop 真执行工具后人类全程零反馈(text 沉默·stream-json 无中间
 * 事件)。本叶子只产显示字符串,由 bin/khy.js 在原生循环 onToolCall/onToolResult 回调里写
 * stderr(stdout 机器契约不动)。门控 KHY_HEADLESS_PROGRESS(default-on·CANON·
 * parent=KHY_HEADLESS_NATIVE_LOOP)。
 */

const hp = require('../src/cli/headlessProgress');

describe('headlessProgress 门控解析(KHY_HEADLESS_PROGRESS)', () => {
  test('default-on:未设 → 启用', () => {
    expect(hp.isHeadlessProgressEnabled({})).toBe(true);
  });
  test('gate-off:KHY_HEADLESS_PROGRESS=0 → 关', () => {
    expect(hp.isHeadlessProgressEnabled({ KHY_HEADLESS_PROGRESS: '0' })).toBe(false);
    expect(hp.isHeadlessProgressEnabled({ KHY_HEADLESS_PROGRESS: 'off' })).toBe(false);
  });
  test('parent-off:KHY_HEADLESS_NATIVE_LOOP=0 → 本门必关(parent 链)', () => {
    expect(hp.isHeadlessProgressEnabled({ KHY_HEADLESS_NATIVE_LOOP: '0' })).toBe(false);
  });
});

describe('shouldEmitProgress(env, isTTY)', () => {
  test('门开 + auto + 非 TTY → 不发(重定向到文件不污染)', () => {
    expect(hp.shouldEmitProgress({}, false)).toBe(false);
  });
  test('门开 + auto + TTY → 发(对齐 CC `-p`)', () => {
    expect(hp.shouldEmitProgress({}, true)).toBe(true);
  });
  test('门开 + 显式强开(1|true|on|yes|force)+ 非 TTY → 发(测试/CI)', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'force', 'FORCE', 'On']) {
      expect(hp.shouldEmitProgress({ KHY_HEADLESS_PROGRESS: v }, false)).toBe(true);
    }
  });
  test('门关 → 永不发(即便 TTY / force)', () => {
    // 注:'0' 既关门也非 force;确保门关短路优先。
    expect(hp.shouldEmitProgress({ KHY_HEADLESS_PROGRESS: '0' }, true)).toBe(false);
    expect(hp.shouldEmitProgress({ KHY_HEADLESS_NATIVE_LOOP: '0' }, true)).toBe(false);
  });
});

describe('formatToolStart(name, params)', () => {
  test('对象参数:图标 + 显示名 + 显著参数(path)', () => {
    const line = hp.formatToolStart('readFile', { path: 'package.json' });
    expect(line).toContain('package.json');
    // 显示名经 renderTheme 映射(readFile→读取/Read),至少非空且不含换行
    expect(line).not.toContain('\n');
    expect(line.length).toBeGreaterThan(0);
  });
  test('字符串参数:截断到上限', () => {
    const long = 'ls -la ' + 'x'.repeat(100);
    const line = hp.formatToolStart('shellCommand', long);
    expect(line).toContain('…');
    expect(line).not.toContain('\n');
  });
  test('无显著参数 → 只有图标 + 显示名(不崩)', () => {
    const line = hp.formatToolStart('todoWrite', {});
    expect(typeof line).toBe('string');
    expect(line.length).toBeGreaterThan(0);
  });
  test('fail-soft:name 缺失/参数异常不抛', () => {
    expect(() => hp.formatToolStart(undefined, undefined)).not.toThrow();
    expect(() => hp.formatToolStart('x', { path: {} })).not.toThrow();
  });
});

describe('formatToolResult(name, result, elapsedMs)', () => {
  test('成功:完成标记 + 耗时', () => {
    const line = hp.formatToolResult('readFile', { ok: true }, 1234);
    expect(line).toContain('完成');
    expect(line).toContain('1.2s');
    expect(line.startsWith('  ')).toBe(true); // 缩进
  });
  test('失败(error 字段)→ 失败标记 + 错误摘要', () => {
    const line = hp.formatToolResult('shellCommand', { error: 'boom failed' }, 250);
    expect(line).toContain('失败');
    expect(line).toContain('250ms');
    expect(line).toContain('boom failed');
  });
  test('失败(isError 字段)也识别', () => {
    const line = hp.formatToolResult('x', { isError: true }, 10);
    expect(line).toContain('失败');
  });
  test('无耗时 → 不附耗时段(不崩)', () => {
    const line = hp.formatToolResult('x', { ok: true }, undefined);
    expect(line).toContain('完成');
    expect(line).not.toContain('undefined');
  });
  test('fail-soft:result 异常不抛', () => {
    expect(() => hp.formatToolResult('x', null, 0)).not.toThrow();
    expect(() => hp.formatToolResult(undefined, undefined, undefined)).not.toThrow();
  });
});

describe('_formatMs(ms)', () => {
  test('<1s → ms', () => { expect(hp._formatMs(500)).toBe('500ms'); });
  test('秒 → 1 位小数去尾 .0', () => {
    expect(hp._formatMs(1500)).toBe('1.5s');
    expect(hp._formatMs(2000)).toBe('2s');
  });
  test('>=60s → 分秒', () => {
    expect(hp._formatMs(65000)).toBe('1m 5s');
    expect(hp._formatMs(120000)).toBe('2m');
  });
  test('回归:60 秒边界进位不产生越界时钟串(不出现 "Nm 60s" / "60s")', () => {
    // 旧代码 floor(sec/60) 与 round(sec%60) 各自取整,余数可进位到 60。
    expect(hp._formatMs(119500)).toBe('2m');   // 曾 "1m 60s"
    expect(hp._formatMs(119600)).toBe('2m');
    expect(hp._formatMs(3599500)).toBe('60m'); // 曾 "59m 60s"
    // 秒分支 toFixed(1) 也会把 59.96 进位成 "60.0"→"60s"。
    expect(hp._formatMs(59960)).toBe('1m');    // 曾 "60s"
    // 边界下方仍如实显示 1 位小数,不进位。
    expect(hp._formatMs(59940)).toBe('59.9s');
    expect(hp._formatMs(59500)).toBe('59.5s');
  });
  test('非法输入 → 空串', () => {
    expect(hp._formatMs(NaN)).toBe('');
    expect(hp._formatMs(-5)).toBe('');
    expect(hp._formatMs('x')).toBe('');
  });
});

describe('_salientArg(params)', () => {
  test('按 _PARAM_KEYS 顺序择字段(path 优先于 name)', () => {
    expect(hp._salientArg({ name: 'n', path: 'p.js' })).toBe('p.js');
  });
  test('字符串直接用', () => {
    expect(hp._salientArg('  hello   world ')).toBe('hello world');
  });
  test('无可展示项 → 空串', () => {
    expect(hp._salientArg({})).toBe('');
    expect(hp._salientArg(null)).toBe('');
    expect(hp._salientArg(42)).toBe('');
  });
  test('截断到上限 + 省略号', () => {
    const s = hp._salientArg({ path: 'a'.repeat(100) });
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(57);
  });
});

// ── 结果内容摘要(KHY_HEADLESS_PROGRESS_DETAIL·default-on·parent=KHY_HEADLESS_PROGRESS)──
describe('isDetailEnabled(env)', () => {
  test('default-on:未设 → 启用', () => {
    expect(hp.isDetailEnabled({})).toBe(true);
  });
  test('gate-off:0|false|off|no → 关(逐字节回退)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(hp.isDetailEnabled({ KHY_HEADLESS_PROGRESS_DETAIL: v })).toBe(false);
    }
  });
  test('parent-off:KHY_HEADLESS_PROGRESS=0 → 子门必关(parent 链)', () => {
    expect(hp.isDetailEnabled({ KHY_HEADLESS_PROGRESS: '0' })).toBe(false);
  });
});

describe('_basename(p)', () => {
  test('posix / win 皆取末段', () => {
    expect(hp._basename('/a/b/c.js')).toBe('c.js');
    expect(hp._basename('C:\\x\\y.txt')).toBe('y.txt');
  });
  test('无分隔符 → 原样;非串 → 空', () => {
    expect(hp._basename('solo')).toBe('solo');
    expect(hp._basename(null)).toBe('');
    expect(hp._basename(42)).toBe('');
  });
});

describe('_diffLineCounts(before, after) 多重集行差', () => {
  test('就地改一行 → +1 −1', () => {
    expect(hp._diffLineCounts('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 });
  });
  test('纯追加 → 只 added', () => {
    expect(hp._diffLineCounts('a\nb', 'a\nb\nc\nd')).toEqual({ added: 2, removed: 0 });
  });
  test('纯删除 → 只 removed', () => {
    expect(hp._diffLineCounts('a\nb\nc', 'a')).toEqual({ added: 0, removed: 2 });
  });
  test('非串输入 → fail-soft 零', () => {
    expect(hp._diffLineCounts(null, undefined)).toEqual({ added: 0, removed: 0 });
  });
});

describe('_summarizeResultContent(name, result, params) 各工具家族', () => {
  test('读取:读取 N 行(截断加注)', () => {
    expect(hp._summarizeResultContent('Read', { lines: 42 }, {})).toBe('读取 42 行');
    expect(hp._summarizeResultContent('read_file', { lines: 10, truncated: true }, {})).toBe('读取 10 行(截断)');
    expect(hp._summarizeResultContent('read', {}, {})).toBe(''); // 无 lines 字段
  });
  test('编辑:真 diff 优先 (+a −b);否则回退 message', () => {
    const wd = { _khyWriteDiff: { filePath: '/p/foo.js', beforeContent: 'a\nb\nc', afterContent: 'a\nX\nc\nd' } };
    expect(hp._summarizeResultContent('Edit', wd, {})).toBe('更新 foo.js (+2 −1)');
    expect(hp._summarizeResultContent('edit', { message: 'Replaced 3 occurrences' }, { file_path: '/p/z.js' }))
      .toBe('Replaced 3 occurrences');
  });
  test('写入:按 after 行数计', () => {
    const wd = { _khyWriteDiff: { filePath: '/p/new.txt', beforeContent: '', afterContent: 'l1\nl2\nl3' } };
    expect(hp._summarizeResultContent('Write', wd, {})).toBe('写入 new.txt(3 行)');
    expect(hp._summarizeResultContent('write_file', { bytes: 128 }, { path: '/p/b.bin' })).toBe('写入 b.bin(128 字节)');
  });
  test('搜索(grep)/文件(glob):计数', () => {
    expect(hp._summarizeResultContent('grep', { count: 7 }, {})).toBe('7 处匹配');
    expect(hp._summarizeResultContent('glob', { count: 12 }, {})).toBe('12 个文件');
    expect(hp._summarizeResultContent('grep', { matches: [1, 2] }, {})).toBe('2 处匹配');
  });
  test('命令(shell):退出码 + 输出行数', () => {
    expect(hp._summarizeResultContent('shellCommand', { exitCode: 0, output: 'l1\nl2' }, {})).toBe('退出码 0 · 2 行');
    expect(hp._summarizeResultContent('bash', { exitCode: 0, output: '' }, {})).toBe('退出码 0');
  });
  test('未知家族 / 空 result → 空串(fail-soft)', () => {
    expect(hp._summarizeResultContent('todoWrite', { ok: true }, {})).toBe('');
    expect(hp._summarizeResultContent('Read', null, {})).toBe('');
  });
});

describe('formatToolResult 内容摘要接线(第 4/5 参 params/env)', () => {
  const ON = { KHY_HEADLESS_PROGRESS_DETAIL: '1' };
  const OFF = { KHY_HEADLESS_PROGRESS_DETAIL: 'off' };
  test('门开成功 → 追加摘要 clause', () => {
    expect(hp.formatToolResult('Read', { lines: 42 }, 500, {}, ON)).toBe('  ● 完成 500ms · 读取 42 行');
  });
  test('门关成功 → 逐字节回退今日「完成 + 耗时」', () => {
    expect(hp.formatToolResult('Read', { lines: 42 }, 500, {}, OFF)).toBe('  ● 完成 500ms');
  });
  test('失败路径不受明细门影响(仍是失败 + errText)', () => {
    expect(hp.formatToolResult('Read', { isError: true, error: 'boom' }, 500, {}, ON)).toBe('  ● 失败 500ms · boom');
  });
  test('无可摘要项 → 只有基线行(不附空 clause)', () => {
    expect(hp.formatToolResult('Read', { ok: true }, 500, {}, ON)).toBe('  ● 完成 500ms');
  });
  test('向后兼容:3 参旧调用不抛(env 默认 process.env)', () => {
    expect(() => hp.formatToolResult('x', { ok: true }, 100)).not.toThrow();
  });
});

// ── 中间叙述文本(KHY_HEADLESS_PROGRESS_TEXT·default-on·parent=KHY_HEADLESS_PROGRESS)──
describe('isTextEnabled(env)', () => {
  test('default-on:未设 → 启用', () => {
    expect(hp.isTextEnabled({})).toBe(true);
  });
  test('gate-off:0|false|off|no → 关(逐字节回退沉默)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(hp.isTextEnabled({ KHY_HEADLESS_PROGRESS_TEXT: v })).toBe(false);
    }
  });
  test('parent-off:KHY_HEADLESS_PROGRESS=0 → 子门必关(parent 链)', () => {
    expect(hp.isTextEnabled({ KHY_HEADLESS_PROGRESS: '0' })).toBe(false);
  });
});

describe('formatAssistantText(text) 中间叙述格式化', () => {
  test('单行 → 加细竖线前缀', () => {
    expect(hp.formatAssistantText('先读一下这个文件')).toBe('│ 先读一下这个文件');
  });
  test('去外围空白 + 逐行右侧去空白', () => {
    expect(hp.formatAssistantText('  trailing spaces   ')).toBe('│ trailing spaces');
  });
  test('多行各自加前缀', () => {
    expect(hp.formatAssistantText('line1\nline2')).toBe('│ line1\n│ line2');
  });
  test('折叠 3+ 连续空行为 1(空行不加前缀)', () => {
    expect(hp.formatAssistantText('a\n\n\n\nb')).toBe('│ a\n\n│ b');
  });
  test('丢弃首尾空行', () => {
    expect(hp.formatAssistantText('\n\nreal\n\n')).toBe('│ real');
  });
  test('CRLF 归一化为 LF', () => {
    expect(hp.formatAssistantText('x\r\ny')).toBe('│ x\n│ y');
  });
  test('空 / 纯空白 / 非串 → 空串(调用方据此跳过·fail-soft)', () => {
    expect(hp.formatAssistantText('')).toBe('');
    expect(hp.formatAssistantText('   \n  \n ')).toBe('');
    expect(hp.formatAssistantText(null)).toBe('');
    expect(hp.formatAssistantText(42)).toBe('');
  });
  test('极长散文截断(省略号收尾·有界)', () => {
    const out = hp.formatAssistantText('我'.repeat(5000));
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(2 + 4001 + 5);
  });
});

// ── 用户可见中间消息(assistant_message,如视觉路由说明)——气泡图标前缀,区别于 │ 散文 ──
describe('formatAssistantMessage(content) 用户可见中间消息', () => {
  test('单行 → 加气泡图标前缀', () => {
    expect(hp.formatAssistantMessage('我无法直接识别图片内容。正在调用 glm-4.6v-flash 进行识别，请稍候...'))
      .toBe('💬 我无法直接识别图片内容。正在调用 glm-4.6v-flash 进行识别，请稍候...');
  });
  test('多行:首行气泡·续行对齐缩进', () => {
    expect(hp.formatAssistantMessage('line1\nline2')).toBe('💬 line1\n   line2');
  });
  test('折叠 3+ 连续空行为 1', () => {
    expect(hp.formatAssistantMessage('a\n\n\n\nb')).toBe('💬 a\n\n   b');
  });
  test('丢弃首尾空行 + 逐行右侧去空白', () => {
    expect(hp.formatAssistantMessage('\n\n  real  \n\n')).toBe('💬 real');
  });
  test('CRLF 归一化为 LF', () => {
    expect(hp.formatAssistantMessage('x\r\ny')).toBe('💬 x\n   y');
  });
  test('空 / 纯空白 / 非串 → 空串(调用方据此跳过·fail-soft)', () => {
    expect(hp.formatAssistantMessage('')).toBe('');
    expect(hp.formatAssistantMessage('   \n  \n ')).toBe('');
    expect(hp.formatAssistantMessage(null)).toBe('');
    expect(hp.formatAssistantMessage(42)).toBe('');
  });
  test('极长内容截断(省略号收尾·有界)', () => {
    const out = hp.formatAssistantMessage('我'.repeat(5000));
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(3 + 4001 + 5);
  });
});

// ── 长时工具心跳(KHY_HEADLESS_PROGRESS_HEARTBEAT·default-on·parent=KHY_HEADLESS_PROGRESS)──
describe('isHeartbeatEnabled(env)', () => {
  test('default-on:未设 → 启用', () => {
    expect(hp.isHeartbeatEnabled({})).toBe(true);
  });
  test('gate-off:0|false|off|no → 关(逐字节回退 start→静默→result)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(hp.isHeartbeatEnabled({ KHY_HEADLESS_PROGRESS_HEARTBEAT: v })).toBe(false);
    }
  });
  test('parent-off:KHY_HEADLESS_PROGRESS=0 → 子门必关(parent 链)', () => {
    expect(hp.isHeartbeatEnabled({ KHY_HEADLESS_PROGRESS: '0' })).toBe(false);
  });
});

describe('formatToolHeartbeat(name, elapsedMs)', () => {
  test('长时工具 → ⏳ + 显示名 + 运行中 + 耗时(单行·2 空格缩进)', () => {
    const l = hp.formatToolHeartbeat('shellCommand', 7000);
    expect(l.startsWith('  ⏳ ')).toBe(true);
    expect(l).toContain('运行中');
    expect(l).toContain('7s');
    expect(l).not.toContain('\n');
  });
  test('分秒格式', () => {
    expect(hp.formatToolHeartbeat('x', 65000)).toContain('1m 5s');
  });
  test('无效耗时 → 空串(调用方据此跳过)', () => {
    expect(hp.formatToolHeartbeat('x', NaN)).toBe('');
    expect(hp.formatToolHeartbeat('x', -1)).toBe('');
    expect(hp.formatToolHeartbeat('x')).toBe('');
  });
  test('常量:min / interval 皆 5000ms', () => {
    expect(hp.HEARTBEAT_MIN_MS).toBe(5000);
    expect(hp.HEARTBEAT_INTERVAL_MS).toBe(5000);
  });
});

// 心跳发送节律(镜像 bin/khy.js 内联 tick 逻辑:满 min 才首发,此后每 interval 一次;工具结束即停)。
describe('心跳节律(tick 逻辑镜像)', () => {
  function simulate(toolStart, toolEnd, ticks) {
    const state = { active: { name: 'shell', t0: toolStart, lastBeat: 0 } };
    const beats = [];
    for (const now of ticks) {
      if (toolEnd != null && now >= toolEnd) state.active = null; // onToolResult 清 active
      const a = state.active;
      if (!a) continue;
      const elapsed = now - a.t0;
      if (elapsed >= hp.HEARTBEAT_MIN_MS && (now - (a.lastBeat || a.t0)) >= hp.HEARTBEAT_INTERVAL_MS) {
        a.lastBeat = now;
        beats.push(elapsed);
      }
    }
    return beats;
  }
  test('长时工具:每 5s 一拍', () => {
    expect(simulate(0, 22000, [5000, 10000, 15000, 20000])).toEqual([5000, 10000, 15000, 20000]);
  });
  test('短工具(3s 结束):首拍前已清 active → 无幻影心跳', () => {
    expect(simulate(0, 3000, [5000, 10000])).toEqual([]);
  });
  test('工具 12s 结束:只 5s/10s 两拍', () => {
    expect(simulate(0, 12000, [5000, 10000, 15000])).toEqual([5000, 10000]);
  });
});

// ── 原生循环抛错回退诊断(KHY_HEADLESS_LOOP_FALLBACK_DIAG·default-on·parent=KHY_HEADLESS_NATIVE_LOOP)──
describe('isLoopFallbackDiagEnabled(env)', () => {
  test('default-on:未设 → 启用', () => {
    expect(hp.isLoopFallbackDiagEnabled({})).toBe(true);
  });
  test('gate-off:0|false|off|no → 关(逐字节回退静默吞)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      expect(hp.isLoopFallbackDiagEnabled({ KHY_HEADLESS_LOOP_FALLBACK_DIAG: v })).toBe(false);
    }
  });
  test('parent-off:KHY_HEADLESS_NATIVE_LOOP=0 → 子门必关(回退路径根本不进)', () => {
    expect(hp.isLoopFallbackDiagEnabled({ KHY_HEADLESS_NATIVE_LOOP: '0' })).toBe(false);
  });
});

describe('formatLoopFallbackDiag(err)', () => {
  test('带 Error.message → ⚠ 前缀 + 折叠空白的错误摘要', () => {
    expect(hp.formatLoopFallbackDiag(new Error('boom  net   fail')))
      .toBe('  ⚠ 原生工具循环失败,回退单发 · boom net fail');
  });
  test('字符串错误也识别', () => {
    expect(hp.formatLoopFallbackDiag('string err')).toBe('  ⚠ 原生工具循环失败,回退单发 · string err');
  });
  test('无消息 / 空对象 / null → 通用文案(不带 · 摘要)', () => {
    expect(hp.formatLoopFallbackDiag(null)).toBe('  ⚠ 原生工具循环失败,回退单发');
    expect(hp.formatLoopFallbackDiag({})).toBe('  ⚠ 原生工具循环失败,回退单发');
  });
  test('超长消息截断到上限', () => {
    const l = hp.formatLoopFallbackDiag(new Error('x'.repeat(200)));
    expect(l.endsWith('…')).toBe(true);
    expect(l).not.toContain('\n');
  });
});
