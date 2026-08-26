'use strict';

/**
 * adapters/khyOs.js — khy-os 自己那一侧的资产库,走**同一套适配器契约**。
 *
 * 为什么 khy-os 也是一个适配器:import 是「外部工具 → khy-os」、export 是反向、
 * sync 是双向。若把 khy-os 这侧特殊对待,编排层就得为它写一条分支,注册表也就
 * 不再厂商无关了。让它实现同一份契约后,编排层只认识「源 id → 目标 id」,
 * import/export/sync 三个动作退化成同一段代码的三种参数——tool↔tool 直接迁移
 * (用户真正的痛点:A 工具沉淀的记忆换到 B 工具等于清零)也顺带免费得到。
 *
 * 布局(<dataHome>/agent-assets/,与 harness 同约定,便于用户手改):
 *   AGENTS.md                全局记忆
 *   memory/<id>.md           逐项记忆
 *   tools.json               工具清单(本侧**可写**——这是 khy 自己的库)
 *   skills/<name>/SKILL.md   目录型技能
 *   skills/<name>.md         单文件型技能
 *
 * 根目录:KHY_AGENT_ASSETS_LOCAL_ROOT 覆盖 > <dataHome>/agent-assets。与外部工具
 * 不同,本侧根目录**不存在时按需创建**——那是 khy 自己的数据家,不是别人的地盘。
 */

const path = require('path');

const B = require('../_adapterBase');
const M = require('../assetModel');

const TOOL_ID = 'khy-os';
const LABEL = 'khy-os 本地资产库';

const ROOT_ENV_KEYS = Object.freeze(['KHY_AGENT_ASSETS_LOCAL_ROOT']);
const STORE_DIR = 'agent-assets';

const GLOBAL_MEMORY_FILE = 'AGENTS.md';
const MEMORY_DIR = 'memory';
const SKILLS_DIR = 'skills';
const SKILL_ENTRY_FILE = 'SKILL.md';
const TOOLS_FILE = 'tools.json';

const TEXT_EXTS = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.py', '.sh']);
const MAX_INLINE_BYTES = 256 * 1024;

/** 解析根目录(不判存在)。dataHome 不可用时退到主目录下的 .khy,绝不抛。 */
function _rootPath(env) {
  const e = env || process.env;
  const override = String((e && e.KHY_AGENT_ASSETS_LOCAL_ROOT) || '').trim();
  if (override) {
    return B.expandHome(override, e);
  }
  try {
    return path.join(require('../../../utils/dataHome').getDataHome(), STORE_DIR);
  } catch {
    return path.join(B.homeDir(e), '.khy', STORE_DIR);
  }
}

/**
 * 探测。本侧目录不存在也算「可用」(写入时按需创建),但仍如实回报是否已建立,
 * 以及查了哪个位置——保持与外部适配器同形的返回值。
 * @param {Record<string,string>} [env]
 */
function detect(env) {
  const root = _rootPath(env);
  const exists = B.isDir(root);
  return {
    ok: true,
    root,
    via: (env || process.env).KHY_AGENT_ASSETS_LOCAL_ROOT ? 'env:KHY_AGENT_ASSETS_LOCAL_ROOT' : 'dataHome',
    established: exists,
    checked: [{ location: root, exists, why: 'khy-os 本地资产库(不存在则写入时创建)' }],
  };
}

/**
 * 能力声明:三类全读全写(这是 khy 自己的库)。
 * @param {Record<string,string>} [env]
 */
function capabilities(env) {
  const d = detect(env);
  return {
    id: TOOL_ID,
    label: LABEL,
    detected: true,
    root: d.root,
    kinds: {
      memory: { read: true, write: true, note: 'AGENTS.md + memory/*.md' },
      tool: { read: true, write: true, note: 'tools.json（映射形态）' },
      skill: { read: true, write: true, note: 'skills/<name>/SKILL.md 或 skills/<name>.md' },
    },
    rootEnvKeys: ROOT_ENV_KEYS.slice(),
  };
}

