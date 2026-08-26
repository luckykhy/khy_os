'use strict';

/**
 * adapters/claudeCode.js — Claude Code 的记忆/工具/技能资产适配器。
 *
 * 磁盘布局(实证本机 ~/.claude):
 *   CLAUDE.md                                全局指令(scope=global 的单份记忆)
 *   projects/<slug>/memory/MEMORY.md         逐项记忆的索引
 *   projects/<slug>/memory/<name>.md         一条一文件的记忆(frontmatter + 正文)
 *   settings.json / settings.local.json      .mcpServers → mcp_server 型工具
 *   skills/<name>/SKILL.md (+ 附属资源)      技能
 *
 * 写入落点规则(三家一致):
 *   - **同工具往返**(asset.source.tool === 'claude-code' 且带 source.path)→ 原地写回
 *     来处,故 native → IR → native 逐字段等价(往返测试锁死),CLAUDE.md 也能写回。
 *   - **跨工具导入**(来自 opencode/harness)→ 一律落到 projects/<slug>/memory/ 这个
 *     「一条一文件」的托管目录并登记进 MEMORY.md,绝不去改用户自己的 CLAUDE.md ——
 *     往别人的指令正文里插内容是不可预期的副作用。
 *
 * 凭据:settings.json 的 mcpServers.<name>.env 常放 token。listTools 出口一律经
 * assetModel.redactCredentials 抹掉,回写时经 restoreRedacted 用目标侧现值填回,
 * 故凭据既不进 IR,也不会被占位符覆盖掉用户真实密钥。
 */

const path = require('path');

const B = require('../_adapterBase');
const M = require('../assetModel');

const TOOL_ID = 'claude-code';
const LABEL = 'Claude Code';

/** 资产根覆盖:khy 专用变量优先,其次 Claude Code 自己的 CLAUDE_CONFIG_DIR。 */
const ROOT_ENV_KEYS = Object.freeze(['KHY_AGENT_ASSETS_CLAUDE_CODE_ROOT', 'CLAUDE_CONFIG_DIR']);

const SETTINGS_FILES = Object.freeze(['settings.json', 'settings.local.json']);
const GLOBAL_MEMORY_FILE = 'CLAUDE.md';
const MEMORY_INDEX_FILE = 'MEMORY.md';
const SKILL_ENTRY_FILE = 'SKILL.md';

/** contents 里内联的文本扩展名 + 单文件上界(超界只记 files,不内联)。 */
const TEXT_EXTS = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.py', '.sh']);
const MAX_INLINE_BYTES = 256 * 1024;

// ── detect / capabilities ───────────────────────────────────────────────

/**
 * 探测资产根。失败时回报「找过哪些位置」,不只说「未找到」。
 * @param {Record<string,string>} [env]
 */
function detect(env) {
  const e = env || process.env;
  return B.probeRoot({
    env: e,
    envKeys: ROOT_ENV_KEYS,
    candidates: [{ path: path.join(B.homeDir(e), '.claude'), why: 'Claude Code 默认配置目录' }],
  });
}

/**
 * 能力声明。缺失的能力显式声明为不支持,而不是抛异常。
 * @param {Record<string,string>} [env]
 */
function capabilities(env) {
  const d = detect(env);
  return {
    id: TOOL_ID,
    label: LABEL,
    detected: d.ok === true,
    root: d.ok ? d.root : '',
    kinds: {
      memory: { read: true, write: true, note: '读 CLAUDE.md + projects/<slug>/memory/*.md' },
      tool: { read: true, write: true, note: '仅 settings.json 的 mcpServers' },
      skill: { read: true, write: true, note: 'skills/<name>/SKILL.md' },
    },
    rootEnvKeys: ROOT_ENV_KEYS.slice(),
  };
}

// ── 项目 slug ───────────────────────────────────────────────────────────

/**
 * Claude Code 把项目路径 slug 化成目录名(C:\khy-os → C--khy-os)。
 * 可用 KHY_AGENT_ASSETS_CLAUDE_PROJECT 显式覆盖。
 */
