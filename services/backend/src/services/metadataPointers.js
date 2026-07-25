'use strict';

/**
 * metadataPointers — 把各 AI 工具的「入口文件」指向 .ai/ 种子文档。
 *
 * 问题：没有任何工具会主动扫描 `.ai/` 目录；每个 AI 助手只自动加载自己约定的那一个文件
 * （Claude Code 读 CLAUDE.md、Codex/Cursor 读 AGENTS.md、Copilot 读 .github/copilot-instructions.md…）。
 * 因此要让「其它 AI」真正读到 .ai/，必须在这些约定入口文件里写一段指针，引导其先读 .ai/。
 *
 * 设计：
 *   - 非破坏：已存在的文件只注入/更新带标记的指针块（START/END 之间），其余内容原样保留。
 *   - 幂等：指针块内容不变则不重写（提交钩子每次跑也不会产生 git 噪音）。
 *   - 目标可配：KHY_META_POINTER_TARGETS（逗号分隔 key）限制范围；KHY_META_LINK=0 整体关闭。
 *   - Fail-soft：任何单个文件失败都被吞掉，绝不影响元数据主流程。
 *
 * 纯 Node stdlib。
 */

const fs = require('fs');
const path = require('path');

const BLOCK_START = '<!-- khy-metadata:pointer START';
const BLOCK_END = '<!-- khy-metadata:pointer END -->';

// 入口文件登记表。mode:
//   'inject' — 注入带标记的指针块；文件已存在但无标记则在末尾追加（不动原内容）。
//   'mdc'    — Cursor 规则文件：带 frontmatter 的整文件机器自有（仅当缺失或为我方文件时写）。
const POINTER_TARGETS = [
  { key: 'agents',   file: 'AGENTS.md',                         mode: 'inject' },
  { key: 'claude',   file: 'CLAUDE.md',                         mode: 'inject' },
  { key: 'copilot',  file: '.github/copilot-instructions.md',   mode: 'inject' },
  { key: 'cursor',   file: '.cursor/rules/khy-maintainability.mdc', mode: 'mdc' },
  { key: 'windsurf', file: '.windsurfrules',                    mode: 'inject' },
  { key: 'cline',    file: '.clinerules',                       mode: 'inject' },
];

function _boolEnv(name, def) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return def;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function _enabledKeys() {
  const raw = String(process.env.KHY_META_POINTER_TARGETS || '').trim();
  if (!raw) return POINTER_TARGETS.map(t => t.key);
  const want = new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  return POINTER_TARGETS.map(t => t.key).filter(k => want.has(k));
}

// 指针块正文（工具与人类都读；用英文以便随生成项目travels到任意语言环境）。
function _pointerBody() {
  return [
    `${BLOCK_START} — managed by \`khy metadata link\`; edits inside this block are overwritten -->`,
    '## 🤖 Maintainability metadata — read `.ai/` first',
    '',
    'Before changing this project, read the machine-generated seed docs in `.ai/`',
    '(this repo is designed to stay maintainable even without AI):',
    '',
    '1. **`.ai/MAP.md`** — skeleton & navigation: tech stack, entry points, build/run/test commands, directory tree, key symbols.',
    '2. **`.ai/CONTEXT.yaml`** — machine-readable contracts: stack, entry_points, build, deps, per-file symbols.',
    '3. **`.ai/GUARDS.md`** — red lines & how to maintain this project *without* AI.',
    '',
    'If `.ai/SKELETON.auto.md` is present, the three files above are human-authored and',
    'authoritative; `SKELETON.auto.md` is the machine-derived structural layer. All are kept',
    'current deterministically by `khy metadata refresh` plus a git pre-commit hook.',
    BLOCK_END,
  ].join('\n');
}

function _mdcContent() {
  return [
    '---',
    'description: Read .ai/ maintainability seed docs before editing this repo',
    'alwaysApply: true',
    '---',
    _pointerBody(),
    '',
  ].join('\n');
}

/** 注入/更新带标记的指针块；返回新文本（与原文相同表示无需写）。 */
function _injectBlock(existing, block) {
  const norm = (block.endsWith('\n') ? block : block + '\n');
  if (!existing) return norm;
  const si = existing.indexOf(BLOCK_START);
  if (si !== -1) {
    const ei = existing.indexOf(BLOCK_END, si);
    if (ei !== -1) {
      const before = existing.slice(0, si);
      const after = existing.slice(ei + BLOCK_END.length);
      return before + block.trim() + after;
    }
  }
  // 无标记：在末尾追加（保留原文）。
  const sep = existing.endsWith('\n\n') ? '' : (existing.endsWith('\n') ? '\n' : '\n\n');
  return existing + sep + block.trim() + '\n';
}

/**
 * 在项目根写入/更新各 AI 工具入口文件中的 .ai/ 指针。
 * @returns {{ok:boolean, written:string[], unchanged:string[], skipped:string[], reason?:string}}
 */
function linkAgentPointers(root, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const out = { ok: true, written: [], unchanged: [], skipped: [] };
  try {
    if (!_boolEnv('KHY_META_LINK', true)) {
      return { ...out, ok: false, reason: 'disabled' };
    }
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { ...out, ok: false, reason: 'invalid_root' };
    }
    const enabled = new Set(_enabledKeys());
    const block = _pointerBody();
    for (const t of POINTER_TARGETS) {
      if (!enabled.has(t.key)) continue;
      const abs = path.join(root, t.file);
      try {
        const exists = fs.existsSync(abs);
        const existing = exists ? fs.readFileSync(abs, 'utf8') : '';
        let next;
        if (t.mode === 'mdc') {
          // 整文件机器自有：仅当缺失或确为我方文件时写，绝不覆盖同名外部文件。
          if (exists && !existing.includes('khy-metadata:pointer')) { out.skipped.push(t.file); continue; }
          next = _mdcContent();
        } else {
          next = _injectBlock(existing, block);
        }
        if (exists && next === existing) { out.unchanged.push(t.file); continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, next, 'utf8');
        out.written.push(t.file);
      } catch {
        out.skipped.push(t.file);
      }
    }
    if (out.written.length) log(`metadata: 已让 AI 入口指向 .ai/（${out.written.join(', ')}）`);
    return out;
  } catch (err) {
    return { ...out, ok: false, reason: `error:${err && err.message ? err.message : 'unknown'}` };
  }
}

/** 供提交钩子静态枚举的、需在刷新后一并入暂存的入口文件路径（不含 .ai/）。 */
function pointerStagePaths() {
  return POINTER_TARGETS.map(t => t.file);
}

module.exports = {
  linkAgentPointers,
  pointerStagePaths,
  POINTER_TARGETS,
  _internal: { _injectBlock, _pointerBody, _mdcContent, _enabledKeys, BLOCK_START, BLOCK_END },
};
