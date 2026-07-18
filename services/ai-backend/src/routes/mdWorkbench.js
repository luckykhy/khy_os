/**
 * mdWorkbench.js — 服务器文件目录读写（Markdown 工作台的「连服务器文件」增强，需登录）。
 *
 * 定位：AI 前端的 Markdown 版块（无需登录）核心是浏览器内编辑；此路由是**登录才开放**的
 * 可选增强——读写**服务器主机**上一个受限根目录内的 Markdown 文本文件（自托管单机场景下即
 * 用户自己的机器）。匿名用户前端不渲染该区、绝不触发这些 API。
 *
 * 安全红线（照抄 tools/khyos-markdown/khyos-md-bridge.js 的两道闸 + 本仓 fail-soft 约定）：
 *   1. 必经 `authenticateToken`（router.use 顶部）——与 marketplace.js 同范式。
 *   2. 路径 confinement：decode 后 path.resolve，用 path.relative(root, abs) 判定，
 *      拒 `..` 逃逸 / 绝对路径穿越——所有读/写/列都必须落在配置根目录内。
 *   3. 文本扩展名 allowlist：只读写 .md/.markdown/.txt 等纯文本，拒可执行/二进制。
 *   4. fail-soft：任何异常都转成结构化 4xx，绝不抛、绝不 500 崩进程。
 *   5. 特性门控 KHY_AI_MD_WORKBENCH_FILES（default-on，CANON off 词关）；门关时 server.js
 *      不挂载本路由（整段不可达），是逐字节回退（等价于该增强从未存在）。
 *
 * 根目录经 env KHY_MD_WORKBENCH_ROOT 配置，缺省为当前用户 home 目录。
 *
 * @pattern Proxy
 */
'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

// ── 门控（纯 env，default-on；ai-backend 不复用 backend flagRegistry）───────────
const CANON_OFF = new Set(['0', 'false', 'off', 'no']);
function enabled() {
  const raw = process.env.KHY_AI_MD_WORKBENCH_FILES;
  if (raw === undefined || raw === null) return true;
  return !CANON_OFF.has(String(raw).trim().toLowerCase());
}

// ── 配置根 + 文本扩展名 allowlist（照抄 bridge READABLE_EXT）────────────────────
const READABLE_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt', '.text']);
const MAX_READ_BYTES = 2 * 1024 * 1024;   // 单文件读上限 2MB（超限拒，避免大文件拖垮）
const MAX_LIST_ENTRIES = 2000;            // 列目录条目上限
const MAX_LIST_DEPTH = 6;                 // 递归深度上限

function workbenchRoot() {
  const cfg = process.env.KHY_MD_WORKBENCH_ROOT;
  try {
    return path.resolve(cfg && cfg.trim() ? cfg : os.homedir());
  } catch (_) {
    return process.cwd();
  }
}

// confinement：把候选路径 resolve 后必须仍落在 root 内。返回 { ok, abs } 或 { ok:false }。
function confine(root, candidate) {
  try {
    const abs = path.resolve(root, candidate);
    const rel = path.relative(root, abs);
    if (!rel) return { ok: true, abs }; // rel 为空 = 就是 root 本身
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      return { ok: false };
    }
    return { ok: true, abs };
  } catch (_) {
    return { ok: false };
  }
}

function fail(res, code, message) {
  return res.status(code).json({ success: false, message: message || 'error' });
}

router.use(authenticateToken);