function _projectSlug(env) {
  const e = env || process.env;
  const explicit = String((e && e.KHY_AGENT_ASSETS_CLAUDE_PROJECT) || '').trim();
  if (explicit) {
    return explicit;
  }
  const cwd = String((e && e.KHYQUANT_CWD) || process.cwd() || '')
    .trim()
    .replace(/[\\/]+$/, '');
  // Replace each non-alphanumeric char with a dash and do NOT collapse runs: Claude Code
  // maps 'C:\khy-os' to 'C--khy-os' (colon and backslash each cost one dash). Collapsing
  // to 'C-khy-os' points at a directory that does not exist, silently missing every
  // project-scoped memory. Leading dashes are kept too: POSIX '/home/u/p' is '-home-u-p'.
  return cwd.replace(/[^A-Za-z0-9]/g, '-') || 'default';
}

function _memoryDirRel(env) {
  return `projects/${_projectSlug(env)}/memory`;
}

// ── memory ──────────────────────────────────────────────────────────────

function _memoryFromFile(root, relPath, scope) {
  const abs = path.join(root, relPath);
  const text = B.readText(abs);
  if (text === null) {
    return null;
  }
  const fm = B.parseFrontmatter(text);
  const stem = path.basename(relPath, path.extname(relPath));
  const metadata = fm.data && typeof fm.data.metadata === 'object' ? fm.data.metadata : {};
  const declaredScope = String(metadata.scope || '').trim();
  const tags = [];
  if (metadata.type) {
    tags.push(String(metadata.type));
  }
  const built = M.validateAsset('memory', {
    id: String(fm.data.name || stem),
    scope: M.MEMORY_SCOPES.includes(declaredScope) ? declaredScope : scope,
    // Claude Code 的记忆里 `name` 是 kebab-case 短标识、`description` 才是给人看的
    // 一句话摘要,故 description 映射到 IR 的 title——与 _renderMemory 的写出方向对称。
    title: String(fm.data.description || fm.data.name || stem),
    content: fm.body,
    tags,
    updatedAt: B.mtimeIso(abs),
    source: { tool: TOOL_ID, path: relPath, format: 'markdown+frontmatter' },
    // 私有字段原样保留 → 回写时先铺 raw 再覆盖共性字段,故解析器再弱也不丢字段。
    raw: { frontmatter: fm.data, frontmatterText: fm.raw, frontmatterParsed: fm.parsed },
  });
  return built.ok ? built.asset : null;
}

/**
 * 列出记忆:全局 CLAUDE.md + 当前项目的逐项记忆目录。
 * @param {Record<string,string>} [env]
 */
function listMemories(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const assets = [];
  const globalFile = path.join(d.root, GLOBAL_MEMORY_FILE);
  if (B.isFile(globalFile)) {
    const a = _memoryFromFile(d.root, GLOBAL_MEMORY_FILE, 'global');
    if (a) {
      assets.push(a);
    }
  }
  const memRel = _memoryDirRel(env);
  const memDir = path.join(d.root, memRel);
  if (B.isDir(memDir)) {
    for (const rel of B.walkFiles(memDir, { exts: ['.md'], maxDepth: 2 })) {
      const a = _memoryFromFile(d.root, `${memRel}/${rel}`, 'project');
      if (a) {
        assets.push(a);
      }
    }
  }
  return { ok: true, assets, root: d.root };
}

