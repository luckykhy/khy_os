#!/usr/bin/env node
'use strict';

/**
 * khyos-md-bridge.js — khyosMarkdown 的「跨平台桥接器」（纯 Node，零依赖）。
 *
 * 为什么需要桥接器（宪法红线2：跨域绝路）：
 *   浏览器对 file:// 页面 fetch 本地文件施加严格的同源/CORS 限制，右键直接用 file:// 打开
 *   khyosMarkdown.html 将无法读取被右键的目标文件。本桥接器以 http://127.0.0.1:<随机端口>
 *   **同源**服务 HTML 与 /api/*，从根上消除 CORS——不是放宽，而是让请求根本不跨域。
 *
 * 职责：
 *   1) 在 127.0.0.1 上起一个极简 HTTP 服务（仅本机可达），分配随机空闲端口。
 *   2) GET  /                 → 同源服务 khyosMarkdown.html。
 *   3) GET  /api/read?path=   → 读取任意（用户右键传入的）文本文件，原样返回 UTF-8。
 *   4) GET  /api/list[?dir=]  → 列出目录下的 .md/.markdown（默认本项目 docs/），供文档树。
 *   5) POST /api/save?path=   → 将编辑内容写回原文件（编辑器保存）。
 *   6) 启动后用系统默认浏览器打开页面，带上 token 与（可选）目标文件路径。
 *
 * 双模启动（红线/双模）：
 *   - 无路径参数：项目内嵌模式，root 默认本仓库根（自定位），/api/list 浏览 docs/。
 *   - 带路径参数：全局工具模式，渲染该绝对路径文件（电脑上任意位置）。
 *
 * 防呆红线：
 *   红线2 同源消除 CORS：HTML 与 API 同源，绝不依赖 file://。
 *   红线3 路径免疫：经 WHATWG URL 的 searchParams 自动解码，完美处理空格/中文/特殊字符。
 *   红线4 系统纯净：仅监听 127.0.0.1（不对外暴露）；不写注册表/系统目录；token 防止其他网页越权调用本机端口。
 *
 * 全部副作用（http/fs/spawn/平台）可经 deps 注入，使 handler 可在 node:test 中纯内存验证。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HTML_NAME = 'khyosMarkdown.html';
const VENDOR_DIR_NAME = 'vendor';
const READABLE_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt', '.text']);

// 静态资产的 content-type（muya 自打包产物：JS/CSS + 内联的字体/图，通常只有 .js/.css/.json，
// 但字体/wasm 兜底保留，避免未来重打包引入外部资源时误判）。
const STATIC_CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
};

/** 生成不可预测的会话 token（防止本机其他网页/进程越权调用 API）。 */
function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * default-on 语义读取环境布尔开关：仅当显式置 0/false/off/no 时为关，其余（含缺省）为开。
 * 与后端 flagRegistry 的 default-on 行为对齐（本零依赖工具无法 require flagRegistry，故就地复刻）。
 */
