'use strict';
/**
 * scrollbackPreserve 测试 �?stdout 写入规范化器(第二/�?四层)�? *
 * 契约要点(第四层为本文件新�?:
 *  1. fullscreen �?`clear + static + output`)�?static 与快照逐字节一致时剥掉冗余重发;
 *  2. 已验证帧的活动区 output 尾切�?rows-1 �?*视觉�?*(CJK/软换行感�?,保证 ED0 就地擦除�? *     重印不滚�?—�?否则帧头/尾行逐帧滚进 scrollback 堆叠成串副本(用户报「对话中重复渲染多次�?;
 *  3. 未经字节级校验的�?快照不一�?不可�?绝不剥也绝不�?fail-soft,宁漏勿错);
 *  4. rows/columns 不可�?�?只剥不切;门控�?�?逐字节直�?Buffer 原样进出;
 *  5. �?write 拆开的帧(framing 路径)字节保全,flush() 兜底归还�? */
const sp = require('./scrollbackPreserve');
const ESC = '\x1b';
const CLEAR = ESC + '[2J' + ESC + '[3J' + ESC + '[H'; // modern ink clearTerminal
const CLEAR_FIXED = ESC + '[H' + ESC + '[J'; // win32 normalized in-place erase
// CJK/宽字符显示宽�?�?formatters.displayWidth 同口径的最小替�?�?function fakeWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}
function makeNormalizer(snapshot, geo) {
  return sp.createClearTerminalNormalizer({}, 'win32', {
    getStaticSnapshot: () => snapshot,
    ...(geo || {}),
  });
}
function fullscreenFrame(staticText, output) {
  return CLEAR + staticText + output;
}

