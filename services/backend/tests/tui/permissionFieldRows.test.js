'use strict';

/**
 * permissionFieldRows.test.js — 授权框字段「悬挂缩进」纯叶子守卫(BUG-48)。
 *
 * 缺陷本体:`PermissionsPrompt` 里 `资源：<很长的中文路径>` 与 `$ <长命令>` 由 ink 自行折行,
 * 续行回到**内容区最左列** —— 与下一个字段的标签同一列,读起来像多出一个字段。同族前例:
 * BUG-34(转录续行)、BUG-7/11/40/46/47(按码元而非显示列)。
 *
 * 这里锁三条不变量(纯函数,不挂 ink):
 *   1) 每一行显示宽度 ≤ 传入预算(中文一字两列,故断言用 displayWidth 而非 length);
 *   2) 续行左边界 = 标签宽度(缩进),且**去空白后与原文逐字符一致**(不吞字符);
 *   3) 拿不到合法宽度预算时返回 null ⇒ 组件逐字节回退今日单行渲染。
 */

const { fieldRows, MIN_VALUE_COLS } = require('../../src/cli/tui/permissionFieldRows');
const { displayWidth } = require('../../src/cli/formatters');

const CN_LABEL = '资源：'; // 3 字 → 6 列
const CN_PATH =
  'D:/Portable/khy-os/docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md';

describe('permissionFieldRows.fieldRows(BUG-48)', () => {
  test('宽中文路径:多行、每行 ≤ 预算、续行缩进到标签之后', () => {
    const rows = fieldRows({ label: CN_LABEL, value: CN_PATH, width: 76 });
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(76);
    // 首行以标签开头,续行以等宽空格开头 ⇒ 值列左边界一致
    expect(rows[0].startsWith(CN_LABEL)).toBe(true);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].slice(0, 6)).toBe(' '.repeat(6));
      expect(rows[i].slice(6).trim().length).toBeGreaterThan(0);
    }
  });

  test('不吞字符:去空白后与「标签+原文」完全一致', () => {
    const cmd = 'for f in $(find . -name "*.md"); do echo "$f"; done | head -20';
    const rows = fieldRows({ label: '$ ', value: cmd, width: 30 });
    expect(rows.length).toBeGreaterThan(2);
    const joined = rows.map((r) => r.replace(/\s+$/, ''))
      .join('')
      .replace(/\s+/g, '');
    expect(joined).toBe(('$ ' + cmd).replace(/\s+/g, ''));
  });

  test('短值:恰好一行,且与今日单行 Text 的字符串逐字节相同', () => {
    expect(fieldRows({ label: CN_LABEL, value: 'src/index.js', width: 76 })).toEqual([
      `${CN_LABEL}src/index.js`,
    ]);
    expect(fieldRows({ label: '$ ', value: 'ls -la', width: 76 })).toEqual(['$ ls -la']);
  });

  test('显式换行:每个源行独立成段,尾部空行不占帧内一行', () => {
    const rows = fieldRows({ label: CN_LABEL, value: '第一行\n第二行\n', width: 76 });
    expect(rows).toEqual([`${CN_LABEL}第一行`, ' '.repeat(6) + '第二行']);
  });

  test('预算非法时返回 null(组件据此逐字节回退)', () => {
    expect(fieldRows({ label: CN_LABEL, value: CN_PATH, width: 0 })).toBeNull();
    expect(fieldRows({ label: CN_LABEL, value: CN_PATH, width: NaN })).toBeNull();
    expect(fieldRows({ label: CN_LABEL, value: CN_PATH, width: undefined })).toBeNull();
    // 窄到放不下一个可读的值列 ⇒ 不强行拆碎
    expect(fieldRows({ label: CN_LABEL, value: CN_PATH, width: 6 + MIN_VALUE_COLS - 1 })).toBeNull();
    expect(fieldRows()).toBeNull();
  });

  test('预算恰好等于标签+最小值列时仍工作,且行宽不超预算', () => {
    const width = 6 + MIN_VALUE_COLS;
    const rows = fieldRows({ label: CN_LABEL, value: '路径路径路径路径', width });
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(width);
  });
});