/** 跨工具导入时的落点:托管的逐项记忆目录。 */
function _memoryTargetRel(asset, env) {
  const src = (asset && asset.source) || {};
  if (src.tool === TOOL_ID && src.path) {
    return src.path;
  }
  const stem = String((asset && asset.id) || 'memory').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${_memoryDirRel(env)}/${stem}.md`;
}

function _renderMemory(asset, sameTool) {
  const raw = (asset && asset.raw) || {};
  // 同工具往返:frontmatter 原文回吐 → 逐字节等价。
  if (raw.frontmatterText) {
    return B.serializeFrontmatter(null, asset.content, raw.frontmatterText);
  }
  // 来处本就没有 frontmatter(用户手写的 CLAUDE.md 就是这样)→ 原地写回时正文逐字节
  // 回吐,绝不替人插一段 frontmatter:那既破坏往返等价,也是不可预期的副作用。
  if (sameTool) {
    return asset.content;
  }
  const data = {
    name: asset.id,
    description: asset.title,
    metadata: { scope: asset.scope },
  };
  if (Array.isArray(asset.tags) && asset.tags.length) {
    data.metadata.type = asset.tags[0];
  }
  return B.serializeFrontmatter(data, asset.content, '');
}

/** MEMORY.md 索引维护:缺行才补,已有指向同文件的行就不动。 */
function _planIndexUpdate(root, targetRel, asset, env) {
  const memRel = _memoryDirRel(env);
  if (!targetRel.startsWith(`${memRel}/`)) {
    return null;
  }
  const indexRel = `${memRel}/${MEMORY_INDEX_FILE}`;
  const fileName = path.basename(targetRel);
  if (fileName === MEMORY_INDEX_FILE) {
    return null;
  }
  const indexAbs = path.join(root, indexRel);
  const current = B.readText(indexAbs);
  const line = `- [${asset.title || asset.id}](${fileName}) — ${(asset.content || '').split(/\r?\n/).find((l) => l.trim()) || asset.id}`;
  if (current && current.includes(`(${fileName})`)) {
    return null;
  }
  const next = current ? `${current.replace(/\s*$/, '')}\n${line}\n` : `# Memory Index\n\n${line}\n`;
  return { rel: indexRel, abs: indexAbs, content: next, reason: '把新记忆登记进 MEMORY.md 索引' };
}

// ── tool ────────────────────────────────────────────────────────────────

function _settingsWithMcp(root) {
  for (const name of SETTINGS_FILES) {
    const abs = path.join(root, name);
    const doc = B.readJson(abs);
    if (doc && !doc._parseError && doc.mcpServers && typeof doc.mcpServers === 'object') {
      return { name, abs, doc };
    }
  }
  const abs = path.join(root, SETTINGS_FILES[0]);
  const doc = B.readJson(abs);
  return { name: SETTINGS_FILES[0], abs, doc: doc && !doc._parseError ? doc : {} };
}

/**
 * 列出 mcp_server 型工具。凭据在出口处一律抹掉。
 * @param {Record<string,string>} [env]
 */
function listTools(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const assets = [];
  for (const name of SETTINGS_FILES) {
    const abs = path.join(d.root, name);
    const doc = B.readJson(abs);
    if (!doc || doc._parseError || !doc.mcpServers || typeof doc.mcpServers !== 'object') {
      continue;
    }
    for (const serverName of Object.keys(doc.mcpServers)) {
      const native = doc.mcpServers[serverName];
      // 路径不带 `spec.` 前缀:回写时 restoreRedacted 拿到的就是 spec 对象本身。
      const red = M.redactCredentials(native);
      const built = M.validateAsset('tool', {
        name: serverName,
        kind: 'mcp_server',
        description: String((native && native.description) || ''),
        spec: red.value && typeof red.value === 'object' ? red.value : {},
        updatedAt: B.mtimeIso(abs),
        source: {
          tool: TOOL_ID,
          path: name,
          format: 'json:mcpServers',
          redactedFields: red.redactedFields,
        },
        raw: {},
      });
      if (built.ok) {
        assets.push(built.asset);
      }
    }
  }
  return { ok: true, assets, root: d.root };
}

// ── skill ───────────────────────────────────────────────────────────────

function _readSkill(root, skillName) {
  const dirRel = `skills/${skillName}`;
  const dirAbs = path.join(root, dirRel);
  const entryAbs = path.join(dirAbs, SKILL_ENTRY_FILE);
  if (!B.isFile(entryAbs)) {
    return null;
  }
  const files = B.walkFiles(dirAbs, { maxDepth: 4 });
  const contents = {};
  const binaryFiles = [];
  for (const rel of files) {
    const abs = path.join(dirAbs, rel);
    const ext = path.extname(rel).toLowerCase();
    const text = TEXT_EXTS.includes(ext) ? B.readText(abs) : null;
    if (text !== null && Buffer.byteLength(text, 'utf8') <= MAX_INLINE_BYTES) {
      contents[rel] = text;
    } else {
      binaryFiles.push(rel);
    }
  }
  const fm = B.parseFrontmatter(contents[SKILL_ENTRY_FILE] || '');
  const built = M.validateAsset('skill', {
    name: String(fm.data.name || skillName),
    description: String(fm.data.description || ''),
    entry: SKILL_ENTRY_FILE,
    files: files.filter((f) => f !== SKILL_ENTRY_FILE),
    contents,
    metadata: fm.data && typeof fm.data === 'object' ? fm.data : {},
    updatedAt: B.mtimeIso(entryAbs),
    source: { tool: TOOL_ID, path: dirRel, format: 'dir:SKILL.md' },
    raw: { binaryFiles, frontmatterText: fm.raw },
  });
  return built.ok ? built.asset : null;
}

