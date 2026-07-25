'use strict';

/**
 * artifactPlan.js — Artifact 工具(把生成内容持久化为本地工件 + 列出/读取)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;内容、已有工件清单、env 全经入参注入,本叶子绝不读
 * process.env、绝不触文件、绝不开网络、绝不调 Date。真正的「原子写工件 / 列目录 / 读回」(有 fs IO)都在工具壳,
 * 委托既有 getDataDir + 原子写,绝不另起炉灶。本叶子只做:动作/参数校验 + 安全文件名派生(防目录穿越)+
 * 工件元数据构造 + 文本/结果渲染。
 *
 * 背后的逻辑(对齐 Claude Code Artifact —— 但**诚实落到 khy 的本地语义**):CC 的 Artifact 把模型产出的内容
 * (代码/文档/HTML 等)登记为一个**可分享的云端工件**(返回一个托管 URL,可在 web 端预览/分享)。khy **没有那个云端
 * 工件托管 —— 绝不伪造一个托管 URL/上传**;但 khy **真有**同构本地基质:`getDataDir('artifacts')` 给工件一个
 * **跨调用可发现**的持久落点。故 khy 的 Artifact = **把内容原子写进 `<dataHome>/artifacts/<安全名>` 并返回本地
 * 路径**(create / list / read 三动作),让产出可被后续会话/工具发现复用,而非伪造一条不存在的云链路。
 *
 * 诚实边界:① 返回的是**本地绝对路径**,不是云 URL —— 不伪造分享链接;② 文件名经严格清洗(只留
 * `[A-Za-z0-9._-]`,去掉路径分隔与 `..`),**绝不**让 name 造成目录穿越;③ 大小由工具壳按既有上限把关;
 * ④ 本叶子不写死任何目录/host —— 落点目录由工具壳经既有 getDataDir 注入。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _ACTIONS = new Set(['create', 'list', 'read']);
const _MAX_NAME = 128;

/**
 * 门控 KHY_ARTIFACT_TOOL —— 默认开;关时工具壳走「如同未装」诚实回退(不写文件)。
 * 规范化:env 注入,绝不读 process.env;空/0/false/off/no → 关,其余 → 开。
 * @param {object} env
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_ARTIFACT_TOOL === undefined ? 'true' : e.KHY_ARTIFACT_TOOL;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

/**
 * 校验并归一输入动作 + 参数。
 * @param {object} params - { action, name?, content?, kind? }
 * @returns {{ ok:boolean, action:string, error:(string|null) }}
 */
function validateInput(params) {
  const p = params && typeof params === 'object' ? params : {};
  const action = typeof p.action === 'string' && p.action.trim() ? p.action.trim().toLowerCase() : 'create';
  if (!_ACTIONS.has(action)) {
    return { ok: false, action, error: `未知 action「${p.action}」(支持 create | list | read)` };
  }
  if (action === 'create') {
    if (typeof p.content !== 'string' || p.content.length === 0) {
      return { ok: false, action, error: 'create 需要非空 content(字符串)' };
    }
  }
  if (action === 'read') {
    if (typeof p.name !== 'string' || !p.name.trim()) {
      return { ok: false, action, error: 'read 需要 name(已存在的工件名)' };
    }
  }
  return { ok: true, action, error: null };
}

/**
 * 由 name/kind 派生**安全**文件名(防目录穿越):剥目录、只留 [A-Za-z0-9._-]、压连续 `.`、去首尾 `.`。
 * 缺 name 时用注入的 fallbackStem(工具壳传入,通常含时间戳/计数,叶子保持无时钟)。
 * @param {object} input - { name?, kind?, fallbackStem? }
 * @returns {string}
 */
function deriveSafeName(input) {
  const src = input && typeof input === 'object' ? input : {};
  let raw = typeof src.name === 'string' ? src.name : '';
  // 剥任何路径成分(取最后一段),再清洗。
  raw = raw.replace(/\\/g, '/');
  const lastSeg = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  let cleaned = lastSeg
    .replace(/[^A-Za-z0-9._-]/g, '_')   // 非白名单字符 → 下划线
    .replace(/\.{2,}/g, '.')             // 连续点(含 ..)压成单点
    .replace(/^\.+/, '')                 // 去首部点
    .replace(/\.+$/, '');                // 去尾部点
  if (cleaned.length > _MAX_NAME) cleaned = cleaned.slice(0, _MAX_NAME);

  if (!cleaned) {
    const stem = typeof src.fallbackStem === 'string' && src.fallbackStem.trim()
      ? src.fallbackStem.trim().replace(/[^A-Za-z0-9._-]/g, '_')
      : 'artifact';
    const ext = _extForKind(src.kind);
    cleaned = `${stem}${ext}`;
  } else if (!/\.[A-Za-z0-9]+$/.test(cleaned)) {
    // 无扩展名 → 按 kind 补一个(纯映射,不写死目录/host)。
    cleaned += _extForKind(src.kind);
  }
  return cleaned;
}

/** kind → 扩展名(纯映射;未知 kind → .txt)。 */
function _extForKind(kind) {
  const k = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  switch (k) {
    case 'js': case 'javascript': return '.js';
    case 'ts': case 'typescript': return '.ts';
    case 'py': case 'python': return '.py';
    case 'json': return '.json';
    case 'html': return '.html';
    case 'css': return '.css';
    case 'md': case 'markdown': return '.md';
    case 'sh': case 'bash': return '.sh';
    case 'yaml': case 'yml': return '.yaml';
    case '': case 'text': case 'txt': return '.txt';
    default: return '.txt';
  }
}

/**
 * 构造 create 成功结果(给模型/用户的回执;path 由工具壳注入,叶子不知绝对落点)。
 * @param {object} input - { name, path, bytes }
 */
function buildCreateResult({ name, path, bytes } = {}) {
  return {
    success: true,
    action: 'create',
    name: name == null ? null : String(name),
    path: path == null ? null : String(path),
    bytes: Number.isFinite(bytes) ? bytes : 0,
    note: '已保存为本地工件(非云端分享链接)。可用 action=list 查看、action=read 读回。',
  };
}

/** 构造 list 结果(entries 由工具壳读目录后注入)。 */
function buildListResult(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  return {
    success: true,
    action: 'list',
    count: list.length,
    artifacts: list.map((e) => ({ name: String(e.name), bytes: Number.isFinite(e.bytes) ? e.bytes : 0 })),
  };
}

/** 构造 read 结果(content 由工具壳读文件后注入)。 */
function buildReadResult({ name, path, content } = {}) {
  return {
    success: true,
    action: 'read',
    name: name == null ? null : String(name),
    path: path == null ? null : String(path),
    content: content == null ? '' : String(content),
  };
}

/** 统一错误结果。 */
function buildErrorResult(error) {
  return { success: false, error: String(error == null ? '未知错误' : error) };
}

/** 活动描述(TUI 行)。 */
function describeActivity(params) {
  const p = params && typeof params === 'object' ? params : {};
  const action = typeof p.action === 'string' ? p.action.toLowerCase() : 'create';
  if (action === 'list') return '列出本地工件';
  if (action === 'read') return `读取工件:${p.name || '?'}`;
  return `保存本地工件${p.name ? `:${p.name}` : ''}`;
}

module.exports = {
  isEnabled,
  validateInput,
  deriveSafeName,
  buildCreateResult,
  buildListResult,
  buildReadResult,
  buildErrorResult,
  describeActivity,
};