function envFlagOn(name) {
  const v = String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

// ── 阅读工具防卡死：阻塞型伪文件有界读取（自包含，零依赖） ──────────────────
// 根因：Linux `/proc`、`/sys` 下的阻塞型伪文件（如 `/proc/kmsg`）在 stat 层面是**普通文件**
// （`isFile() === true`、`size === 0`），却在 read 时**永久阻塞**——`readFileSync` 会把本
// 单线程 HTTP 查看器的事件循环彻底锁死（用户诉求：「不要再因为阅读工具不对不支持长时间卡死」）。
// 同步阻塞读在进程内**无法超时**（它锁死事件循环，任何 setTimeout 都不再触发）；唯一可靠办法是
// 把读取外包给一个**可被 timeout 杀掉的子进程**（`head -c` + spawnSync 的 timeout）。
//
// 设计约束：本工具是「纯 Node，零依赖」的顶层独立工具，无法 require 后端 pseudoFileReadGuard，
// 故就地复刻其判定与有界读取（与 services/backend/src/tools/pseudoFileReadGuard.js 行为对齐）。
const PSEUDO_GUARD_FLAG = 'KHY_MD_PSEUDO_GUARD';        // default-on
const PSEUDO_READ_TIMEOUT_MS = 4000;                    // 子进程读取墙钟上限
const PSEUDO_READ_MAX_BYTES = 512 * 1024;              // 伪文件有界读取上限（512KB）

/** 该路径是否落在 Linux `/proc`、`/sys` 伪文件系统内（精确前缀，不误伤 `/home/x/proc/...`）。 */
function isPseudoFsPath(absPath, platform) {
  if ((platform || process.platform) !== 'linux') return false;
  const p = String(absPath || '');
  return p === '/proc' || p.startsWith('/proc/') || p === '/sys' || p.startsWith('/sys/');
}

/**
 * 判定是否应改走「有界子进程读取」而非直接 readFileSync：
 * 门开 + linux + 是普通文件 + size===0（伪文件典型特征）+ 落在 /proc|/sys。返回 true 才旁路。
 * 任一不满足 → false（逐字节回退到原有的直接读取路径）。
 */
function shouldBoundedRead(absPath, stat, platform, env) {
  const e = env || process.env;
  const raw = String(e[PSEUDO_GUARD_FLAG] == null ? '' : e[PSEUDO_GUARD_FLAG]).trim().toLowerCase();
  const on = !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
  if (!on) return false;
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) return false;
  if (Number(stat.size) !== 0) return false;
  return isPseudoFsPath(absPath, platform);
}

/**
 * 用可被 timeout 杀死的子进程有界读取一个（可能阻塞的）伪文件。
 * 返回 { handled, content?, refusal? }：
 *   - 成功读到（含截断）→ { handled:true, content }
 *   - 超时/被杀/异常 → { handled:true, refusal }（明确的人话拒绝，绝不静默卡死）
 *   - 子进程环境不可用 → { handled:false }（交回上层按需回退）
 */
function readPseudoFileBounded(absPath, spawnSyncImpl) {
  const sp = spawnSyncImpl || spawnSync;
  let r;
  try {
    r = sp('head', ['-c', String(PSEUDO_READ_MAX_BYTES), absPath], {
      timeout: PSEUDO_READ_TIMEOUT_MS,
      maxBuffer: PSEUDO_READ_MAX_BYTES + 4096,
      windowsHide: true,
    });
  } catch (_) {
    return { handled: false };
  }
  if (r && (r.error && (r.error.code === 'ETIMEDOUT' || r.error.code === 'ENOENT'))) {
    if (r.error.code === 'ENOENT') return { handled: false }; // 无 head 命令 → 交回上层
    return { handled: true, refusal: '拒绝读取：伪文件 ' + absPath + ' 在 ' + PSEUDO_READ_TIMEOUT_MS + 'ms 内无法读完（可能是阻塞型 /proc·/sys 节点），已中止以防卡死。' };
  }
  if (r && (r.signal === 'SIGTERM' || r.signal === 'SIGKILL')) {
    return { handled: true, refusal: '拒绝读取：伪文件 ' + absPath + ' 读取超时被中止（阻塞型伪文件），已防止查看器卡死。' };
  }
  if (r && r.status === 0 && r.stdout != null) {
    return { handled: true, content: Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout) };
  }
  return { handled: false };
}


/** 自定位仓库根：tools/khyos-markdown/ 上溯两级即仓库根。找不到则回退 cwd。 */
function resolveProjectRoot(scriptDir) {
  const up2 = path.resolve(scriptDir, '..', '..');
  return fs.existsSync(path.join(up2, 'docs')) ? up2 : process.cwd();
}

