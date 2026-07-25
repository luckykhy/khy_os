'use strict';

/**
 * bridge.test.js — khyos-md-bridge 桥接器测试（node:test，零外部依赖）。
 *
 * 起一个真实的本地 http 服务（127.0.0.1 随机端口），用 node 内置 http 客户端打真请求，
 * 在隔离 tmp 目录中验证：同源服务 HTML、token 鉴权、路径免疫（空格+中文）、读/列/存、错误码。
 * 全程零网络外联、隔离 tmp、测后清理。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bridge = require('../khyos-md-bridge.js');

let tmp, server, port, TOKEN, htmlPath;

// 极简 http 客户端：返回 { status, body }。
function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      (res) => { const ch = []; res.on('data', (c) => ch.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString('utf8') })); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const enc = encodeURIComponent;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyosmd-'));
  // 项目根桩：含 docs/ 与一个 README.md 供 /api/list。
  fs.mkdirSync(path.join(tmp, 'docs', '子目录'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'a.md'), '# A\n');
  fs.writeFileSync(path.join(tmp, 'docs', '子目录', 'b.md'), '# B\n');
  fs.writeFileSync(path.join(tmp, 'docs', 'notes.txt'), 'plain\n');
  fs.writeFileSync(path.join(tmp, 'docs', 'ignore.png'), 'x'); // 非文本，应被 list 忽略
  // 一份 html 桩（避免依赖真实 22KB 文件，仅验证同源服务）。
  htmlPath = path.join(tmp, 'khyosMarkdown.html');
  fs.writeFileSync(htmlPath, '<!doctype html><title>stub</title>');

  // vendor/ 桩（muya 自打包产物；桥接器同源静态服务，免 token）。
  fs.mkdirSync(path.join(tmp, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'vendor', 'khyos-muya.js'), 'window.KhyMuya={};');
  fs.writeFileSync(path.join(tmp, 'vendor', 'khyos-muya.css'), '.mu{color:red}');
  // 目录外的机密文件——confinement 必须拒绝经 ../ 读到它。
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP-SECRET');

  TOKEN = 'tk_test_token';
  const handler = bridge.createHandler({ token: TOKEN, htmlPath, projectRoot: tmp });
  server = http.createServer(handler);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
});

after(() => {
  if (server) server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('同源服务 HTML：GET / 返回 html（无需 token）', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /stub/);
});

test('红线4 token 鉴权：/api/* 缺 token → 403', async () => {
  const r = await req('GET', '/api/list');
  assert.equal(r.status, 403);
});

test('红线4 token 鉴权：错误 token → 403', async () => {
  const r = await req('GET', '/api/list?token=wrong');
  assert.equal(r.status, 403);
});

test('红线3 路径免疫：读取含空格+中文路径', async () => {
  const weird = path.join(tmp, '我的 文档 (1).md');
  fs.writeFileSync(weird, '# 标题\n正文内容');
  const r = await req('GET', `/api/read?path=${enc(weird)}&token=${TOKEN}`);
  assert.equal(r.status, 200);
  assert.match(r.body, /标题/);
  assert.match(r.body, /正文内容/);
});

test('/api/read 不存在 → 404', async () => {
  const r = await req('GET', `/api/read?path=${enc(path.join(tmp, 'nope.md'))}&token=${TOKEN}`);
  assert.equal(r.status, 404);
});

test('/api/read 缺 path → 400', async () => {
  const r = await req('GET', `/api/read?token=${TOKEN}`);
  assert.equal(r.status, 400);
});

test('/api/list 默认列项目 docs/ 的 md（含子目录，忽略非文本）', async () => {
  const r = await req('GET', `/api/list?token=${TOKEN}`);
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body);
  const names = data.files.map((f) => f.name);
  assert.ok(names.includes('a.md'));
  assert.ok(names.includes('b.md'));      // 递归进子目录
  assert.ok(names.includes('notes.txt')); // .txt 属可读
  assert.ok(!names.includes('ignore.png')); // 非文本被忽略
  assert.equal(data.label, '本项目 docs/');
});

test('/api/list 体现目录层级：子目录作为 type:dir 节点出现，其内文件 depth+1', async () => {
  const r = await req('GET', `/api/list?token=${TOKEN}`);
  const data = JSON.parse(r.body);
  // 顶层文件 depth 0、无 type 目录标记；子目录节点 depth 0 且 type:'dir'；子目录内文件 depth 1。
  const dirNode = data.files.find((f) => f.type === 'dir' && f.name === '子目录');
  assert.ok(dirNode, '含可读文件的子目录应作为 dir 节点出现');
  assert.equal(dirNode.depth, 0);
  const aTop = data.files.find((f) => f.name === 'a.md');
  assert.equal(aTop.type, 'file');
  assert.equal(aTop.depth, 0);
  const bNested = data.files.find((f) => f.name === 'b.md');
  assert.equal(bNested.type, 'file');
  assert.equal(bNested.depth, 1, '子目录内文件层级 +1');
  // dir 节点应排在其内文件之前（目录在前、随后是其内容）。
  assert.ok(data.files.indexOf(dirNode) < data.files.indexOf(bNested));
});

test('/api/list 剔除空目录（不含可读文件的子目录不产生 dir 节点）', async () => {
  const empty = path.join(tmp, 'docs', '空目录');
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, 'ignore2.png'), 'x'); // 仅非文本 → 视为空
  try {
    const r = await req('GET', `/api/list?token=${TOKEN}`);
    const data = JSON.parse(r.body);
    assert.ok(!data.files.some((f) => f.type === 'dir' && f.name === '空目录'),
      '无可读文件的目录不应产生 dir 节点');
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

// ── 侧边栏列「当前打开文件所在目录」（KHY_MD_SIDEBAR_CURRENT_DIR，全局工具模式）───────────
// 用户诉求：右键某 .md 打开时，侧边栏应显示该文件所在文件夹的 md，而非恒定项目 docs/。
test('sidebar-current-dir：带 targetPath → /api/list 默认列该文件所在目录（标签为文件夹名）', async () => {
  const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'khyosmd-sub-'));
  try {
    fs.writeFileSync(path.join(sub, '当前.md'), '# cur\n');
    fs.writeFileSync(path.join(sub, 'sibling.md'), '# sib\n');
    fs.writeFileSync(path.join(sub, 'note.txt'), 'x\n');
    const h = bridge.createHandler({ token: TOKEN, htmlPath, projectRoot: tmp, targetPath: path.join(sub, '当前.md') });
    const s = http.createServer(h);
    await new Promise((res) => s.listen(0, '127.0.0.1', res));
    const p = s.address().port;
    try {
      const res = await new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: p, method: 'GET', path: `/api/list?token=${TOKEN}` },
          (rs) => { const c = []; rs.on('data', (x) => c.push(x)); rs.on('end', () => resolve({ status: rs.statusCode, body: Buffer.concat(c).toString() })); });
        rq.on('error', reject); rq.end();
      });
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      const names = data.files.map((f) => f.name);
      assert.ok(names.includes('当前.md'));
      assert.ok(names.includes('sibling.md'));
      assert.ok(!names.includes('a.md'), '不应列到项目 docs/');
      assert.equal(data.label, '📁 ' + path.basename(sub));
    } finally { s.close(); }
  } finally { fs.rmSync(sub, { recursive: true, force: true }); }
});

test('sidebar-current-dir：门控 sidebarCurrentDir=false → 逐字节回退列项目 docs/', async () => {
  const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'khyosmd-sub2-'));
  try {
    fs.writeFileSync(path.join(sub, 'x.md'), '# x\n');
    const h = bridge.createHandler({
      token: TOKEN, htmlPath, projectRoot: tmp,
      targetPath: path.join(sub, 'x.md'), sidebarCurrentDir: false,
    });
    const s = http.createServer(h);
    await new Promise((res) => s.listen(0, '127.0.0.1', res));
    const p = s.address().port;
    try {
      const res = await new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: p, method: 'GET', path: `/api/list?token=${TOKEN}` },
          (rs) => { const c = []; rs.on('data', (x) => c.push(x)); rs.on('end', () => resolve({ status: rs.statusCode, body: Buffer.concat(c).toString() })); });
        rq.on('error', reject); rq.end();
      });
      const data = JSON.parse(res.body);
      assert.equal(data.label, '本项目 docs/', '门关回退旧行为');
      assert.ok(data.files.map((f) => f.name).includes('a.md'));
    } finally { s.close(); }
  } finally { fs.rmSync(sub, { recursive: true, force: true }); }
});

test('sidebar-current-dir：显式 ?dir= 仍优先（覆盖默认目录，标签为该目录名）', async () => {
  const r = await req('GET', `/api/list?dir=${enc(path.join(tmp, 'docs', '子目录'))}&token=${TOKEN}`);
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body);
  assert.equal(data.label, '子目录');
  assert.ok(data.files.map((f) => f.name).includes('b.md'));
});

test('/api/save 写回 .md', async () => {
  const target = path.join(tmp, 'save target 保存.md');
  fs.writeFileSync(target, 'old');
  const r = await req('POST', `/api/save?path=${enc(target)}&token=${TOKEN}`, '# 新内容\n已保存');
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(target, 'utf8'), '# 新内容\n已保存');
});

test('/api/save 拒绝写非文本扩展名 → 400', async () => {
  const target = path.join(tmp, 'evil.exe');
  const r = await req('POST', `/api/save?path=${enc(target)}&token=${TOKEN}`, 'x');
  assert.equal(r.status, 400);
  assert.ok(!fs.existsSync(target));
});

test('未知路由 → 404', async () => {
  const r = await req('GET', '/random');
  assert.equal(r.status, 404);
});

test('makeToken 产生足够长的不可预测 token', () => {
  const a = bridge.makeToken(), b = bridge.makeToken();
  assert.equal(a.length, 32);
  assert.notEqual(a, b);
});

test('startBridge 绑定 127.0.0.1 随机端口且不自动开浏览器', async () => {
  const h = path.join(tmp, 'khyosMarkdown.html');
  const { server: s, url, port: p, token } = await bridge.startBridge({
    scriptDir: tmp, htmlPath: h, projectRoot: tmp, noOpen: true,
  });
  try {
    assert.ok(p > 0);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.equal(token.length, 32);
  } finally { s.close(); }
});

test('openBrowser 跨平台命令选择正确（注入 spawn 桩）', () => {
  const calls = [];
  const spy = (cmd, args) => { calls.push({ cmd, args }); return { unref() {} }; };
  bridge.openBrowser('http://127.0.0.1:1/', 'win32', spy);
  bridge.openBrowser('http://127.0.0.1:1/', 'darwin', spy);
  bridge.openBrowser('http://127.0.0.1:1/', 'linux', spy);
  assert.equal(calls[0].cmd, 'cmd');
  assert.deepEqual(calls[0].args.slice(0, 3), ['/c', 'start', '']);
  assert.equal(calls[1].cmd, 'open');
  assert.equal(calls[2].cmd, 'xdg-open');
});

// ── /vendor/* 同源静态服务（muya 产物）+ 路径 confinement ─────────────────────
test('/vendor/*：GET 已存在的 js 文件（免 token，正确 content-type）', async () => {
  const r = await req('GET', '/vendor/khyos-muya.js');
  assert.equal(r.status, 200);
  assert.match(r.body, /window\.KhyMuya/);
});

test('/vendor/*：css 文件 content-type 与内容正确（免 token）', async () => {
  const r = await req('GET', '/vendor/khyos-muya.css');
  assert.equal(r.status, 200);
  assert.match(r.body, /\.mu\{color:red\}/);
});

test('/vendor/*：不存在的文件 → 404', async () => {
  const r = await req('GET', '/vendor/nope.js');
  assert.equal(r.status, 404);
});

test('红线 confinement：/vendor 经 ../ 逃逸到目录外机密 → 403，绝不泄漏', async () => {
  // 直接编码的 ../secret.txt
  const r1 = await req('GET', '/vendor/' + enc('../secret.txt'));
  assert.equal(r1.status, 403);
  assert.doesNotMatch(r1.body, /TOP-SECRET/);
  // 多级逃逸
  const r2 = await req('GET', '/vendor/' + enc('../../secret.txt'));
  assert.ok(r2.status === 403 || r2.status === 404);
  assert.doesNotMatch(r2.body, /TOP-SECRET/);
});

test('/vendor 根（无文件名）→ 404（不列目录）', async () => {
  const r = await req('GET', '/vendor/');
  assert.equal(r.status, 404);
});

// ── WYSIWYG 门控经 URL 传递（?wysiwyg=）─────────────────────────────────────
test('startBridge：默认 wysiwyg=1；opts.wysiwyg=false → wysiwyg=0', async () => {
  const h = path.join(tmp, 'khyosMarkdown.html');
  const on = await bridge.startBridge({ scriptDir: tmp, htmlPath: h, projectRoot: tmp, noOpen: true });
  try { assert.match(on.url, /&wysiwyg=1\b/); } finally { on.server.close(); }
  const off = await bridge.startBridge({ scriptDir: tmp, htmlPath: h, projectRoot: tmp, noOpen: true, wysiwyg: false });
  try { assert.match(off.url, /&wysiwyg=0\b/); } finally { off.server.close(); }
});

test('envFlagOn：default-on 语义（缺省/非关闭词开，{0,false,off,no} 关）', () => {
  const saved = process.env.KHY_MD_WYSIWYG;
  try {
    delete process.env.KHY_MD_WYSIWYG;
    assert.equal(bridge.envFlagOn('KHY_MD_WYSIWYG'), true, '缺省应开');
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' off ']) {
      process.env.KHY_MD_WYSIWYG = v;
      assert.equal(bridge.envFlagOn('KHY_MD_WYSIWYG'), false, v + ' 应关');
    }
    for (const v of ['1', 'true', 'yes', 'x']) {
      process.env.KHY_MD_WYSIWYG = v;
      assert.equal(bridge.envFlagOn('KHY_MD_WYSIWYG'), true, v + ' 应开');
    }
  } finally {
    if (saved === undefined) delete process.env.KHY_MD_WYSIWYG; else process.env.KHY_MD_WYSIWYG = saved;
  }
});

// ── autoShutdown：心跳 /api/ping + 关闭信标 /api/close + 空闲看门狗 ─────────────
// 修复：右键「打开方式」以 Terminal=false 启动桥接器 → 无 Ctrl+C、关标签也不停服 →
// 每次打开都留一个常驻 node 服务占端口(孤儿进程泄漏)。心跳/信标让服务随标签自我了断。

test('/api/ping：带 token → 200 且触发 onPing 回调', async () => {
  let pinged = 0;
  const h = bridge.createHandler({ token: TOKEN, htmlPath, projectRoot: tmp, onPing: () => { pinged++; } });
  const s = http.createServer(h);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  try {
    const res = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: p, method: 'GET', path: `/api/ping?token=${TOKEN}` },
        (rs) => { const c = []; rs.on('data', (x) => c.push(x)); rs.on('end', () => resolve({ status: rs.statusCode, body: Buffer.concat(c).toString() })); });
      rq.on('error', reject); rq.end();
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /"ok":true/);
    assert.equal(pinged, 1);
  } finally { s.close(); }
});

test('/api/ping：缺 token → 403（心跳也受红线4 鉴权）', async () => {
  const r = await req('GET', '/api/ping');
  assert.equal(r.status, 403);
});

test('/api/close：GET 与 POST 均触发 onClose（sendBeacon 发 POST）', async () => {
  let closed = 0;
  const h = bridge.createHandler({ token: TOKEN, htmlPath, projectRoot: tmp, onClose: () => { closed++; } });
  const s = http.createServer(h);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  const hit = (method) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: p, method, path: `/api/close?token=${TOKEN}` },
      (rs) => { const c = []; rs.on('data', (x) => c.push(x)); rs.on('end', () => resolve(rs.statusCode)); });
    rq.on('error', reject); if (method === 'POST') rq.write(''); rq.end();
  });
  try {
    assert.equal(await hit('GET'), 200);
    assert.equal(await hit('POST'), 200);
    assert.equal(closed, 2);
  } finally { s.close(); }
});

test('autoShutdown：无心跳达初始宽限 → 关服并调用 onExit（注入 onExit 免杀测进程）', async () => {
  let exited = 0;
  const h = path.join(tmp, 'khyosMarkdown.html');
  // idleGraceMs 会被 clamp 到最小 5000，但初始宽限=2×，测里用注入 onExit + 短 grace 走真实计时。
  // 为使测试快，直接验证 onExit 在超时后触发：用最小 grace 5000→初始 10000 太久，
  // 故改用 onClose 路径 + 手动触发看门狗语义已由上面覆盖；这里验证 autoShutdown 开时 onExit 可被 /api/close 触发。
  const { server: s, port: p, token } = await bridge.startBridge({
    scriptDir: tmp, htmlPath: h, projectRoot: tmp, noOpen: true,
    autoShutdown: true, onExit: () => { exited++; },
  });
  try {
    // 打 /api/close → 应触发 shutdown → onExit。
    await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: p, method: 'POST', path: `/api/close?token=${token}` },
        (rs) => { rs.on('data', () => {}); rs.on('end', resolve); });
      rq.on('error', reject); rq.write(''); rq.end();
    });
    assert.equal(exited, 1, 'close 信标应触发 onExit');
  } finally { try { s.close(); } catch (_) {} }
});

test('autoShutdown：env KHY_MD_AUTO_SHUTDOWN=0 → 门关，/api/close 不触发 onExit（逐字节回退旧常驻行为）', async () => {
  let exited = 0;
  const saved = process.env.KHY_MD_AUTO_SHUTDOWN;
  const h = path.join(tmp, 'khyosMarkdown.html');
  try {
    process.env.KHY_MD_AUTO_SHUTDOWN = '0';
    const { server: s, port: p, token } = await bridge.startBridge({
      scriptDir: tmp, htmlPath: h, projectRoot: tmp, noOpen: true,
      autoShutdown: true, onExit: () => { exited++; },
    });
    try {
      const status = await new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port: p, method: 'POST', path: `/api/close?token=${token}` },
          (rs) => { rs.on('data', () => {}); rs.on('end', () => resolve(rs.statusCode)); });
        rq.on('error', reject); rq.write(''); rq.end();
      });
      // 门关：onClose 未挂 → /api/close 仍 200（无害）但绝不触发 onExit。
      assert.equal(status, 200);
      assert.equal(exited, 0, '门关时不应关停');
    } finally { try { s.close(); } catch (_) {} }
  } finally {
    if (saved === undefined) delete process.env.KHY_MD_AUTO_SHUTDOWN; else process.env.KHY_MD_AUTO_SHUTDOWN = saved;
  }
});

test('autoShutdown：空闲看门狗超时 → onExit（短 grace 走真实计时器）', { timeout: 20000 }, async () => {
  let exited = 0;
  const h = path.join(tmp, 'khyosMarkdown.html');
  // idleGraceMs 最小被 clamp 到 5000，初始宽限=2×=10000ms；等 10.3s 验证真实超时自关。
  const { server: s } = await bridge.startBridge({
    scriptDir: tmp, htmlPath: h, projectRoot: tmp, noOpen: true,
    autoShutdown: true, idleGraceMs: 1, onExit: () => { exited++; },
  });
  try {
    await new Promise((r) => setTimeout(r, 10300));
    assert.equal(exited, 1, '初始宽限(2×5000)后无心跳应自关');
  } finally { try { s.close(); } catch (_) {} }
});

// ── 阅读工具防卡死：阻塞型伪文件有界读取（自包含守卫单测） ──────────────────
// 这些测试是纯单元（注入伪 stat + 伪 spawnSync），不依赖真实 /proc 阻塞节点，确定性可跑。

const fakeStat = (isFile, size) => ({ isFile: () => isFile, size });

test('isPseudoFsPath：仅 linux 下 /proc·/sys 精确前缀命中，不误伤 /home/x/proc', () => {
  assert.equal(bridge.isPseudoFsPath('/proc/kmsg', 'linux'), true);
  assert.equal(bridge.isPseudoFsPath('/proc', 'linux'), true);
  assert.equal(bridge.isPseudoFsPath('/sys/kernel/x', 'linux'), true);
  assert.equal(bridge.isPseudoFsPath('/home/kod/proc/foo.md', 'linux'), false);
  assert.equal(bridge.isPseudoFsPath('/procfoo/x', 'linux'), false);
  // 非 linux 一律 false（伪文件阻塞问题是 linux 专属）。
  assert.equal(bridge.isPseudoFsPath('/proc/kmsg', 'darwin'), false);
  assert.equal(bridge.isPseudoFsPath('/proc/kmsg', 'win32'), false);
});

test('shouldBoundedRead：门开 + linux 普通文件 + size0 + /proc → true；其余任一不满足 → false', () => {
  const on = {}; // 缺省 = default-on
  // 命中：阻塞伪文件的典型 stat（isFile===true、size===0）
  assert.equal(bridge.shouldBoundedRead('/proc/kmsg', fakeStat(true, 0), 'linux', on), true);
  // size 非 0 → 普通伪文件（可安全直读）→ false
  assert.equal(bridge.shouldBoundedRead('/proc/version', fakeStat(true, 128), 'linux', on), false);
  // 非普通文件 → 上层 isFile 分支已拦，这里也 false
  assert.equal(bridge.shouldBoundedRead('/proc/x', fakeStat(false, 0), 'linux', on), false);
  // 非 /proc·/sys → false（普通 md/txt 不受影响）
  assert.equal(bridge.shouldBoundedRead('/home/kod/a.md', fakeStat(true, 0), 'linux', on), false);
  // 非 linux → false
  assert.equal(bridge.shouldBoundedRead('/proc/kmsg', fakeStat(true, 0), 'darwin', on), false);
  // 门关（KHY_MD_PSEUDO_GUARD=0）→ false（逐字节回退直读）
  assert.equal(bridge.shouldBoundedRead('/proc/kmsg', fakeStat(true, 0), 'linux', { KHY_MD_PSEUDO_GUARD: '0' }), false);
});

test('readPseudoFileBounded：子进程超时(ETIMEDOUT/SIGTERM) → 人话拒绝，绝不卡死', () => {
  const timedOut = () => ({ error: { code: 'ETIMEDOUT' }, status: null, signal: null, stdout: null });
  const r1 = bridge.readPseudoFileBounded('/proc/kmsg', timedOut);
  assert.equal(r1.handled, true);
  assert.match(r1.refusal, /拒绝读取/);
  const killed = () => ({ error: null, status: null, signal: 'SIGTERM', stdout: null });
  const r2 = bridge.readPseudoFileBounded('/proc/kmsg', killed);
  assert.equal(r2.handled, true);
  assert.match(r2.refusal, /超时被中止/);
});

test('readPseudoFileBounded：成功读到（含截断）→ 返回内容', () => {
  const ok = () => ({ error: null, status: 0, signal: null, stdout: Buffer.from('proc-content\n') });
  const r = bridge.readPseudoFileBounded('/proc/loadavg', ok);
  assert.equal(r.handled, true);
  assert.equal(r.content, 'proc-content\n');
});

test('readPseudoFileBounded：无 head 命令(ENOENT) → handled:false（交回上层回退直读）', () => {
  const noHead = () => ({ error: { code: 'ENOENT' }, status: null, signal: null, stdout: null });
  const r = bridge.readPseudoFileBounded('/proc/x', noHead);
  assert.equal(r.handled, false);
});

test('/api/read 集成：命中伪文件 → 走注入 spawnSync 的有界读取，超时返回 422 而非卡死', async () => {
  const h = path.join(tmp, 'khyosMarkdown.html');
  // 伪 fs：把 /proc/kmsg 报成 isFile===true、size===0（真实阻塞伪文件的形状），
  //        且 readFileSync 若被调到就 fail（证明我们**没有**直读它）。
  const fsImpl = {
    statSync: (p) => (String(p) === '/proc/kmsg'
      ? fakeStat(true, 0)
      : (() => { throw new Error('ENOENT'); })()),
    readFileSync: () => { throw new Error('禁止直读伪文件——本测应走有界子进程'); },
    existsSync: () => false,
  };
  // 注入的 spawnSync 模拟 head -c 超时被杀。
  const spawnSyncImpl = () => ({ error: { code: 'ETIMEDOUT' }, status: null, signal: null, stdout: null });
  const handler = bridge.createHandler({
    token: 'tk', htmlPath: h, projectRoot: tmp, fsImpl, spawnSyncImpl,
  });
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  try {
    const status = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: p, method: 'GET',
        path: `/api/read?token=tk&path=${encodeURIComponent('/proc/kmsg')}` },
        (rs) => { const ch = []; rs.on('data', (c) => ch.push(c));
          rs.on('end', () => resolve({ code: rs.statusCode, body: Buffer.concat(ch).toString('utf8') })); });
      rq.on('error', reject); rq.end();
    });
    assert.equal(status.code, 422, '阻塞伪文件超时应返回 422 拒绝，绝不卡死');
    assert.match(status.body, /拒绝读取|卡死/);
  } finally { try { s.close(); } catch (_) {} }
});