/**
 * 列出技能(skills/<name>/SKILL.md)。
 * @param {Record<string,string>} [env]
 */
function listSkills(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const skillsDir = path.join(d.root, 'skills');
  if (!B.isDir(skillsDir)) {
    return { ok: true, assets: [], root: d.root };
  }
  const assets = [];
  for (const rel of B.walkFiles(skillsDir, { exts: ['.md'], maxDepth: 1 })) {
    if (path.basename(rel) !== SKILL_ENTRY_FILE) {
      continue;
    }
    const a = _readSkill(d.root, path.dirname(rel));
    if (a) {
      assets.push(a);
    }
  }
  return { ok: true, assets, root: d.root };
}

// ── 统一读写接口 ────────────────────────────────────────────────────────

const _LISTERS = Object.freeze({ memory: listMemories, tool: listTools, skill: listSkills });

/**
 * 按身份读单个资产。
 * @param {'memory'|'tool'|'skill'} kind
 * @param {string} id
 * @param {Record<string,string>} [env]
 */
function readAsset(kind, id, env) {
  const lister = _LISTERS[String(kind || '').trim()];
  if (!lister) {
    return { ok: false, error: `${LABEL} 不支持的资产类型:${kind || '(空)'}`, unsupported: true };
  }
  const listed = lister(env);
  if (!listed.ok) {
    return listed;
  }
  const want = String(id || '').trim();
  const hit = listed.assets.find(
    (a) => M.assetIdentity(a) === want || a.id === want || a.name === want
  );
  if (!hit) {
    return { ok: false, error: `${LABEL} 中未找到 ${kind}:${want}` };
  }
  return { ok: true, asset: hit };
}

/**
 * 写单个资产。dryRun 默认为真——调用方必须显式传 false 才落盘。
 * 返回 plan 列出每个将被写的相对路径与原因,便于干跑审阅。
 *
 * @param {'memory'|'tool'|'skill'} kind
 * @param {object} asset
 * @param {{ dryRun?: boolean }} [opts]
 * @param {Record<string,string>} [env]
 */