/**
 * 构造 HTTP 请求处理器（纯函数式，副作用经 deps 注入）。
 * @param {object} cfg
 * @param {string} cfg.token       会话鉴权 token
 * @param {string} cfg.htmlPath    khyosMarkdown.html 绝对路径
 * @param {string} cfg.projectRoot 项目根（项目内嵌模式 /api/list 默认目录的父）
 * @param {string} [cfg.defaultDir] /api/list 默认目录（默认 projectRoot/docs，回退 projectRoot）
 * @param {string} [cfg.targetPath] 全局工具模式的目标文件绝对路径；开 KHY_MD_SIDEBAR_CURRENT_DIR 时
 *                                   /api/list 默认列该文件所在目录（而非项目 docs/）。
 * @param {boolean}[cfg.sidebarCurrentDir] 显式覆盖「侧边栏列当前文件目录」门控（测试用；缺省按 env 解析）
 * @param {string} [cfg.vendorDir]  muya 自打包静态资产目录（默认 htmlPath 同级 vendor/）
 * @param {object} [cfg.fsImpl]    注入的 fs（测试用）
 */
function createHandler(cfg) {
  const fsImpl = cfg.fsImpl || fs;
  const spawnSyncImpl = cfg.spawnSyncImpl || spawnSync;
  // 侧边栏默认目录：全局工具模式(带 targetPath)且 KHY_MD_SIDEBAR_CURRENT_DIR 开 →
  // 列「当前打开文件所在的文件夹」(用户诉求:侧边栏应显示当前 md 所在目录,而非恒定项目 docs/)。
  // 否则(项目内嵌 / 门关 / 无目标文件)→ 项目 docs/(旧行为,逐字节回退)。
  // sidebarCurrentDir 可显式注入(测试);缺省按 env default-on 语义解析。
  const sidebarCurDir = (cfg.sidebarCurrentDir !== undefined)
    ? !!cfg.sidebarCurrentDir : envFlagOn('KHY_MD_SIDEBAR_CURRENT_DIR');
  let targetDir = null;
  if (sidebarCurDir && cfg.targetPath) {
    try {
      const tp = path.resolve(cfg.targetPath);
      let st = null;
      try { st = fsImpl.statSync(tp); } catch (_) { st = null; }
      targetDir = (st && st.isDirectory()) ? tp : path.dirname(tp);
    } catch (_) { targetDir = null; }
  }
  const defaultDir = cfg.defaultDir
    || targetDir
    || (fsImpl.existsSync(path.join(cfg.projectRoot, 'docs'))
        ? path.join(cfg.projectRoot, 'docs') : cfg.projectRoot);
  // 默认目录的展示标签:当前文件目录 → 「📁 <文件夹名>」;项目内嵌 → 「本项目 docs/」。
  const defaultLabel = targetDir ? ('📁 ' + path.basename(targetDir)) : '本项目 docs/';
  // vendor/ 与 khyosMarkdown.html 同级；resolve 一次作为 confinement 的锚点。
  const vendorDir = path.resolve(cfg.vendorDir || path.join(path.dirname(cfg.htmlPath), VENDOR_DIR_NAME));

  const send = (res, code, type, body) => {
    res.writeHead(code, {
      'Content-Type': type,
      // 同源即可，无需放宽 CORS；显式禁止被跨源框架引用。
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  };
  const fail = (res, code, msg) => send(res, code, 'text/plain; charset=utf-8', msg);

  // 列目录：递归收集 .md（限定深度，避免巨树）。
  // 目录与文件都作为节点进列表：{ name, path, depth, type:'dir'|'file' }，depth 反映层级。
  // 只保留（递归）含可读文件的目录节点，剔除空目录避免噪声；walk 返回其子树内可读文件数。
  function listMarkdown(dir, baseLabel) {
    const files = [];
    const walk = (d, depth) => {
      if (depth > 4) return 0;
      let entries = [];
      try { entries = fsImpl.readdirSync(d, { withFileTypes: true }); } catch (_) { return 0; }
      // 目录在前、字典序（呼应文档索引「排序首位」惯例）。
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory())
        ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1));
      let count = 0;
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          const marker = files.length;
          files.push({ name: e.name, path: full, depth, type: 'dir' });
          const sub = walk(full, depth + 1);
          if (sub === 0) files.splice(marker, 1); // 空目录（无可读文件）节点剔除
          else count += sub;
        } else if (READABLE_EXT.has(path.extname(e.name).toLowerCase())) {
          files.push({ name: e.name, path: full, depth, type: 'file' });
          count++;
        }
      }
      return count;
    };
    walk(dir, 0);
    return { label: baseLabel, dir, files };
  }

  return function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch (_) { return fail(res, 400, 'bad url'); }
    const route = url.pathname;

    // 首页：同源服务 HTML（无需 token，纯静态）。
    if (req.method === 'GET' && (route === '/' || route === '/index.html' || route === '/' + HTML_NAME)) {
      let html;
      try { html = fsImpl.readFileSync(cfg.htmlPath, 'utf8'); }
      catch (_) { return fail(res, 500, 'khyosMarkdown.html 缺失'); }
      return send(res, 200, 'text/html; charset=utf-8', html);
    }

    // /vendor/*：muya 自打包静态资产（免 token，与 / 同级纯静态）。
    // 红线：严格 confinement——decode 后 resolve，必须落在 vendorDir 内，拒 `..` 逃逸/绝对路径穿越；
    //       只读、不写、不列目录。
    if (req.method === 'GET' && (route === '/vendor' || route.startsWith('/vendor/'))) {
      let rel;
      try { rel = decodeURIComponent(route.slice('/vendor/'.length)); }
      catch (_) { return fail(res, 400, 'bad path'); }
      if (!rel || rel.endsWith('/')) return fail(res, 404, 'not found');
      // 归一化后必须仍在 vendorDir 内（path.resolve 会折叠 ..，再用 relative 判定逃逸）。
      const abs = path.resolve(vendorDir, rel);
      const within = path.relative(vendorDir, abs);
      if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
        return fail(res, 403, 'forbidden: path escape');
      }
      let stat;
      try { stat = fsImpl.statSync(abs); } catch (_) { return fail(res, 404, 'not found'); }
      if (!stat.isFile()) return fail(res, 404, 'not found');
      let data;
      try { data = fsImpl.readFileSync(abs); } catch (e) { return fail(res, 500, '读取失败: ' + e.message); }
      const type = STATIC_CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      return send(res, 200, type, data);
    }

    // 其余 /api/* 必须携带正确 token（红线4：防止本机其他来源越权调用）。
    if (route.startsWith('/api/')) {
      if (url.searchParams.get('token') !== cfg.token) return fail(res, 403, 'forbidden: bad token');
    } else if (route !== '/favicon.ico') {
      return fail(res, 404, 'not found');
    }

    // /api/ping —— 页面心跳：桥接器随浏览器标签生命周期自我了断（autoShutdown 看门狗喂食）。
    // 右键「打开方式」以 Terminal=false 启动，无终端可 Ctrl+C；关标签也不会停服。
    // 页面周期性 ping 让看门狗知道浏览器仍在，停 ping（关标签/崩溃）→ 超时自关，杜绝孤儿进程常驻占端口。
    if (req.method === 'GET' && route === '/api/ping') {
      if (typeof cfg.onPing === 'function') { try { cfg.onPing(); } catch (_) { /* fail-soft */ } }
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
    }

    // /api/close —— 关闭信标：页面卸载（关标签）时 navigator.sendBeacon 通知服务立即退出（autoShutdown 模式）。
    // 接受 GET/POST（sendBeacon 发 POST），忽略 body，仅触发关停回调。
    if (route === '/api/close' && (req.method === 'POST' || req.method === 'GET')) {
      if (typeof cfg.onClose === 'function') { try { cfg.onClose(); } catch (_) { /* fail-soft */ } }
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
    }

    // /api/read?path=  —— WHATWG URL 已自动解码（红线3：空格/中文/特殊字符免疫）。
    if (req.method === 'GET' && route === '/api/read') {
      const p = url.searchParams.get('path');
      if (!p) return fail(res, 400, 'missing path');
      const abs = path.resolve(p);
      let stat;
      try { stat = fsImpl.statSync(abs); } catch (_) { return fail(res, 404, '文件不存在: ' + abs); }
      if (!stat.isFile()) return fail(res, 400, '非文件: ' + abs);
      // 阅读工具防卡死：阻塞型伪文件（/proc·/sys 下 isFile()===true 且 size===0 的节点）走可被
      // timeout 杀掉的有界子进程读取；readFileSync 直读它们会永久锁死单线程查看器。门开(默认)+命中
      // 才旁路，其余一切逐字节回退到下方原有直接读取（普通 .md/.txt 零行为变化）。
      if (shouldBoundedRead(abs, stat, process.platform, process.env)) {
        const bounded = readPseudoFileBounded(abs, spawnSyncImpl);
        if (bounded.handled) {
          if (bounded.refusal) return fail(res, 422, bounded.refusal);
          return send(res, 200, 'text/plain; charset=utf-8', bounded.content);
        }
        // handled === false → 子进程环境不可用，回退直读（保持既有行为，不新增失败面）。
      }
      let data;
      try { data = fsImpl.readFileSync(abs, 'utf8'); } catch (e) { return fail(res, 500, '读取失败: ' + e.message); }
      return send(res, 200, 'text/plain; charset=utf-8', data);
    }

    // /api/list[?dir=]
    if (req.method === 'GET' && route === '/api/list') {
      const dirParam = url.searchParams.get('dir');
      const dir = dirParam ? path.resolve(dirParam) : defaultDir;
      const label = dirParam ? path.basename(dir) : defaultLabel;
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(listMarkdown(dir, label)));
    }

    // POST /api/save?path=
    if (req.method === 'POST' && route === '/api/save') {
      const p = url.searchParams.get('path');
      if (!p) return fail(res, 400, 'missing path');
      const abs = path.resolve(p);
      if (!READABLE_EXT.has(path.extname(abs).toLowerCase()))
        return fail(res, 400, '仅允许写回文本/Markdown 文件');
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { fsImpl.writeFileSync(abs, Buffer.concat(chunks)); }
        catch (e) { return fail(res, 500, '保存失败: ' + e.message); }
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, path: abs }));
      });
      req.on('error', () => fail(res, 500, '请求中断'));
      return;
    }

    return fail(res, 404, 'not found');
  };
}

