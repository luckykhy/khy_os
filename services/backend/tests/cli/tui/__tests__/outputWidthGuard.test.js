'use strict';
/**
 * outputWidthGuard 测试 �?行宽守卫(TUI 输出 �?输入框宽度契�?�? *
 * 契约要点:
 *  1. 纯文�?+ SGR 的超宽行按显示宽�?CJK=2)折行,续行首重放已开 SGR;
 *  2. 含非 SGR 转义(CUP/EL/OSC�?�?\r 的写入逐字节放�?ink �?进度行不可折);
 *  3. 不超宽的写入逐字节放�?热路径零改动);
 *  4. install 幂等、uninstall 还原、非 TTY / 门控�?�?noop�? */
const guard = require('../runtime/outputWidthGuard');
const ESC = '\x1b';
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
// ASCII 度量(测试里避�?formatters �?CJK 记忆化干�?显式注入)
const asciiW = (s) => strip(s).length;
function fakeStdout(columns) {
  const writes = [];
  const stream = {
    isTTY: true,
    columns,
    write(fnOrChunk) {
      // 记录最终落到真实层的字�?      writes.push(fnOrChunk);
      return true;
    },
  };
  return { stream, writes };
}

describe('Output Width Guard', () => {
  test('wrapAnsiLine: 不超宽的纯文本原样返�?同一引用�?零改�?', () => {
      expect(guard.wrapAnsiLine('hello').toEqual(80), ['hello']);
  });

  test('wrapAnsiLine: 超宽 ASCII 按列折行', () => {
      const lines = guard.wrapAnsiLine('a'.repeat(100), 80, asciiW);
      expect(lines.length).toBe(2);
      expect(lines[0].length).toBe(80);
      expect(lines[0] + lines[1]).toBe('a'.repeat(100);
  });

  test('wrapAnsiLine: CJK 用显示度量时首行占满 cols �?, () => {
      const wide = (s) => strip(s).length * 2; // 每字�?2 �?      const lines = guard.wrapAnsiLine('�?.repeat(60), 80, wide);
      expect(lines[0].length).toBe(40); // 40 �?× 2 = 80 �?      expect(lines.length).toBe(2);
  });

  test('wrapAnsiLine: 折行处闭�?SGR,续行首重�?颜色不串�?', () => {
      const line = `${ESC}[31m` + 'r'.repeat(100) + `${ESC}[0m`;
      const lines = guard.wrapAnsiLine(line, 80, asciiW);
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe(`${ESC}[31m` + 'r'.repeat(80) + `${ESC}[0m`);
      expect(lines[1]).toBe(`${ESC}[31m` + 'r'.repeat(20) + `${ESC}[0m`);
      // 去掉 ANSI 后内容完�?      expect(strip(lines.join('')).toBe('r'.repeat(100));
  });

  test('wrapAnsiLine: SGR reset 清空活跃�?reset 后折行不再重�?, () => {
      const line = `${ESC}[31mred${ESC}[0m` + 'x'.repeat(100);
      const lines = guard.wrapAnsiLine(line, 80, asciiW);
      expect(!lines[1].startsWith(ESC).toBe();
  });

  test('wrapAnsiLine: 折点尾随空白被丢�?续行不以空格开�?, () => {
      const line = 'word '.repeat(30); // 150 �?折点落在空格附近
      const lines = guard.wrapAnsiLine(line, 80, asciiW);
      for (const ln of lines) {
        expect(!ln.startsWith(' ').toBeTruthy());
        expect(asciiW(ln).toBeTruthy() <= 80);
      }
  });

  test('clampChunkToWidth: 多行纯文本逐行�?短行保持字节不变', () => {
      const chunk = 'short\n' + 'x'.repeat(100) + '\nalso short';
      const out = guard.clampChunkToWidth(chunk, 80, asciiW);
      expect(out).toBe('short\n' + 'x'.repeat(80) + '\n' + 'x'.repeat(20) + '\nalso short');
  });

  test('clampChunkToWidth: �?chunk 热路径逐字节返回原�?, () => {
      const chunk = `${ESC}[32mgreen${ESC}[0m`;
      expect(guard.clampChunkToWidth(chunk)).toBe(80, asciiW);
  });

  test('clampChunkToWidth: 含光标控制序�?ink �?进度�?逐字节放�?, () => {
      const frame = `${ESC}[2K${ESC}[G` + 'x'.repeat(200) + `${ESC}[K`;
      expect(guard.clampChunkToWidth(frame)).toBe(80, asciiW);
      const cr = '\r  进度 50%...\x1b[K';
      expect(guard.clampChunkToWidth(cr)).toBe(80, asciiW);
      const osc = `${ESC}]0;title${ESC}\\` + 'x'.repeat(200);
      expect(guard.clampChunkToWidth(osc)).toBe(80, asciiW);
  });

  test('install: 超宽纯文本行被折�?columns �?不超宽字节不�?, () => {
      guard._resetForTests();
      const { stream, writes } = fakeStdout(80);
      const realWrite = stream.write;
      const h = guard.install({ stdout: stream, env: {}, measure: asciiW });
      expect(typeof stream.write).toBe('function');
      expect(stream.write).not.toBe(realWrite);
    
      stream.write('x'.repeat(100) + '\n');
      expect(writes[0]).toBe('x'.repeat(80) + '\n' + 'x'.repeat(20) + '\n');
    
      stream.write('short line\n');
      expect(writes[1]).toBe('short line\n');
    
      h.uninstall();
      expect(stream.write).toBe(realWrite, 'uninstall 还原�?write');
  });

  test('install: �?TTY �?noop;门控�?�?noop;幂等不叠�?, () => {
      guard._resetForTests();
      const pipe = { isTTY: false, columns: 80, write(c) { return c; } };
      const before = pipe.write;
      const h1 = guard.install({ stdout: pipe, env: {}, measure: asciiW });
      expect(pipe.write).toBe(before, '�?TTY 不替�?write');
      h1.uninstall();
      expect(pipe.write).toBe(before);
    
      guard._resetForTests();
      const tty = { isTTY: true, columns: 80, write(c) { return c; } };
      const h2 = guard.install({ stdout: tty, env: { KHY_OUTPUT_WIDTH_GUARD: '0' }, measure: asciiW });
      const before2 = tty.write;
      h2.uninstall();
      expect(tty.write).toBe(before2);
    
      // 幂等:第二�?install 不叠�?还原一次即回到原生)
      guard._resetForTests();
      const tty3 = { isTTY: true, columns: 80, write(c) { return c; } };
      const native = tty3.write;
      const a = guard.install({ stdout: tty3, env: {}, measure: asciiW });
      const b = guard.install({ stdout: tty3, env: {}, measure: asciiW });
      b.uninstall();
      a.uninstall();
      expect(tty3.write).toBe(native);
  });

  test('install: Buffer 输入也能折行;守卫自身异常不阻断输�?, () => {
      guard._resetForTests();
      const { stream, writes } = fakeStdout(80);
      const h = guard.install({ stdout: stream, env: {}, measure: asciiW });
      stream.write(Buffer.from('y'.repeat(100), 'utf8'));
      expect(writes[0]).toContain('y'.repeat(80);
      h.uninstall();
  });

});

