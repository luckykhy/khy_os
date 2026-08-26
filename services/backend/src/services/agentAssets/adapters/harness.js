'use strict';

/**
 * adapters/harness.js — 通用 agent harness 约定的资产适配器。
 *
 * 「harness」在本仓不指某个具体产品(仓内 agenticHarnessService 是 khy 自己的 harness,
 * cliAnythingService 的 `_source:'harness'` 指内置 CLI 来源,两者都不是外部 agent 工具),
 * 故本适配器对接的是 agent 工具间**共享的文件约定**——AGENTS.md + 同级资产目录:
 *   AGENTS.md                全局指令(scope=global 的单份记忆)
 *   memory/<id>.md           逐项记忆
 *   tools.json               工具清单(**只读**,见下)
 *   skills/<name>/SKILL.md   目录型技能
 *   skills/<name>.md         单文件型技能
 *
 * 根目录完全由环境变量决定(KHY_AGENT_ASSETS_HARNESS_ROOT / AGENT_HARNESS_HOME),
 * 若「harness」在某处指某个具体产品,只需改本文件的候选清单一处,其余各层不动。
 *
 * tools 声明为**可读不可写**:harness 的 tools.json 由 harness 自己在启动时生成,
 * khy 写进去下一次启动就被覆盖——那种写入是假的成功。契约要求缺失能力显式声明为
 * 不支持而非抛异常,故 writeAsset('tool',…) 返回 { ok:false, unsupported:true } 并说明原因。
 */

const path = require('path');

const B = require('../_adapterBase');
const M = require('../assetModel');

const TOOL_ID = 'harness';
const LABEL = '通用 agent harness';

const ROOT_ENV_KEYS = Object.freeze(['KHY_AGENT_ASSETS_HARNESS_ROOT', 'AGENT_HARNESS_HOME']);

const GLOBAL_MEMORY_FILE = 'AGENTS.md';
const MEMORY_DIR = 'memory';
const SKILLS_DIR = 'skills';
const SKILL_ENTRY_FILE = 'SKILL.md';
const TOOLS_FILE = 'tools.json';

const TEXT_EXTS = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.py', '.sh']);
const MAX_INLINE_BYTES = 256 * 1024;

/** tools.json 里 kind 字段到 IR tool.kind 的映射;未知一律归 local_command。 */
const TOOL_KIND_MAP = Object.freeze({
  mcp: 'mcp_server',
  mcp_server: 'mcp_server',
  command: 'local_command',
  local: 'local_command',
  local_command: 'local_command',
  builtin: 'builtin',
});

// ── detect / capabilities ───────────────────────────────────────────────

/**
 * 探测资产根。绝不硬编码盘符/用户名——全部由 env 与主目录推算。
 * @param {Record<string,string>} [env]
 */
function detect(env) {
  const e = env || process.env;
  return B.probeRoot({
    env: e,
    envKeys: ROOT_ENV_KEYS,
    candidates: [
      { path: path.join(B.xdgConfigHome(e), 'agent-harness'), why: 'XDG 配置目录下的 agent-harness' },
      { path: path.join(B.homeDir(e), '.agent-harness'), why: '主目录下的 .agent-harness' },
      { path: path.join(B.homeDir(e), '.agents'), why: '主目录下的 .agents(AGENTS.md 约定)' },
    ],
  });
}

/**
 * 能力声明:tool 明确不可写。
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
      memory: { read: true, write: true, note: '读写 AGENTS.md + memory/*.md' },
      tool: {
        read: true,
        write: false,
        note: 'tools.json 由 harness 自己生成,写入会被下次启动覆盖,故声明不可写',
      },
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
  const data = (fm.data && typeof fm.data === 'object' ? fm.data : {});
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
 * 列出记忆。
 * @param {Record<string,string>} [env]
 */