/** 跨平台用默认浏览器打开 URL。 */
function openBrowser(url, platform, spawnImpl) {
  const sp = spawnImpl || spawn;
  const plat = platform || process.platform;
  let cmd, args;
  if (plat === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else if (plat === 'darwin') { cmd = 'open'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try { const c = sp(cmd, args, { detached: true, stdio: 'ignore' }); if (c.unref) c.unref(); }
  catch (_) { /* 打不开浏览器不致命：URL 已打印到控制台供手动访问 */ }
}

/**
 * 启动桥接器：建服务 → 监听随机空闲端口（127.0.0.1）→ 打开浏览器。
 * @param {object} [opts]
 * @param {string} [opts.targetPath] 右键传入的文件绝对路径（全局工具模式）
 * @param {string} [opts.scriptDir]  脚本所在目录（自定位 html / 项目根）
 * @param {boolean}[opts.noOpen]     不自动开浏览器（测试用）
 * @param {boolean}[opts.autoShutdown] 随浏览器标签生命周期自我关停（右键/前台单文件模式启用，
 *                                     REPL 后台复用模式禁用）。受 env KHY_MD_AUTO_SHUTDOWN 门控（default-on）。
 * @param {number} [opts.idleGraceMs] 无心跳宽限（默认 90s）；超过则关服退出。
 * @param {function}[opts.onExit]    关停时的退出实现（默认 process.exit(0)；测试注入以免杀测进程）。
 * @returns {Promise<{server,url,port,token}>}
 */
function startBridge(opts = {}) {
  const scriptDir = opts.scriptDir || __dirname;
  const token = opts.token || makeToken();
  const htmlPath = opts.htmlPath || path.join(scriptDir, HTML_NAME);
  const projectRoot = opts.projectRoot || resolveProjectRoot(scriptDir);

  // autoShutdown：调用方请求 ∧ env 门控开（KHY_MD_AUTO_SHUTDOWN，default-on，门关逐字节回退旧常驻行为）。
  const autoShutdown = !!opts.autoShutdown && envFlagOn('KHY_MD_AUTO_SHUTDOWN');
  const graceMs = Math.max(5000, Number(opts.idleGraceMs) || 90000);
  const doExit = typeof opts.onExit === 'function' ? opts.onExit : () => process.exit(0);
  let watchdog = null, closed = false, server = null;
  const shutdown = () => {
    if (closed) return; closed = true;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    try { if (server) server.close(); } catch (_) { /* fail-soft */ }
    try { doExit(); } catch (_) { /* fail-soft */ }
  };
  // 喂狗：每次心跳重置计时；unref 让计时器不独自保活（服务 socket 才是保活主体）。
  const kick = () => {
    if (!autoShutdown || closed) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(shutdown, graceMs);
    if (watchdog && watchdog.unref) watchdog.unref();
  };

  const handler = createHandler({
    token, htmlPath, projectRoot,
    // 全局工具模式:把目标文件路径下沉给 handler,使 /api/list 默认列「该文件所在目录」(KHY_MD_SIDEBAR_CURRENT_DIR)。
    targetPath: opts.targetPath,
    onPing: autoShutdown ? kick : undefined,
    onClose: autoShutdown ? shutdown : undefined,
  });
  server = http.createServer(handler);

  return new Promise((resolve) => {
    // 端口 0 = 让 OS 分配空闲端口，避免硬编码端口冲突。
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      // 初始宽限放宽到 2×，给浏览器启动并首次心跳留足时间；此后每次 ping 重置为 graceMs。
      if (autoShutdown) { watchdog = setTimeout(shutdown, graceMs * 2); if (watchdog && watchdog.unref) watchdog.unref(); }
      let url = `http://127.0.0.1:${port}/?token=${token}`;
      if (opts.targetPath) url += `&path=${encodeURIComponent(path.resolve(opts.targetPath))}`;
      // WYSIWYG 门控（KHY_MD_WYSIWYG，default-on）：opts.wysiwyg 优先（CLI 经 flagRegistry 解析后传入），
      // 否则就地按 env default-on 语义解析。页面据 ?wysiwyg= 决定是否加载 muya。
      const wysiwyg = (opts.wysiwyg !== undefined) ? !!opts.wysiwyg : envFlagOn('KHY_MD_WYSIWYG');
      url += `&wysiwyg=${wysiwyg ? '1' : '0'}`;
      // 控制台始终打印 URL（即便浏览器打不开，用户也能手动访问，绝不卡死）。
      process.stdout.write(`  [khyosMarkdown] 服务已就绪：${url}\n`);
      if (!opts.noOpen) openBrowser(url, process.platform);
      resolve({ server, url, port, token });
    });
  });
}

// ── 作为入口运行 ──────────────────────────────────────────────────
if (require.main === module) {
  // 取第一个非空参数为目标文件（由 khyos-md-target.js 中转，已正确处理编码）。
  const target = process.argv.slice(2).find((a) => a && !a.startsWith('-'));
  // 右键「打开方式」经此入口启动：无终端可 Ctrl+C，故启用 autoShutdown 随浏览器标签自我了断，杜绝孤儿进程。
  startBridge({ targetPath: target, autoShutdown: true }).catch((e) => {
    process.stderr.write('  [khyosMarkdown] 启动失败：' + e.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  HTML_NAME, VENDOR_DIR_NAME, READABLE_EXT, STATIC_CONTENT_TYPES,
  makeToken, envFlagOn, resolveProjectRoot, createHandler, openBrowser, startBridge,
  // 阅读工具防卡死原语（自包含，供单测）
  PSEUDO_GUARD_FLAG, PSEUDO_READ_TIMEOUT_MS, PSEUDO_READ_MAX_BYTES,
  isPseudoFsPath, shouldBoundedRead, readPseudoFileBounded,
};