describe('Scrollback Preserve', () => {
  test('第四�? 超视�?output 被尾切到 rows-1 个视觉行,clear 改写为就地擦�?, () => {
      const snapshot = 'S1\nS2\n';
      const output = Array.from({ length: 40 }, (_, i) => 'L' + i).join('\n');
      const norm = makeNormalizer(snapshot, {
        getRows: () => 10,
        getColumns: () => 80,
        measureWidth: fakeWidth,
      });
      const out = norm.write(fullscreenFrame(snapshot, output));
      expect(out.startsWith(CLEAR_FIXED).toBe();
      expect(!out.includes(ESC + '[2J') && !out.includes(ESC + '[3J').toBe();
      const kept = out.slice(CLEAR_FIXED.length).split('\n');
      expect(kept.length).toBe(9, '应保�?rows-1 = 9 �?);
      expect(kept[kept.length - 1]).toBe('L39', '底部锚定:保留末行');
      expect(kept[0]).toBe('L31', '头部行被舍弃');
  });

  test('第四�? CJK 宽行的软换行计入视觉行预�?, () => {
      const snapshot = '';
      // 每条 100 列显示宽(CJK 50 �?的行,列宽 80 �?每行�?2 视觉行�?      const line = '�?.repeat(50);
      const output = Array.from({ length: 10 }, (_, i) => line + i).join('\n');
      const norm = makeNormalizer(snapshot, {
        getRows: () => 11,
        getColumns: () => 80,
        measureWidth: fakeWidth,
      });
      const out = norm.write(fullscreenFrame(snapshot, output));
      const kept = out.slice(CLEAR_FIXED.length).split('\n');
      // 预算 rows-1 = 10 视觉�?每行 2 视觉�?�?保留 5 条原始行�?      expect(kept.length).toBe(5);
      expect(kept[kept.length - 1]).toBe(line + '9');
  });

  test('第四�? output 在预算内 �?只剥 static,不改�?output 字节', () => {
      const snapshot = 'S\n';
      const output = 'a\nb\nc';
      const norm = makeNormalizer(snapshot, {
        getRows: () => 36,
        getColumns: () => 80,
        measureWidth: fakeWidth,
      });
      const out = norm.write(fullscreenFrame(snapshot, output));
      expect(out).toBe(CLEAR_FIXED + output);
  });

  test('第三层契约不受影�? static 与快照不一�?�?不剥不切(仅清屏形式改写仍生效)', () => {
      const output = Array.from({ length: 100 }, (_, i) => 'L' + i).join('\n');
      const norm = makeNormalizer('MISMATCH', {
        getRows: () => 10,
        getColumns: () => 80,
        measureWidth: fakeWidth,
      });
      const frame = CLEAR + 'OTHER-STATIC\n' + output;
      // 清屏形式改写(第二�?对任何含清屏头的帧生�?�?static 保留、output 不尾切�?      expect(norm.write(frame).toBe(CLEAR_FIXED + 'OTHER-STATIC\n' + output);
  });

  test('第三层契�? 快照不可�?null) �?不剥不切(仅清屏形式改写仍生效)', () => {
      const norm = makeNormalizer(null, { getRows: () => 10 });
      const frame = CLEAR + 'S\n' + 'x\ny';
      expect(norm.write(frame).toBe(CLEAR_FIXED + 'S\n' + 'x\ny');
  });

  test('第四层门�?KHY_FULLSCREEN_TAILCUT=0 �?只剥 static 不切', () => {
      const snapshot = 'S\n';
      const output = Array.from({ length: 40 }, (_, i) => 'L' + i).join('\n');
      const norm = sp.createClearTerminalNormalizer(
        { KHY_FULLSCREEN_TAILCUT: '0' },
        'win32',
        { getStaticSnapshot: () => snapshot, getRows: () => 10, measureWidth: fakeWidth }
      );
      const out = norm.write(fullscreenFrame(snapshot, output));
      expect(out).toBe(CLEAR_FIXED + output);
  });

  test('fail-soft: getRows 缺失�?�? �?只剥 static 不切', () => {
      const snapshot = 'S\n';
      const output = Array.from({ length: 40 }, (_, i) => 'L' + i).join('\n');
      const noGeo = makeNormalizer(snapshot, {});
      expect(noGeo.write(fullscreenFrame(snapshot).toBe(output)), CLEAR_FIXED + output);
      const badRows = makeNormalizer(snapshot, { getRows: () => 1 });
      expect(badRows.write(fullscreenFrame(snapshot).toBe(output)), CLEAR_FIXED + output);
      const throwing = sp.createClearTerminalNormalizer({}, 'win32', {
        getStaticSnapshot: () => snapshot,
        getRows: () => {
          throw new Error('tty gone');
        },
      });
      expect(throwing.write(fullscreenFrame(snapshot).toBe(output)), CLEAR_FIXED + output);
  });

  test('_tailcutOutputToRows 纯函�? 预算内返回原引用;单行超预算饱和保留末�?末尾 \\n 保留', () => {
      const text = 'a\nb\nc';
      expect(sp._tailcutOutputToRows(text)).toBe(10);
      // 单行 200 列、列�?80 �?3 视觉�?maxRows=2 放不�?�?饱和保留末行整行�?      const wide = 'x'.repeat(200);
      assert.strictEqual(
        sp._tailcutOutputToRows('a\n' + wide, 2, fakeWidth, 80),
        wide,
        '单行超预�?�?保留末行'
      );
      // 末尾 \n 状态保留�?      expect(sp._tailcutOutputToRows('a\nb\n')).toBe(1, fakeWidth, 80);
      // 异常/垃圾入参 �?原样返回�?      expect(sp._tailcutOutputToRows(null)).toBe(5);
      expect(sp._tailcutOutputToRows('abc')).toBe(NaN);
  });

  test('Buffer 输入仍工�? 返回 Buffer 且内容为归一化字�?, () => {
      const snapshot = 'S\n';
      const norm = makeNormalizer(snapshot, { getRows: () => 36 });
      const out = norm.write(Buffer.from(fullscreenFrame(snapshot, 'a\nb'), 'utf8'));
      expect(Buffer.isBuffer(out).toBeTruthy());
      expect(out.toString('utf8').toBe(CLEAR_FIXED + 'a\nb');
  });

  test('�?write 拆开的帧: 字节保全(暂存到完整再�?flush 兜底)', () => {
      const snapshot = 'STATIC-BODY\n';
      const norm = makeNormalizer(snapshot, { getRows: () => 36 });
      const frame = CLEAR + snapshot + 'live\nrows';
      const first = norm.write(frame.slice(0, 6));
      expect(first).toBe('', '半帧被暂�?);
      const second = norm.write(frame.slice(6));
      expect(second).toBe(CLEAR_FIXED + 'live\nrows', '凑齐后剥 static 输出');
      expect(norm.flush().toBe('');
  });

  test('第二层契�? �?fullscreen 增量帧逐字节直�?仅剥可能混入�?3J)', () => {
      const norm = makeNormalizer('S\n', { getRows: () => 36 });
      const frame = ESC + '[2K' + ESC + '[1A' + ESC + '[2K' + ESC + '[G' + 'hello\nworld';
      expect(norm.write(frame).toBe(frame);
  });

  test('门控 KHY_PRESERVE_SCROLLBACK=0 �?整体逐字节直�?, () => {
      const norm = sp.createClearTerminalNormalizer({ KHY_PRESERVE_SCROLLBACK: '0' }, 'win32', {
        getStaticSnapshot: () => 'S\n',
        getRows: () => 10,
      });
      const frame = CLEAR + 'S\n' + 'output';
      expect(norm.write(frame).toBe(frame);
  });

});

