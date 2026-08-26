'use strict';

/**
 * routerHandlers.handleLogCommand — 行数上限 + 日志目录/文件名契约。
 *
 * 回归 1(--n 行数上限):老代码 `Number.parseInt(options.n || '20', 10)` 只挡了
 * undefined/空串。非数字('abc')、无值(裸 `--n` → true)、0、负数都会漏到
 * `slice(-NaN)` / `slice(-0)`,两者都退化成 `slice(0)` = 整个文件,悄悄冲破
 * 文档里写的 20 行默认值。修复方式:校验解析结果,非正整数一律回落 20。
 *
 * 回归 2(路径与文件名):老代码自己拼 `(KHYQUANT_ROOT || <backend 根>)/logs/error.log`,
 * 而 transport 实际写 `<data home>/logs/active/error-%DATE%.log` —— 目录和文件名双错。
 * 后果是静默说谎:`clear` 一个字节没动却报「日志已清理」,`log` 永远报
 * 「暂无日志文件 — 系统运行正常」。现在只认注入 / `logger.LOG_DIR` 这一个真源,
 * 并按前缀匹配 dated 文件名。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { createRouterHandlers } = require('../../../src/cli/routerHandlers');

function makeHandlers(logDir, sink = {}) {
  const chalkFn = (...a) => a.join(' ');
  for (const k of ['bold', 'dim', 'cyan', 'red', 'green', 'yellow', 'gray', 'white']) chalkFn[k] = chalkFn;
  return createRouterHandlers({
    logDir,
    fmt: () => ({
      printError: (m) => (sink.errors || (sink.errors = [])).push(String(m)),
      printSuccess: (m) => (sink.success || (sink.success = [])).push(String(m)),
      printInfo: (m) => (sink.info || (sink.info = [])).push(String(m)),
      printWarn: (m) => (sink.warn || (sink.warn = [])).push(String(m)),
    }),
    chk: () => chalkFn,
    symResolver: () => ({ resolveSymbol: async () => ({ matched: false }) }),
  });
}

function tmpLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khylog-'));
}

function writeLog(dir, name, totalLines) {
  const body = `${Array.from({ length: totalLines }, (_, i) => `line${i + 1}`).join('\n')}\n`;
  fs.writeFileSync(path.join(dir, name), body);
}

// 跑 handleLogCommand,数出被打印的日志正文行("lineN")条数。
async function countPrintedLines(options, totalLines = 100, name = 'app-2026-08-25.log') {
  const dir = tmpLogDir();
  writeLog(dir, name, totalLines);
  const origLog = console.log;
  let count = 0;
  console.log = (...a) => { if (/(^|\s)line\d+/.test(a.join(' '))) count += 1; };
  try {
    await makeHandlers(dir).handleLogCommand('tail', [], options);
  } finally {
    console.log = origLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return count;
}

test('no --n → default 20 lines', async () => {
  assert.strictEqual(await countPrintedLines({}), 20);
});

test('valid --n is honored exactly', async () => {
  assert.strictEqual(await countPrintedLines({ n: '50' }), 50);
  assert.strictEqual(await countPrintedLines({ n: '20' }), 20);
  assert.strictEqual(await countPrintedLines({ n: '5' }), 5);
});

test('non-numeric --n falls back to 20 (was: whole file via slice(-NaN))', async () => {
  assert.strictEqual(await countPrintedLines({ n: 'abc' }), 20);
});

test('bare --n (options.n === true) falls back to 20 (was: whole file)', async () => {
  assert.strictEqual(await countPrintedLines({ n: true }), 20);
});

test('--n 0 falls back to 20 (was: whole file via slice(-0))', async () => {
  assert.strictEqual(await countPrintedLines({ n: '0' }), 20);
});

test('negative --n falls back to 20 (was: dropped only |n| leading lines)', async () => {
  assert.strictEqual(await countPrintedLines({ n: '-5' }), 20);
});

test('a fewer-than-default log shows all its lines, not padded', async () => {
  assert.strictEqual(await countPrintedLines({}, 8), 8);
});

test('legacy flat combined.log is still readable', async () => {
  assert.strictEqual(await countPrintedLines({ n: '5' }, 40, 'combined.log'), 5);
});

test('tail spans rotated files so a fresh day is not reported empty', async () => {
  const dir = tmpLogDir();
  fs.writeFileSync(path.join(dir, 'app-2026-08-24.log'), 'old1\nold2\nold3\n');
  fs.writeFileSync(path.join(dir, 'app-2026-08-25.log'), 'new1\n');
  const seen = [];
  const origLog = console.log;
  console.log = (...a) => seen.push(a.join(' '));
  try {
    await makeHandlers(dir).handleLogCommand('tail', [], { n: '3' });
  } finally {
    console.log = origLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const body = seen.join('\n');
  // 最新那份只有 1 行,必须回溯上一份补齐,顺序保持旧 → 新。
  assert.ok(body.includes('old2') && body.includes('old3') && body.includes('new1'), body);
  assert.ok(!body.includes('old1'), body);
});

test('archived .gz is neither read nor counted as a log file', async () => {
  const dir = tmpLogDir();
  fs.writeFileSync(path.join(dir, 'error-2026-08-20.log.2.gz'), 'binary-ish');
  const sink = {};
  await makeHandlers(dir, sink).handleLogCommand(undefined, [], {});
  fs.rmSync(dir, { recursive: true, force: true });
  // 找不到明文错误日志时只说找不到,不许断言「系统运行正常」。
  const info = (sink.info || []).join('\n');
  assert.match(info, /暂无错误日志文件/);
  assert.doesNotMatch(info, /系统运行正常/);
});

test('clear truncates dated files in place and reports the real count', async () => {
  const dir = tmpLogDir();
  writeLog(dir, 'error-2026-08-25.log', 10);
  writeLog(dir, 'app-2026-08-25.log', 10);
  writeLog(dir, 'error.log', 10);
  const sink = {};
  await makeHandlers(dir, sink).handleLogCommand('clear', [], {});
  const remaining = fs.readdirSync(dir).sort();
  const sizes = remaining.map((n) => fs.statSync(path.join(dir, n)).size);
  fs.rmSync(dir, { recursive: true, force: true });
  // 截断而非删除:transport 句柄还开着,删文件会让后续日志写进已解链的 inode。
  assert.deepStrictEqual(remaining, ['app-2026-08-25.log', 'error-2026-08-25.log', 'error.log']);
  assert.deepStrictEqual(sizes, [0, 0, 0]);
  assert.match((sink.success || []).join('\n'), /已清空 3\/3 个文件/);
});

test('clear with nothing to clear says so instead of faking success', async () => {
  const dir = tmpLogDir();
  const sink = {};
  await makeHandlers(dir, sink).handleLogCommand('clear', [], {});
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(sink.success, undefined);
  assert.match((sink.info || []).join('\n'), /没有可清空的日志文件/);
});

test('clear points at archives it deliberately left alone', async () => {
  const dir = tmpLogDir();
  const archive = path.join(dir, 'archive');
  fs.mkdirSync(archive);
  writeLog(dir, 'error-2026-08-25.log', 3);
  fs.writeFileSync(path.join(archive, 'error-2026-08-01.log.gz'), 'x');
  fs.writeFileSync(path.join(archive, 'app-2026-08-01.log.gz'), 'x');
  const sink = {};
  await makeHandlers(dir, sink).handleLogCommand('clear', [], {});
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match((sink.info || []).join('\n'), /另有 2 个归档日志/);
});
