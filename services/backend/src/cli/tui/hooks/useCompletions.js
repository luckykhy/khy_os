'use strict';

/**
 * useCompletions — derives the inline completion menu state from the current
 * buffer + caret, Claude-Code style.
 *
 *  - Leading "/"  → slash-command menu (driven by router.getCompletions).
 *  - "@<partial>" token → filesystem path menu (relative to cwd).
 *
 * Returns a descriptor; selection state and accept() live in the component so
 * the menu can be navigated without recomputing the candidate list each frame.
 */
const { useMemo } = require('react');
const fs = require('fs');
const path = require('path');
// 刀24:TUI 斜杠菜单过滤/排序路由到既有 rankSlashCommands SSOT(子串/分段/描述匹配,
// 对齐 CC 并与经典 REPL 收敛)。门控关 → 注入式前缀回退,逐字节等价。
const { slashMenuCommandNames } = require('../slashMenuFilter');
// commandRegistry 之外的额外菜单命令(/study /hud …)与经典 REPL 共用同一份 SSOT。
// 此前 TUI 只读 router.SLASH_COMMANDS → 这 13 条命令在 TUI 菜单里完全搜不到;并入后
// 两入口菜单同步(改 slashExtraCommands 一处即可)。fail-soft:叶子不可用则退回原列表。
const { SLASH_EXTRA_COMMANDS, mergeExtraCommands } = require('../../slashExtraCommands');
// @-mention 补全每键对同一目录 readdirSync,大目录阻塞字符回显。按 abs 目录短 TTL 记忆
// readdir 结果,连续按键复用一次系统调用;门控关 → 直读(逐字节回退)。
const completionDirCache = require('../completionDirCache');

let _router = null;
function router() {
  if (!_router) _router = require('../../router');
  return _router;
}

let _slashMeta = null;
function slashDescription(cmd) {
  if (_slashMeta === null) {
    _slashMeta = new Map();
    try {
      const list = router().SLASH_COMMANDS || [];
      for (const sc of list) {
        const key = sc.cmd || sc.command || sc.name;
        if (key) _slashMeta.set(key, sc.desc || sc.description || sc.summary || '');
      }
    } catch { /* none */ }
    // 额外命令的描述并入(registry 不含它们),使 TUI 菜单渲染出与经典 REPL 一致的 desc。
    // 既有优先:registry 已提供的 desc 不被 extras 覆盖。
    try {
      for (const ex of SLASH_EXTRA_COMMANDS) {
        if (ex && ex.cmd && !_slashMeta.has(ex.cmd)) _slashMeta.set(ex.cmd, ex.desc || '');
      }
    } catch { /* extras 不可用 → 仅缺 desc,不影响命中 */ }
  }
  return _slashMeta.get(cmd) || '';
}

function computeSlash(value) {
  // Only while still typing the command token (no space yet).
  if (value.includes(' ') || value.includes('\n')) return null;
  if (!value.startsWith('/')) return null;
  let items = [];
  try {
    const r = router();
    // registry/router 命令 + 额外命令(/study /hud …)合并后再排序,令两入口菜单收敛。
    let slashCommands = r.SLASH_COMMANDS;
    try { slashCommands = mergeExtraCommands(r.SLASH_COMMANDS || []); }
    catch { /* fail-soft:退回未合并列表 */ }
    const names = slashMenuCommandNames(
      value,
      { slashCommands, getCompletionsFn: (v) => r.getCompletions(v) },
      process.env,
    );
    items = (names || []).map((cmd) => ({
      value: cmd,
      label: cmd,
      desc: slashDescription(cmd),
    }));
  } catch { items = []; }
  if (items.length === 0) return null;
  return { kind: 'slash', items, start: 0, end: value.length };
}

function computeFile(value, offset) {
  // Find the @-token that ends at the caret.
  const before = value.slice(0, offset);
  const m = before.match(/(^|\s)@([^\s]*)$/);
  if (!m) return null;
  const partial = m[2];
  const atStart = offset - partial.length - 1; // position of '@'
  const dir = partial.includes('/') ? path.dirname(partial) : '.';
  const base = partial.includes('/') ? path.basename(partial) : partial;
  let entries = [];
  try {
    const abs = path.resolve(process.cwd(), dir);
    entries = completionDirCache.readdirCached(abs, (p) => fs.readdirSync(p, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.') || base.startsWith('.'))
      .filter((e) => e.name.toLowerCase().startsWith(base.toLowerCase()))
      .slice(0, 50)
      .map((e) => {
        const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
        const isDir = e.isDirectory();
        return { value: `@${rel}${isDir ? '/' : ''}`, label: `${e.name}${isDir ? '/' : ''}`, desc: isDir ? '目录' : '文件', isDir };
      });
  } catch { entries = []; }
  if (entries.length === 0) return null;
  return { kind: 'file', items: entries, start: atStart, end: offset };
}

function useCompletions(value, offset) {
  return useMemo(() => {
    if (!value) return { active: false, items: [] };
    const slash = computeSlash(value);
    if (slash) return { active: true, ...slash };
    const file = computeFile(value, offset);
    if (file) return { active: true, ...file };
    return { active: false, items: [] };
  }, [value, offset]);
}

/** Build the replacement buffer when an item is accepted. */
function applyCompletion(value, comp, item) {
  const before = value.slice(0, comp.start);
  const after = value.slice(comp.end);
  // Slash commands get a trailing space; directories keep the trailing slash
  // (so the user can keep drilling down), files get a trailing space.
  let insert = item.value;
  if (comp.kind === 'slash') insert = `${item.value} `;
  else if (comp.kind === 'file' && !item.isDir) insert = `${item.value} `;
  const text = before + insert + after;
  return { text, offset: (before + insert).length };
}

module.exports = { useCompletions, applyCompletion, computeFile, computeSlash };
