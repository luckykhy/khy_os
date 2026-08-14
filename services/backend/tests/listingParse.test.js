'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseListing } = require('../src/services/listingParse');

// ── 空 / 坏输入:绝不抛,返 unknown/parsed:false ──────────────────────────────────
test('空 / falsy 输入 → {parsed:false}', () => {
  for (const bad of ['', '   ', null, undefined, 0]) {
    const r = parseListing(bad);
    assert.strictEqual(r.parsed, false, JSON.stringify(bad));
    assert.deepStrictEqual(r.entries, []);
    assert.strictEqual(r.format, 'unknown');
  }
});

// ── find / ls -1:每行一个路径 ─────────────────────────────────────────────────
test('find 完整路径:逐行成条目', () => {
  const text = ['src/index.js', 'src/app.js', 'README.md'].join('\n');
  const r = parseListing(text, { command: 'find . -type f' });
  assert.strictEqual(r.parsed, true);
  const paths = r.entries.map((e) => e.path).sort();
  assert.deepStrictEqual(paths, ['README.md', 'src/app.js', 'src/index.js']);
});

// ── ls -R:目录头 + 成员名拼相对路径 ──────────────────────────────────────────
test('ls -R:dir: 头提供上下文,裸名拼成相对路径', () => {
  const text = [
    'src:',
    'index.js',
    'app.js',
    '',
    'src/lib:',
    'util.js',
  ].join('\n');
  const r = parseListing(text, { command: 'ls -R' });
  assert.strictEqual(r.parsed, true);
  const paths = r.entries.map((e) => e.path).sort();
  assert.ok(paths.includes('src/index.js'), paths.join());
  assert.ok(paths.includes('src/lib/util.js'), paths.join());
});

// ── ls -l:大小取第5字段,跳过目录行 ────────────────────────────────────────────
test('ls -l:解析大小,跳过目录(d)行与 total 头', () => {
  const text = [
    'total 48',
    '-rw-r--r-- 1 u g  1024 Jan  1 00:00 README.md',
    'drwxr-xr-x 2 u g  4096 Jan  1 00:00 src',
    '-rw-r--r-- 1 u g   512 Jan  1 00:00 app.js',
  ].join('\n');
  const r = parseListing(text, { command: 'ls -l' });
  assert.strictEqual(r.format, 'ls-l');
  const byName = Object.fromEntries(r.entries.map((e) => [e.path, e.size]));
  assert.strictEqual(byName['README.md'], 1024);
  assert.strictEqual(byName['app.js'], 512);
  assert.ok(!('src' in byName), '目录行应被跳过');
});

// ── du:size×1024 估算字节 ────────────────────────────────────────────────────
test('du:<size>\\t<path>,1K 块 ×1024', () => {
  const text = ['4\ta', '8\tb/c'].join('\n');
  const r = parseListing(text, { command: 'du -a' });
  assert.strictEqual(r.format, 'du');
  const byName = Object.fromEntries(r.entries.map((e) => [e.path, e.size]));
  assert.strictEqual(byName['a'], 4 * 1024);
  assert.strictEqual(byName['b/c'], 8 * 1024);
});

// ── tree:去盒绘前缀取名 ──────────────────────────────────────────────────────
test('tree:剥离 ├──/└── 前缀', () => {
  const text = [
    '.',
    '├── README.md',
    '└── src',
    '    └── index.js',
  ].join('\n');
  const r = parseListing(text, { command: 'tree' });
  assert.strictEqual(r.parsed, true);
  const names = r.entries.map((e) => e.path);
  assert.ok(names.includes('README.md'), names.join());
  assert.ok(names.some((n) => n.endsWith('index.js')), names.join());
});

// ── Windows dir /s:Directory of 头 + 日期时间大小名 ───────────────────────────
test('Windows dir /s:目录头 + 千分位大小 + 名', () => {
  const text = [
    ' Directory of C:\\proj',
    '',
    '01/02/2024  10:00 AM    <DIR>          src',
    '01/02/2024  10:00 AM         1,234,567 big.bin',
    '01/02/2024  10:00 AM               100 README.md',
    '               2 File(s)      1,234,667 bytes',
  ].join('\n');
  const r = parseListing(text, { command: 'dir /s' });
  assert.strictEqual(r.format, 'dir');
  const byName = Object.fromEntries(r.entries.map((e) => [e.path, e.size]));
  assert.strictEqual(byName['C:/proj/big.bin'], 1234567, JSON.stringify(byName));
  assert.strictEqual(byName['C:/proj/README.md'], 100);
});

// ── RTK 紧凑清单方言(rtk find/ls 输出)────────────────────────────────────────
test('RTK 紧凑清单:<N>F <M>D: 头 + <dir>/ names 行', () => {
  const text = [
    '42F 2D:',
    '',
    './ README.md package.json',
    'src/ a.js b.js c.js',
    '',
    'ext: .js(3) .md(1) .json(1)',
  ].join('\n');
  const r = parseListing(text, { command: 'rtk find . -type f' });
  assert.strictEqual(r.parsed, true);
  assert.strictEqual(r.format, 'rtk');
  const paths = r.entries.map((e) => e.path).sort();
  assert.ok(paths.includes('README.md'), paths.join());
  assert.ok(paths.includes('package.json'), paths.join());
  assert.ok(paths.includes('src/a.js'), paths.join());
  assert.ok(paths.includes('src/c.js'), paths.join());
  assert.ok(!paths.some((p) => p.startsWith('ext')), 'ext 汇总行不成条目');
});

test('RTK 头缺失 → 不误判为 rtk(回退普通解析)', () => {
  const text = ['src/index.js', 'src/app.js'].join('\n');
  const r = parseListing(text, { command: 'find .' });
  assert.notStrictEqual(r.format, 'rtk');
});

// ── 去重:同 path+size 只留一条 ───────────────────────────────────────────────
test('重复条目去重', () => {
  const text = ['./a.js', './a.js', './b.js'].join('\n');
  const r = parseListing(text, { command: 'find .' });
  assert.strictEqual(r.entries.length, 2);
});

// ── PowerShell Get-ChildItem -Recurse:组头 + 表格,取文件行 Length+Name ──────────
test('Get-ChildItem -Recurse:文件行取 Length/Name,目录行跳过,format=ps-gci', () => {
  const text = [
    '',
    '    Directory: D:\\downloads',
    '',
    'Mode                 LastWriteTime         Length Name',
    '----                 -------------         ------ ----',
    'd-----         2024/01/15     10:30                subfolder',
    '-a----         2024/03/20     14:22       10485760 bigfile.zip',
    '-a----         2024/03/21     09:05           2048 notes.txt',
  ].join('\n');
  const r = parseListing(text, { command: 'powershell Get-ChildItem -Recurse' });
  assert.strictEqual(r.parsed, true);
  assert.strictEqual(r.format, 'ps-gci');
  const byName = Object.fromEntries(r.entries.map((e) => [e.path, e.size]));
  assert.strictEqual(byName['D:/downloads/bigfile.zip'], 10485760);
  assert.strictEqual(byName['D:/downloads/notes.txt'], 2048);
  // 目录行不成条目
  assert.ok(!Object.keys(byName).some((p) => p.endsWith('subfolder')), 'subfolder 目录行应跳过');
});

test('Get-ChildItem:无关文本仍 parsed:false 不误判', () => {
  const text = 'this is just some prose\nwith no listing structure at all';
  const r = parseListing(text, { command: 'echo hi' });
  // 兜底 _looksLikePath 可能把行当路径,但不应误判成 ps-gci
  assert.notStrictEqual(r.format, 'ps-gci');
});