// ── memory ──────────────────────────────────────────────────────────────

function _memoryFromFile(root, relPath, fallbackScope) {
  const abs = path.join(root, relPath);
  const text = B.readText(abs);
  if (text === null) {
    return null;
  }
  const fm = B.parseFrontmatter(text);
  const data = fm.data && typeof fm.data === 'object' ? fm.data : {};
  const stem = path.basename(relPath, path.extname(relPath));
  const declaredScope = String(data.scope || '').trim();
  const built = M.validateAsset('memory', {
    id: String(data.id || data.name || stem),
    scope: M.MEMORY_SCOPES.includes(declaredScope) ? declaredScope : fallbackScope,
    title: String(data.title || data.name || stem),
    content: fm.body,
    tags: Array.isArray(data.tags) ? data.tags : [],
    updatedAt: String(data.updatedAt || '') || B.mtimeIso(abs),
    source: { tool: TOOL_ID, path: relPath, format: 'markdown+frontmatter' },
    raw: { frontmatter: data, frontmatterText: fm.raw, frontmatterParsed: fm.parsed },
  });
  return built.ok ? built.asset : null;
}

/**
 * 列出记忆。库还没建立 → 空列表(不是错误)。
 * @param {Record<string,string>} [env]
 */
function listMemories(env) {
  const root = _rootPath(env);
  const assets = [];
  if (B.isFile(path.join(root, GLOBAL_MEMORY_FILE))) {
    const a = _memoryFromFile(root, GLOBAL_MEMORY_FILE, 'global');
    if (a) {
      assets.push(a);
    }
  }
  const memDir = path.join(root, MEMORY_DIR);
  if (B.isDir(memDir)) {
    for (const rel of B.walkFiles(memDir, { exts: ['.md'], maxDepth: 2 })) {
      const a = _memoryFromFile(root, `${MEMORY_DIR}/${rel}`, 'project');
      if (a) {
        assets.push(a);
      }
    }
  }
  return { ok: true, assets, root };
}

function _renderMemory(asset, sameTool) {
  const raw = (asset && asset.raw) || {};
  if (raw.frontmatterText) {
    return B.serializeFrontmatter(null, asset.content, raw.frontmatterText);
  }
  // 来处本就没有 frontmatter(用户手写的 AGENTS.md 就是这样)→ 原地写回时正文逐字节
  // 回吐,绝不替人插一段 frontmatter:那既破坏往返等价,也是不可预期的副作用。
  if (sameTool) {
    return asset.content;
  }
  const data = { id: asset.id, title: asset.title, scope: asset.scope };
  if (Array.isArray(asset.tags) && asset.tags.length) {
    data.tags = asset.tags;
  }
  if (asset.updatedAt) {
    data.updatedAt = asset.updatedAt;
  }
  return B.serializeFrontmatter(data, asset.content, '');
}

// ── tool ────────────────────────────────────────────────────────────────

/**
 * 列出工具(tools.json 映射形态)。
 * @param {Record<string,string>} [env]
 */
function listTools(env) {
  const root = _rootPath(env);
  const abs = path.join(root, TOOLS_FILE);
  const doc = B.readJson(abs);
  if (doc === null) {
    return { ok: true, assets: [], root };
  }
  if (doc._parseError) {
    return { ok: false, error: `${TOOLS_FILE} 解析失败:${doc._parseError}` };
  }
  const assets = [];
  for (const name of Object.keys(doc)) {
    const native = doc[name];
    // 路径不带 `spec.` 前缀:回写时 restoreRedacted 拿到的就是 spec 对象本身。
    const red = M.redactCredentials(native);
    const spec = red.value && typeof red.value === 'object' ? red.value : {};
    const built = M.validateAsset('tool', {
      name,
      kind: M.TOOL_KINDS.includes(String(spec.kind || '')) ? String(spec.kind) : 'mcp_server',
      description: String(spec.description || ''),
      spec,
      updatedAt: B.mtimeIso(abs),
      source: {
        tool: TOOL_ID,
        path: TOOLS_FILE,
        format: 'json:map',
        redactedFields: red.redactedFields,
      },
      raw: {},
    });
    if (built.ok) {
      assets.push(built.asset);
    }
  }
  return { ok: true, assets, root };
}

