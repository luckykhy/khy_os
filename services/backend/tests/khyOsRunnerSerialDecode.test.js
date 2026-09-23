'use strict';

/**
 * khyOsRunnerSerialDecode.test.js — `KhyOsRunner._buffer` 的分块解码守卫(BUG-52)。
 *
 * BUG-49 修的是 TUI 覆盖层；同一类「每块各自 toString('utf-8')」还留在 runner 里，
 * 而 `_buffer` 是 `runCommand()` 的返回值来源 —— 即 `khy khyos run "cat /说明.txt"`
 * 这类**非交互**路径上用户看到的文字。TCP 把三字节汉字劈在两块之间时长出 U+FFFD。
 *
 * 不启 QEMU：真 TCP 服务 + 真 `_connectOnce()`。
 * 关键前提：逐块之间必须 await 一拍并 `setNoDelay`，否则同 tick 的多次 write 会被
 * TCP 合并成一段，宿主只收到一个块 —— 缺陷就不出现（探针曾因此假阴性）。
 *
 * 走的是 app 真实加载路径 `@khy/shared/runtime/khyos`（dev checkout 下它是
 * `services/backend/vendor/shared` 的快照，见 BUG-53）。
 */

const net = require('net');

const { KhyOsRunner } = require('@khy/shared/runtime/khyos');

const B = (s) => Buffer.from(s, 'utf-8');
const REPL = String.fromCharCode(0xfffd);
const ROCKET = String.fromCodePoint(0x1f680);
const CN = '内核已启动：中文输出正常 OK\n';
const EMO = `启动 ${ROCKET} 完成`;

function split(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

function loneSurrogates(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const nx = s.charCodeAt(i + 1);
      if (!(nx >= 0xdc00 && nx <= 0xdfff)) n += 1;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) n += 1;
  }
  return n;
}

/** 挂真服务、真连接、按块投递，等字节收齐后返回 `_buffer`。 */
async function feed(chunks, prepare) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    (async () => {
      for (const c of chunks) {
        sock.write(c);
        await new Promise((r) => setTimeout(r, 3));
      }
    })().catch(() => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const runner = new KhyOsRunner({ isoPath: 'unused.iso' });
  runner.port = server.address().port;
  let seen = 0;
  runner.on('data', (b) => {
    seen += b.length;
  });
  if (prepare) prepare(runner);
  runner.socket = await runner._connectOnce();
  const deadline = Date.now() + 4000;
  while (seen < total && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const text = runner._buffer;
  runner.socket.destroy();
  server.close();
  return { text, seen, total };
}

afterAll(() => {
  jest.restoreAllMocks();
});

describe('KhyOsRunner 串口累加器的解码(BUG-52)', () => {
  test('宿主确实收到多个块（否则这条测试什么都没测到）', async () => {
    const r = await feed(split(B(CN), 1));
    expect(r.total).toBe(40);
    expect(r.seen).toBe(40);
  });

  test('中文逐字节投递：_buffer 必须是原句', async () => {
    const r = await feed(split(B(CN), 1));
    expect(r.text).toBe(CN);
    expect(r.text.split(REPL).length - 1).toBe(0);
  });

  test('4 字节块同样完整（块宽与 3 字节序列不整除）', async () => {
    const r = await feed(split(B(CN), 4));
    expect(r.text).toBe(CN);
  });

  test('代理对跨块：不得留下孤立代理', async () => {
    const r = await feed([B(EMO).subarray(0, 10), B(EMO).subarray(10)]);
    expect(loneSurrogates(r.text)).toBe(0);
    expect(r.text).toBe(EMO);
  });

  test('emoji 逐 2 字节投递仍完整', async () => {
    const r = await feed(split(B(EMO), 2));
    expect(r.text).toBe(EMO);
    expect(r.text.split(REPL).length - 1).toBe(0);
  });

  test('负对照：纯 ASCII 任意切法与整块投递逐字节相同', async () => {
    const buf = B('boot ok 123\nkhy> ');
    const whole = (await feed([buf])).text;
    expect(whole).toBe('boot ok 123\nkhy> ');
    for (const size of [1, 3, 7]) {
      expect((await feed(split(buf, size))).text).toBe(whole);
    }
  });

  test('1 MiB 上限裁剪正好切在代理对中间时，开头不得留孤立代理', async () => {
    // 裁剪条件是 `_buffer.length > 1<<20`，保留末尾 1<<19 个码元 ⇒ 切点恒在
    // 「距文本末尾 1<<19」处。把一个前导低代理种在那个位置上（等价于上一轮
    // 裁剪遗留的半截字符），守卫必须把它丢掉。
    const LIMIT = 1 << 20;
    const KEEP = 1 << 19;
    const chunkStr = 'ab\n'; // k = 3 码元
    const lowSurrogate = String.fromCharCode(0xdc00);
    // pre.length = LIMIT+5 ⇒ 追加 k 码元后切点 = (LIMIT+5+k) - KEEP = KEEP + 8
    const cutAt = KEEP + 8;
    const pre = 'x'.repeat(cutAt) + lowSurrogate + 'y'.repeat(LIMIT + 5 - cutAt - 1);
    const r = await feed([B(chunkStr)], (runner) => {
      runner._buffer = pre;
    });
    expect(r.text.charCodeAt(0)).not.toBe(0xdc00);
    expect(loneSurrogates(r.text)).toBe(0);
    expect(r.text.length).toBe(KEEP - 1);
    expect(r.text.endsWith('ab\n')).toBe(true);
  });
});
