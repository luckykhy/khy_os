'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-wxqr-'));

const { _printQrArt } = require('../../src/cli/handlers/wx');
const login = require('../../src/services/messaging/ilinkLogin');

/** 用指定终端宽度跑一次打印,收集 stdout。 */
function withWidth(cols, art) {
  const savedDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  const chunks = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  let shown;
  try {
    shown = _printQrArt(art);
  } finally {
    process.stdout.write = realWrite;
    if (savedDesc) Object.defineProperty(process.stdout, 'columns', savedDesc);
    else delete process.stdout.columns;
  }
  return { shown, out: chunks.join('') };
}

async function realArt() {
  return login.renderQrToTerminal(`https://liteapp.weixin.qq.com/q/7GiQu1?q=${'a'.repeat(46)}`);
}

test('宽终端: 打印并居中', async () => {
  const art = await realArt();
  if (!art) return;                                       // qrcode 依赖缺失 → 跳过
  const { cols } = login.measureQrArt(art);
  const { shown, out } = withWidth(cols + 20, art);
  assert.strictEqual(shown, true);
  assert.ok(out.length > 0, '应真的写了东西到 stdout');
  const firstBody = out.split('\n').find((l) => l.trim().length);
  assert.ok(firstBody.startsWith('          '), `应有居中缩进,实际开头:${JSON.stringify(firstBody.slice(0, 12))}`);
});

test('窄终端: 拒绝打印折行的废码,改给提示(这才是关键)', async () => {
  const art = await realArt();
  if (!art) return;
  const { cols } = login.measureQrArt(art);
  const { shown, out } = withWidth(cols - 5, art);
  assert.strictEqual(shown, false, '放不下时绝不能打印 —— 折行后的码看着像码,其实扫不动');
  // 提示本身也走 stdout,所以不能断言「什么都没输出」;要断言的是「没有二维码块字符」。
  assert.ok(!/[▀▄█]/.test(out), `不得输出任何二维码块字符:${JSON.stringify(out.slice(0, 60))}`);
  assert.ok(/放不下|折行/.test(out), '应告诉用户为什么没显示');
  assert.ok(out.includes(String(cols)), '应给出需要的列数,让用户知道要拉多宽');
});

test('刚好放得下: 打印,但不缩进', async () => {
  const art = await realArt();
  if (!art) return;
  const { cols } = login.measureQrArt(art);
  const { shown, out } = withWidth(cols, art);
  assert.strictEqual(shown, true);
  const firstBody = out.split('\n').find((l) => l.trim().length);
  assert.ok(!firstBody.startsWith(' '.repeat(3)), '恰好放下时不该再加缩进撑溢出');
});

test('宽度未知(管道/重定向): 照常打印,不缩进', async () => {
  const art = await realArt();
  if (!art) return;
  const { shown, out } = withWidth(undefined, art);
  assert.strictEqual(shown, true, '重定向到文件时本来也不是给人扫的,不该因此不输出');
  assert.ok(out.length > 0);
});

test('art 为 null / 空: 不打印且不抛', () => {
  assert.strictEqual(withWidth(120, null).shown, false);
  assert.strictEqual(withWidth(120, '').shown, false);
  assert.strictEqual(withWidth(120, '   \n  ').shown, false, '纯空白不算有效字符画');
});

test('默认尺寸能放进 80 列标准终端(留出居中余量)', async () => {
  const art = await realArt();
  if (!art) return;
  const { rows, cols } = login.measureQrArt(art);
  assert.ok(cols <= 80, `默认档必须能进 80 列终端,实际 ${cols} 列`);
  assert.ok(rows <= 24, `默认档不该超过一屏(24 行),实际 ${rows} 行`);
  assert.strictEqual(withWidth(80, art).shown, true, '80 列终端必须打得出来');
});