// ── skill ───────────────────────────────────────────────────────────────

function _skillFromDir(root, dirRel) {
  const dirAbs = path.join(root, dirRel);
  if (!B.isFile(path.join(dirAbs, SKILL_ENTRY_FILE))) {
    return null;
  }
  const files = B.walkFiles(dirAbs, { maxDepth: 4 });
  const contents = {};
  const binaryFiles = [];
  for (const rel of files) {
    const text = TEXT_EXTS.includes(path.extname(rel).toLowerCase())
      ? B.readText(path.join(dirAbs, rel))
      : null;
    if (text !== null && Buffer.byteLength(text, 'utf8') <= MAX_INLINE_BYTES) {
      contents[rel] = text;
    } else {
      binaryFiles.push(rel);
    }
  }
  const fm = B.parseFrontmatter(contents[SKILL_ENTRY_FILE] || '');
  const data = fm.data && typeof fm.data === 'object' ? fm.data : {};
  const built = M.validateAsset('skill', {
    name: String(data.name || path.basename(dirRel)),
    description: String(data.description || ''),
    entry: SKILL_ENTRY_FILE,
    files: files.filter((f) => f !== SKILL_ENTRY_FILE),
    contents,
    metadata: data,
    updatedAt: B.mtimeIso(path.join(dirAbs, SKILL_ENTRY_FILE)),
    source: { tool: TOOL_ID, path: dirRel, format: 'dir:SKILL.md' },
    raw: { binaryFiles, frontmatterText: fm.raw },
  });
  return built.ok ? built.asset : null;
}

function _skillFromFile(root, relPath) {
  const abs = path.join(root, relPath);
  const text = B.readText(abs);
  if (text === null) {
    return null;
  }
  const base = path.basename(relPath);
  const fm = B.parseFrontmatter(text);
  const data = fm.data && typeof fm.data === 'object' ? fm.data : {};
  const built = M.validateAsset('skill', {
    name: String(data.name || path.basename(relPath, path.extname(relPath))),
    description: String(data.description || ''),
    entry: base,
    files: [],
    contents: { [base]: text },
    metadata: data,
    updatedAt: B.mtimeIso(abs),
    source: { tool: TOOL_ID, path: relPath, format: 'file:md' },
    raw: { binaryFiles: [], frontmatterText: fm.raw },
  });
  return built.ok ? built.asset : null;
}

/**
 * 列出技能。
 * @param {Record<string,string>} [env]
 */
function listSkills(env) {
  const root = _rootPath(env);
  const skillsDir = path.join(root, SKILLS_DIR);
  if (!B.isDir(skillsDir)) {
    return { ok: true, assets: [], root };
  }
  const assets = [];
  for (const rel of B.walkFiles(skillsDir, { exts: ['.md'], maxDepth: 1 })) {
    const dir = path.dirname(rel);
    if (dir === '.') {
      const a = _skillFromFile(root, `${SKILLS_DIR}/${rel}`);
      if (a) {
        assets.push(a);
      }
      continue;
    }
    if (path.basename(rel) !== SKILL_ENTRY_FILE) {
      continue;
    }
    const a = _skillFromDir(root, `${SKILLS_DIR}/${dir}`);
    if (a) {
      assets.push(a);
    }
  }
  return { ok: true, assets, root };
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
  return hit ? { ok: true, asset: hit } : { ok: false, error: `${LABEL} 中未找到 ${kind}:${want}` };
}