function writeAsset(kind, asset, opts, env) {
  const dryRun = !(opts && opts.dryRun === false);
  const validated = M.validateAsset(kind, asset);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const a = validated.asset;
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked };
  }

  const writes = [];
  if (a.kind === 'memory') {
    const rel = _memoryTargetRel(a, env);
    const sameTool = (a.source && a.source.tool) === TOOL_ID && Boolean(a.source.path);
    writes.push({
      rel,
      abs: path.join(d.root, rel),
      content: _renderMemory(a, sameTool),
      reason: '写入记忆正文',
    });
    const idx = _planIndexUpdate(d.root, rel, a, env);
    if (idx) {
      writes.push(idx);
    }
  } else if (a.kind === 'tool') {
    if (a.toolKind !== 'mcp_server') {
      return {
        ok: false,
        unsupported: true,
        error: `${LABEL} 只能承载 mcp_server 型工具,收到 ${a.toolKind}（未写入任何文件）`,
      };
    }
    const target = _settingsWithMcp(d.root);
    const doc = target.doc && typeof target.doc === 'object' ? target.doc : {};
    const servers = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {};
    const existing = servers[a.name];
    // 先铺 raw(厂商私有字段),再覆盖被映射的共性字段,最后把凭据路径填回目标现值。
    const merged = Object.assign({}, a.raw && a.raw.native, a.spec);
    const restored = M.restoreRedacted(merged, existing, a.source.redactedFields);
    const nextDoc = Object.assign({}, doc, {
      mcpServers: Object.assign({}, servers, { [a.name]: restored }),
    });
    writes.push({
      rel: target.name,
      abs: target.abs,
      content: `${JSON.stringify(nextDoc, null, 2)}\n`,
      reason: `合并 mcpServers.${a.name}（凭据字段沿用目标侧现值）`,
    });
  } else if (a.kind === 'skill') {
    const src = (a.source && a.source.tool) === TOOL_ID && a.source.path ? a.source.path : '';
    const dirRel = src || `skills/${String(a.name).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
    const entryText = a.contents[a.entry];
    if (typeof entryText !== 'string') {
      return {
        ok: false,
        error: `技能「${a.name}」缺少主文件内容(contents['${a.entry}'])，未写入任何文件`,
      };
    }
    writes.push({
      rel: `${dirRel}/${SKILL_ENTRY_FILE}`,
      abs: path.join(d.root, dirRel, SKILL_ENTRY_FILE),
      content: entryText,
      reason: '写入技能主文件',
    });
    for (const rel of Object.keys(a.contents)) {
      if (rel === a.entry) {
        continue;
      }
      writes.push({
        rel: `${dirRel}/${rel}`,
        abs: path.join(d.root, dirRel, rel),
        content: a.contents[rel],
        reason: '写入技能附属资源',
      });
    }
  }

  const plan = writes.map((w) => ({ path: w.rel, reason: w.reason, bytes: Buffer.byteLength(w.content, 'utf8') }));
  if (dryRun) {
    return { ok: true, dryRun: true, tool: TOOL_ID, kind: a.kind, plan, written: [] };
  }
  const written = [];
  for (const w of writes) {
    if (!B.writeText(w.abs, w.content)) {
      return { ok: false, error: `写入失败:${w.rel}`, tool: TOOL_ID, plan, written };
    }
    written.push(w.rel);
  }
  return { ok: true, dryRun: false, tool: TOOL_ID, kind: a.kind, plan, written };
}

/**
 * 删单个资产。dryRun 默认为真。
 * @param {'memory'|'tool'|'skill'} kind
 * @param {string} id
 * @param {{ dryRun?: boolean }} [opts]
 * @param {Record<string,string>} [env]
 */
function removeAsset(kind, id, opts, env) {
  const dryRun = !(opts && opts.dryRun === false);
  const found = readAsset(kind, id, env);
  if (!found.ok) {
    return found;
  }
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked };
  }
  const a = found.asset;
  const rel = a.source.path;
  if (!rel) {
    return { ok: false, error: `资产 ${id} 没有来源路径,无法定位删除目标` };
  }
  if (a.kind === 'tool') {
    const target = _settingsWithMcp(d.root);
    const doc = target.doc && typeof target.doc === 'object' ? target.doc : {};
    const servers = Object.assign({}, doc.mcpServers);
    delete servers[a.name];
    const plan = [{ path: target.name, reason: `从 mcpServers 移除 ${a.name}` }];
    if (dryRun) {
      return { ok: true, dryRun: true, tool: TOOL_ID, plan, removed: [] };
    }
    const nextDoc = Object.assign({}, doc, { mcpServers: servers });
    const wrote = B.writeText(target.abs, `${JSON.stringify(nextDoc, null, 2)}\n`);
    return wrote
      ? { ok: true, dryRun: false, tool: TOOL_ID, plan, removed: [target.name] }
      : { ok: false, error: `写入失败:${target.name}`, tool: TOOL_ID, plan, removed: [] };
  }

  const abs = path.join(d.root, rel);
  const plan = [{ path: rel, reason: a.kind === 'skill' ? '删除整个技能目录' : '删除记忆文件' }];
  if (dryRun) {
    return { ok: true, dryRun: true, tool: TOOL_ID, plan, removed: [] };
  }
  const ok = a.kind === 'skill' ? B.removeDir(abs) : B.removeFile(abs);
  return ok
    ? { ok: true, dryRun: false, tool: TOOL_ID, plan, removed: [rel] }
    : { ok: false, error: `删除失败:${rel}`, tool: TOOL_ID, plan, removed: [] };
}

module.exports = {
  TOOL_ID,
  LABEL,
  ROOT_ENV_KEYS,
  detect,
  capabilities,
  listMemories,
  listTools,
  listSkills,
  readAsset,
  writeAsset,
  removeAsset,
};