function listMemories(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const assets = [];
  if (B.isFile(path.join(d.root, GLOBAL_MEMORY_FILE))) {
    const a = _memoryFromFile(d.root, GLOBAL_MEMORY_FILE, 'global');
    if (a) {
      assets.push(a);
    }
  }
  const memDir = path.join(d.root, MEMORY_DIR);
  if (B.isDir(memDir)) {
    for (const rel of B.walkFiles(memDir, { exts: ['.md'], maxDepth: 2 })) {
      const a = _memoryFromFile(d.root, `${MEMORY_DIR}/${rel}`, 'project');
      if (a) {
        assets.push(a);
      }
    }
  }
  return { ok: true, assets, root: d.root };
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

// ── tool(只读)────────────────────────────────────────────────────────

/**
 * 列出工具清单。tools.json 允许两种形态:数组 [{name,kind,…}] 或映射 {name:{…}}。
 * @param {Record<string,string>} [env]
 */
function listTools(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const abs = path.join(d.root, TOOLS_FILE);
  const doc = B.readJson(abs);
  if (doc === null) {
    return { ok: true, assets: [], root: d.root };
  }
  if (doc._parseError) {
    return { ok: false, error: `${TOOLS_FILE} 解析失败:${doc._parseError}` };
  }
  const entries = Array.isArray(doc)
    ? doc.map((v) => [String((v && v.name) || ''), v])
    : Object.keys(doc).map((k) => [k, doc[k]]);

  const assets = [];
  for (const [name, native] of entries) {
    if (!name) {
      continue;
    }
    const declared = String((native && (native.kind || native.type)) || '').toLowerCase();
    // 路径不带 `spec.` 前缀:回写时 restoreRedacted 拿到的就是 spec 对象本身。
    const red = M.redactCredentials(native);
    const built = M.validateAsset('tool', {
      name,
      kind: TOOL_KIND_MAP[declared] || 'local_command',
      description: String((native && native.description) || ''),
      spec: red.value && typeof red.value === 'object' ? red.value : {},
      updatedAt: B.mtimeIso(abs),
      source: {
        tool: TOOL_ID,
        path: TOOLS_FILE,
        format: Array.isArray(doc) ? 'json:array' : 'json:map',
        redactedFields: red.redactedFields,
      },
      raw: {},
    });
    if (built.ok) {
      assets.push(built.asset);
    }
  }
  return { ok: true, assets, root: d.root };
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
 * 列出技能:skills/<name>/SKILL.md 优先,同级散装 skills/<name>.md 也收。
 * @param {Record<string,string>} [env]
 */
function listSkills(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const skillsDir = path.join(d.root, SKILLS_DIR);
  if (!B.isDir(skillsDir)) {
    return { ok: true, assets: [], root: d.root };
  }
  const assets = [];
  for (const rel of B.walkFiles(skillsDir, { exts: ['.md'], maxDepth: 1 })) {
    const dir = path.dirname(rel);
    if (dir === '.') {
      const a = _skillFromFile(d.root, `${SKILLS_DIR}/${rel}`);
      if (a) {
        assets.push(a);
      }
      continue;
    }
    if (path.basename(rel) !== SKILL_ENTRY_FILE) {
      continue;
    }
    const a = _skillFromDir(d.root, `${SKILLS_DIR}/${dir}`);
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
  return hit ? { ok: true, asset: hit } : { ok: false, error: `${LABEL} 中未找到 ${kind}:${want}` };
}

function _slug(v) {
  return String(v || '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * 写单个资产。dryRun 默认为真;tool 类明确不支持(不抛,回 unsupported)。
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
  if (a.kind === 'tool') {
    return {
      ok: false,
      unsupported: true,
      tool: TOOL_ID,
      error: `${LABEL} 的 ${TOOLS_FILE} 由 harness 自己生成,声明为不可写——未写入任何文件`,
    };
  }
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked };
  }
  const sameTool = (a.source && a.source.tool) === TOOL_ID && a.source.path;
  const writes = [];

  if (a.kind === 'memory') {
    const rel = sameTool ? a.source.path : `${MEMORY_DIR}/${_slug(a.id)}.md`;
    writes.push({
      rel,
      abs: path.join(d.root, rel),
      content: _renderMemory(a, Boolean(sameTool)),
      reason: '写入记忆正文',
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
        abs: path.join(d.root, rel),
        content: entryText,
        reason: '写入单文件型技能',
      });
    } else {
      const dirRel = sameTool ? a.source.path : `${SKILLS_DIR}/${_slug(a.name)}`;
      writes.push({
        rel: `${dirRel}/${SKILL_ENTRY_FILE}`,
        abs: path.join(d.root, dirRel, SKILL_ENTRY_FILE),
        content: entryText,
        reason: '写入目录型技能主文件',
      });
      for (const extra of extras) {
        writes.push({
          rel: `${dirRel}/${extra}`,
          abs: path.join(d.root, dirRel, extra),
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
 * 删单个资产。dryRun 默认为真;tool 类不可写故亦不可删。
 * @param {'memory'|'tool'|'skill'} kind
 * @param {string} id
 * @param {{ dryRun?: boolean }} [opts]
 * @param {Record<string,string>} [env]
 */
function removeAsset(kind, id, opts, env) {
  const dryRun = !(opts && opts.dryRun === false);
  if (String(kind || '').trim() === 'tool') {
    return {
      ok: false,
      unsupported: true,
      tool: TOOL_ID,
      error: `${LABEL} 的 ${TOOLS_FILE} 声明为不可写,故亦不支持删除`,
    };
  }
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
  const isDirSkill = a.kind === 'skill' && a.source.format === 'dir:SKILL.md';
  const plan = [{ path: rel, reason: isDirSkill ? '删除整个技能目录' : '删除资产文件' }];
  if (dryRun) {
    return { ok: true, dryRun: true, tool: TOOL_ID, plan, removed: [] };
  }
  const abs = path.join(d.root, rel);
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