// GET /list?dir= — 列出根（或子目录）内的 Markdown 文本文件（递归、有界、confined）。
function listHandler(req, res) {
  try {
    const root = workbenchRoot();
    const dirParam = typeof req.query.dir === 'string' ? req.query.dir : '';
    const c = dirParam ? confine(root, dirParam) : { ok: true, abs: root };
    if (!c.ok) return fail(res, 403, 'path escapes workbench root');
    const baseDir = c.abs;

    let baseStat = null;
    try { baseStat = fs.statSync(baseDir); } catch (_) { baseStat = null; }
    if (!baseStat || !baseStat.isDirectory()) return fail(res, 404, 'directory not found');

    const files = [];
    // 目录与文件都作为节点进列表：{ name, path, depth, type:'dir'|'file' }，depth 反映层级；
    // 只保留（递归）含可读文件的目录节点，剔除空目录避免噪声；walk 返回其子树内可读文件数。
    const walk = (dir, depth) => {
      if (files.length >= MAX_LIST_ENTRIES || depth > MAX_LIST_DEPTH) return 0;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
      // 目录在前、字典序（与桥接器/文档索引一致）。
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory())
        ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1));
      let count = 0;
      for (const e of entries) {
        if (files.length >= MAX_LIST_ENTRIES) break;
        if (e.name.startsWith('.')) continue; // 跳过隐藏项
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          const marker = files.length;
          files.push({ name: e.name, path: abs, depth, type: 'dir' });
          const sub = walk(abs, depth + 1);
          if (sub === 0) files.splice(marker, 1); // 空目录（无可读文件）节点剔除
          else count += sub;
        } else if (READABLE_EXT.has(path.extname(e.name).toLowerCase())) {
          files.push({ name: e.name, path: abs, depth, type: 'file' });
          count += 1;
        }
      }
      return count;
    };
    walk(baseDir, 0);

    const label = dirParam ? path.basename(baseDir) : ('📁 ' + path.basename(baseDir));
    return res.json({ success: true, data: { root, dir: baseDir, label, files } });
  } catch (err) {
    return fail(res, 400, (err && err.message) || 'list failed');
  }
}

// GET /read?path= — 读取一个受限文本文件的内容。
function readHandler(req, res) {
  try {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) return fail(res, 400, 'missing path');
    const root = workbenchRoot();
    const c = confine(root, p);
    if (!c.ok) return fail(res, 403, 'path escapes workbench root');
    if (!READABLE_EXT.has(path.extname(c.abs).toLowerCase())) return fail(res, 400, 'not a text file');

    let stat = null;
    try { stat = fs.statSync(c.abs); } catch (_) { stat = null; }
    if (!stat || !stat.isFile()) return fail(res, 404, 'file not found');
    if (stat.size > MAX_READ_BYTES) return fail(res, 422, 'file too large');

    let content = '';
    try { content = fs.readFileSync(c.abs, 'utf8'); } catch (_) { return fail(res, 404, 'read failed'); }
    return res.json({ success: true, data: { path: c.abs, content } });
  } catch (err) {
    return fail(res, 400, (err && err.message) || 'read failed');
  }
}

// POST /save?path= — 写回受限文本文件（body: { content }）。仅允许文本扩展名。
function saveHandler(req, res) {
  try {
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    if (!p) return fail(res, 400, 'missing path');
    const root = workbenchRoot();
    const c = confine(root, p);
    if (!c.ok) return fail(res, 403, 'path escapes workbench root');
    if (!READABLE_EXT.has(path.extname(c.abs).toLowerCase())) return fail(res, 400, 'not a text file');

    const body = req.body || {};
    const content = typeof body.content === 'string'
      ? body.content
      : (typeof body === 'string' ? body : '');
    if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) return fail(res, 422, 'content too large');

    // 只写既有文件所在目录内（父目录必须已存在，不新建目录树，避免危险写路径）。
    const parent = path.dirname(c.abs);
    let parentStat = null;
    try { parentStat = fs.statSync(parent); } catch (_) { parentStat = null; }
    if (!parentStat || !parentStat.isDirectory()) return fail(res, 404, 'target directory not found');

    try { fs.writeFileSync(c.abs, content, 'utf8'); } catch (_) { return fail(res, 400, 'write failed'); }
    return res.json({ success: true, data: { path: c.abs } });
  } catch (err) {
    return fail(res, 400, (err && err.message) || 'save failed');
  }
}

router.get('/list', listHandler);
router.get('/read', readHandler);
router.post('/save', saveHandler);

module.exports = router;
module.exports.enabled = enabled;
module.exports.__test__ = {
  confine, workbenchRoot, READABLE_EXT, enabled,
  listHandler, readHandler, saveHandler,
};