function _slug(v) {
  return String(v || '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * 写单个资产。dryRun 默认为真。
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
  const root = _rootPath(env);
  const sameTool = (a.source && a.source.tool) === TOOL_ID && a.source.path;
  const writes = [];

  if (a.kind === 'memory') {
    const rel = sameTool ? a.source.path : `${MEMORY_DIR}/${_slug(a.id)}.md`;
    writes.push({
      rel,
      abs: path.join(root, rel),
      content: _renderMemory(a, Boolean(sameTool)),
      reason: '写入记忆正文',
    });
  } else if (a.kind === 'tool') {
    const abs = path.join(root, TOOLS_FILE);
    const doc = B.readJson(abs);
    if (doc && doc._parseError) {
      return { ok: false, error: `${TOOLS_FILE} 解析失败,拒绝写入:${doc._parseError}` };
    }
    const base = doc && typeof doc === 'object' ? doc : {};
    const merged = Object.assign({}, a.raw && a.raw.native, a.spec, {
      kind: a.toolKind,
      description: a.description,
    });
    const restored = M.restoreRedacted(merged, base[a.name], a.source.redactedFields);
    const nextDoc = Object.assign({}, base, { [a.name]: restored });
    writes.push({
      rel: TOOLS_FILE,
      abs,
      content: `${JSON.stringify(nextDoc, null, 2)}\n`,
      reason: `合并工具 ${a.name}（凭据字段沿用目标侧现值）`,
    });
  } else {
    const entryText = a.contents[a.entry];
    if (typeof entryText !== 'string') {
      return {
        ok: false,
        error: `技能「${a.name}」缺少主文件内容(contents['${a.entry}'])，未写入任何文件`,
      };
    }
    const extras = Object.keys(a.contents).filter((f) => f !== a.entry);
    const asFile = sameTool ? a.source.format === 'file:md' : extras.length === 0;
    if (asFile) {
      const rel = sameTool ? a.source.path : `${SKILLS_DIR}/${_slug(a.name)}.md`;
      writes.push({
        rel,
        abs: path.join(root, rel),
        content: entryText,
        reason: '写入单文件型技能',
      });
    } else {
      const dirRel = sameTool ? a.source.path : `${SKILLS_DIR}/${_slug(a.name)}`;
      writes.push({
        rel: `${dirRel}/${SKILL_ENTRY_FILE}`,
        abs: path.join(root, dirRel, SKILL_ENTRY_FILE),
        content: entryText,
        reason: '写入目录型技能主文件',
      });
      for (const extra of extras) {
        writes.push({
          rel: `${dirRel}/${extra}`,
          abs: path.join(root, dirRel, extra),
          content: a.contents[extra],
          reason: '写入技能附属资源',
        });
      }
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
  const root = _rootPath(env);
  const a = found.asset;

  if (a.kind === 'tool') {
    const abs = path.join(root, TOOLS_FILE);
    const doc = B.readJson(abs);
    const base = doc && typeof doc === 'object' && !doc._parseError ? doc : {};
    const next = Object.assign({}, base);
    delete next[a.name];
    const plan = [{ path: TOOLS_FILE, reason: `从 tools.json 移除 ${a.name}` }];
    if (dryRun) {
      return { ok: true, dryRun: true, tool: TOOL_ID, plan, removed: [] };
    }
    const wrote = B.writeText(abs, `${JSON.stringify(next, null, 2)}\n`);
    return wrote
      ? { ok: true, dryRun: false, tool: TOOL_ID, plan, removed: [TOOLS_FILE] }
      : { ok: false, error: `写入失败:${TOOLS_FILE}`, tool: TOOL_ID, plan, removed: [] };
  }

  const rel = a.source.path;
  if (!rel) {
    return { ok: false, error: `资产 ${id} 没有来源路径,无法定位删除目标` };
  }
  const isDirSkill = a.kind === 'skill' && a.source.format === 'dir:SKILL.md';
  const plan = [{ path: rel, reason: isDirSkill ? '删除整个技能目录' : '删除资产文件' }];
  if (dryRun) {
    return { ok: true, dryRun: true, tool: TOOL_ID, plan, removed: [] };
  }
  const abs = path.join(root, rel);
  const ok = isDirSkill ? B.removeDir(abs) : B.removeFile(abs);
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
