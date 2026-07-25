'use strict';

/**
 * toolParamPath 纯叶子单测(node:test)——CC `truncate.ts` 的 truncatePathMiddle
 * 后端逻辑对齐回归。
 *
 * 「不只显示对齐,更要 CC 显示背后的后端逻辑对齐」:工具头行里那条放不下的 file_path,
 * 其截断算法必须就是 CC 那套**中间截断保住文件名**(directory + '…' + filename),
 * 而不是旧的末尾截断(把文件名截没)。守护:
 *   1. CC 分支表逐句:fits → 原样;maxLen<5 → 末尾;filename 过长 → 起首截断;
 *      否则 directory + '…' + filename。
 *   2. 文件名永远保留(本刀的核心:末尾截断会丢文件名)。
 *   3. 门控关 → 调用方不走本叶子(本测试只验叶子算法本身 + enabled 判定)。
 *   4. Windows 反斜杠分隔符同样识别。
 *   5. 绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pathMiddleTruncateEnabled,
  pathWidthAwareEnabled,
  truncatePathMiddle,
  formatToolHeaderPath,
} = require('../src/cli/toolParamPath');
const { displayWidth } = require('../src/cli/formatters');

test('pathMiddleTruncateEnabled: 默认开 / 关', () => {
  assert.equal(pathMiddleTruncateEnabled({}), true);
  assert.equal(pathMiddleTruncateEnabled({ KHY_TOOL_PATH_MIDDLE_TRUNCATE: '' }), true);
  assert.equal(pathMiddleTruncateEnabled({ KHY_TOOL_PATH_MIDDLE_TRUNCATE: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(pathMiddleTruncateEnabled({ KHY_TOOL_PATH_MIDDLE_TRUNCATE: off }), false, off);
  }
});

test('放得下 → 原样返回(无截断)', () => {
  const p = 'src/index.js';
  assert.equal(truncatePathMiddle(p, 60), p);
  assert.equal(truncatePathMiddle('a/b/c', 5), 'a/b/c'); // 恰好 5 == max
});

test('核心:中间截断保住文件名(末尾截断会把它截没)', () => {
  const p = 'services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js';
  const out = truncatePathMiddle(p, 60);
  assert.ok(out.length <= 60, `len=${out.length} 应 <= 60`);
  assert.ok(out.includes('…'), '应含中间省略号');
  // 文件名(最后一段)必须完整保留——这正是 CC truncatePathMiddle 对比末尾截断的价值。
  assert.ok(out.endsWith('/MyComponent.test.js'), `文件名应保留: ${out}`);
  // 目录前缀也保留(开头不被吃掉)。
  assert.ok(out.startsWith('services/backend/'), `目录前缀应保留: ${out}`);
});

test('CC 形态:directory + "…" + filename(含前导分隔符)', () => {
  // filename 含前导 '/'(CC 行为:slice(lastSlash) 含分隔符)。
  const p = 'aaaaaaaaaa/bbbbbbbbbb/cccccccccc/dddddddddd/file.txt'; // 51 chars
  const out = truncatePathMiddle(p, 30);
  assert.ok(out.length <= 30);
  assert.ok(out.endsWith('/file.txt'));
  assert.equal(out.indexOf('…'), out.lastIndexOf('…'), '只有一个省略号');
  // directory 段被截短,'…' 之后紧接 '/file.txt'。
  assert.match(out, /…\/file\.txt$/);
});

test('maxLen < 5 → 退化为末尾截断(CC 边界)', () => {
  assert.equal(truncatePathMiddle('abcdefgh', 4), 'abc…');
  assert.equal(truncatePathMiddle('abcdefgh', 1), '…');
});

test('maxLen <= 0 → 仅省略号(CC 边界)', () => {
  assert.equal(truncatePathMiddle('abcdefgh', 0), '…');
  assert.equal(truncatePathMiddle('abcdefgh', -3), '…');
});

test('文件名本身就超预算 → 从起首截断(CC: truncateStartToWidth)', () => {
  // 无分隔符的超长「文件名」:filenameLen >= max-1 → 起首截断,'…' 在前。
  const p = 'ThisIsAnExtremelyLongSingleFileNameWithoutAnySeparators.tsx';
  const out = truncatePathMiddle(p, 20);
  assert.ok(out.length <= 20);
  assert.ok(out.startsWith('…'), `起首截断: ${out}`);
  assert.ok(out.endsWith('.tsx'), `尾部(最新)应保留: ${out}`);
});

test('Windows 反斜杠路径同样识别最后一段', () => {
  const p = 'C:\\Users\\dev\\project\\src\\components\\widgets\\VeryLongComponentName.tsx';
  const out = truncatePathMiddle(p, 40);
  assert.ok(out.length <= 40);
  assert.ok(out.includes('…'));
  assert.ok(out.endsWith('\\VeryLongComponentName.tsx'), `Windows 文件名应保留: ${out}`);
});

test('无分隔符且放得下 → 原样', () => {
  assert.equal(truncatePathMiddle('README.md', 60), 'README.md');
});

test('绝不抛:畸形 / 非有限输入安全降级', () => {
  assert.equal(truncatePathMiddle('a/b/c.js', NaN), 'a/b/c.js'); // 非有限预算 → 原样
  assert.doesNotThrow(() => truncatePathMiddle(null, 60));
  assert.doesNotThrow(() => truncatePathMiddle(undefined, 60));
  assert.doesNotThrow(() => truncatePathMiddle(12345, 60));
  assert.doesNotThrow(() => truncatePathMiddle('x', undefined));
  assert.doesNotThrow(() => pathMiddleTruncateEnabled(undefined));
});

// ── formatToolHeaderPath:相对化 + 中间截断的统一口径(SSOT)──────────────────
// 收敛 TUI ToolLines 早已内联的两步(相对化到 cwd、超长中间截断保文件名),供经典
// (非 Ink)REPL 的 toolDisplay / displayFormatters 复用。两门控各自独立。
const CWD = '/home/u/proj';
const BOTH_OFF = { KHY_TOOL_RELATIVE_PATH: 'off', KHY_TOOL_PATH_MIDDLE_TRUNCATE: 'off' };
const REL_OFF = { KHY_TOOL_RELATIVE_PATH: 'off' };
const TRUNC_OFF = { KHY_TOOL_PATH_MIDDLE_TRUNCATE: 'off' };

test('formatToolHeaderPath:两门控都关 → 原样返回 raw(逐字节回退)', () => {
  const abs = CWD + '/services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js';
  assert.equal(formatToolHeaderPath(abs, CWD, BOTH_OFF), abs);
  // 短路径同样逐字节。
  assert.equal(formatToolHeaderPath('/etc/hosts', CWD, BOTH_OFF), '/etc/hosts');
});

test('formatToolHeaderPath:仅相对化开 → 相对路径(不截断,与 displayFormatters 既有一致)', () => {
  const abs = CWD + '/services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js';
  const out = formatToolHeaderPath(abs, CWD, TRUNC_OFF);
  assert.equal(out, 'services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js');
  assert.ok(!out.includes('…'), '中间截断关 → 不应有省略号');
});

test('formatToolHeaderPath:两门控都开(默认)→ 相对化 + 中间截断保文件名', () => {
  const abs = CWD + '/services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js';
  const out2 = formatToolHeaderPath(abs, CWD, {}); // 空 env → 两门控默认开
  const out3 = formatToolHeaderPath(abs, CWD, { KHY_TOOL_RELATIVE_PATH: 'on', KHY_TOOL_PATH_MIDDLE_TRUNCATE: 'on' });
  assert.equal(out2, out3); // 空 env 与显式 on 同结果
  assert.ok(out2.length <= 60, `len=${out2.length} 应 <= 60`);
  assert.ok(out2.includes('…'), '超长 → 应中间截断');
  assert.ok(out2.endsWith('/MyComponent.test.js'), `文件名应保留: ${out2}`);
  assert.ok(out2.startsWith('services/'), `相对目录前缀应保留: ${out2}`);
});

test('formatToolHeaderPath:仅中间截断开 → 对原(绝对)路径按预算中间截断', () => {
  const abs = CWD + '/services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js';
  const out = formatToolHeaderPath(abs, CWD, REL_OFF);
  assert.ok(out.length <= 60);
  assert.ok(out.includes('…'));
  assert.ok(out.endsWith('/MyComponent.test.js'), `文件名应保留: ${out}`);
});

test('formatToolHeaderPath:cwd 内短路径 → 相对且不截断', () => {
  assert.equal(formatToolHeaderPath(CWD + '/a.js', CWD, {}), 'a.js');
});

test('formatToolHeaderPath:cwd 外路径保持绝对(toRelativePath 语义)', () => {
  // 结果以 '..' 开头 → 保留绝对(短则不截断)。
  assert.equal(formatToolHeaderPath('/etc/hosts', CWD, {}), '/etc/hosts');
});

test('formatToolHeaderPath:空 / null → 原样空串,绝不抛', () => {
  assert.equal(formatToolHeaderPath('', CWD, {}), '');
  assert.equal(formatToolHeaderPath(null, CWD, {}), '');
  assert.equal(formatToolHeaderPath(undefined, CWD, {}), '');
  assert.doesNotThrow(() => formatToolHeaderPath(12345, CWD, {}));
  assert.doesNotThrow(() => formatToolHeaderPath('/a/b', undefined, undefined));
});

// ── 刀80:显示宽度度量(CJK/宽字符预算,而非 code-unit .length)──────────────────
// 中文 CLI 下,一条含大量汉字的路径列宽 = 2×字符数,却 `.length` 只算 1×;旧 code-unit
// 预算会误判「放得下」而永不截断、撑破工具头行。度量改为 displayWidth 后按列宽正确截断。
// 子门控 KHY_TOOL_PATH_WIDTH 只控度量:关 → code-unit 策略(逐字节回退旧行为)。

test('pathWidthAwareEnabled:默认开 / 关', () => {
  assert.equal(pathWidthAwareEnabled({}), true);
  assert.equal(pathWidthAwareEnabled({ KHY_TOOL_PATH_WIDTH: '' }), true);
  assert.equal(pathWidthAwareEnabled({ KHY_TOOL_PATH_WIDTH: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(pathWidthAwareEnabled({ KHY_TOOL_PATH_WIDTH: off }), false, off);
  }
});

test('纯 ASCII:宽度开 / 关 逐字节一致(displayWidth 快路径 === .length)', () => {
  const p = 'services/backend/src/cli/tui/ink-components/deeply/nested/MyComponent.test.js';
  const on = truncatePathMiddle(p, 60, {});
  const off = truncatePathMiddle(p, 60, { KHY_TOOL_PATH_WIDTH: '0' });
  assert.equal(on, off, 'ASCII 路径宽度两态必须逐字节一致');
  assert.ok(on.endsWith('/MyComponent.test.js'));
});

test('CJK 路径:宽度开 → 按列宽截断保文件名;宽度关 → 旧 .length 误判「放得下」不截', () => {
  // 40+ 汉字:列宽远超 60,但 .length 未超 → 旧 code-unit 预算漏截。
  const p = '服务端/后端/源码/命令行/终端界面/墨水组件/深层嵌套目录结构/我的组件测试文件名很长.test.js';
  const on = truncatePathMiddle(p, 60, {});
  const off = truncatePathMiddle(p, 60, { KHY_TOOL_PATH_WIDTH: '0' });
  // 宽度关:.length 判定放得下 → 原样(暴露旧 bug:列宽撑破却不截)。
  assert.equal(off, p, '宽度关 → code-unit 策略,.length 未超则原样');
  // 宽度开:真按列宽截断,结果显示宽度 <= 60,文件名完整保留。
  assert.notEqual(on, p, '宽度开 → 应按列宽截断');
  assert.ok(displayWidth(on) <= 60, `on 显示宽度=${displayWidth(on)} 应 <= 60`);
  assert.ok(on.includes('…'), '应含中间省略号');
  assert.ok(on.endsWith('/我的组件测试文件名很长.test.js'), `文件名应完整保留: ${on}`);
  assert.ok(on.startsWith('服务端/'), `目录前缀应保留: ${on}`);
});

test('CJK 文件名本身超预算 → 起首截断,尾部(最新)保留,宽度达标', () => {
  const p = '这是一个没有任何分隔符的超长中文文件名占满整条预算并且还要更长一些.tsx';
  const on = truncatePathMiddle(p, 20, {});
  assert.ok(on.startsWith('…'), `起首截断: ${on}`);
  assert.ok(on.endsWith('.tsx'), `尾部应保留: ${on}`);
  assert.ok(displayWidth(on) <= 20, `显示宽度=${displayWidth(on)} 应 <= 20`);
});

test('surrogate pair(emoji)不被腰斩:逐码点推进,无乱码半字符', () => {
  // 目录段含 astral emoji;截断点落在其附近也不得切出孤立代理项。
  const p = 'a/b/c/📁📁📁📁📁📁📁📁📁📁📁📁📁📁📁📁📁📁📁📁/file.txt';
  const on = truncatePathMiddle(p, 24, {});
  assert.ok(on.endsWith('/file.txt'));
  // UTF-8 往返一致 ⇒ 无孤立 surrogate(腰斩会产生非法码元)。
  assert.equal(on, Buffer.from(on, 'utf8').toString('utf8'), '不得出现乱码半字符');
  assert.ok(displayWidth(on) <= 24, `显示宽度=${displayWidth(on)} 应 <= 24`);
});

test('宽度 require 失败/异常安全:输入畸形仍绝不抛(宽度态)', () => {
  assert.doesNotThrow(() => truncatePathMiddle(null, 60, {}));
  assert.doesNotThrow(() => truncatePathMiddle('服务/文件.js', NaN, {}));
  assert.doesNotThrow(() => truncatePathMiddle('服务/文件.js', 30, { KHY_TOOL_PATH_WIDTH: 'off' }));
});
