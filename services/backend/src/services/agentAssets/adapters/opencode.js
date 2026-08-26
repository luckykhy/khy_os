'use strict';

/**
 * adapters/opencode.js — opencode 的记忆/工具/技能资产适配器。
 *
 * 磁盘布局(XDG;与既有 externalApps/opencodeAdapter 的 configPath 同源):
 *   opencode.json            主配置,`mcp` 键 → mcp_server 型工具
 *   AGENTS.md                全局指令(scope=global 的单份记忆)
 *   memory/<id>.md           khy 托管的逐项记忆目录(跨工具导入的落点,读时一并列出)
 *   command/<name>.md        自定义命令 → 单文件型技能
 *   skill/<name>/SKILL.md    目录型技能(带附属资源时用它)
 *
 * 与 externalApps/opencodeAdapter 的分工:那个适配器只管「模型 provider 的增删改查」,
 * 本适配器只管「记忆/工具/技能」。两者刻意不合并——前者要认识 provider/models 的
 * schema 并会自愈损坏形状,后者对 opencode.json 只碰 `mcp` 一个键,读写都是保守合并。
 *
 * 写入落点:同工具往返(source.tool === 'opencode' 且带 source.path)原地写回来处;
 * 跨工具导入落到 memory/ 与 command/ 这类托管位置,绝不改写用户自己的 AGENTS.md。
 */

const path = require('path');

const B = require('../_adapterBase');
const M = require('../assetModel');

const TOOL_ID = 'opencode';
const LABEL = 'opencode';

const ROOT_ENV_KEYS = Object.freeze(['KHY_AGENT_ASSETS_OPENCODE_ROOT']);

const CONFIG_FILES = Object.freeze(['opencode.json', 'opencode.jsonc']);
const GLOBAL_MEMORY_FILE = 'AGENTS.md';
const MEMORY_DIR = 'memory';
const COMMAND_DIR = 'command';
const SKILL_DIR = 'skill';
const SKILL_ENTRY_FILE = 'SKILL.md';

const TEXT_EXTS = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.py', '.sh']);
const MAX_INLINE_BYTES = 256 * 1024;

// ── detect / capabilities ───────────────────────────────────────────────

/**
 * 探测资产根:khy 覆盖变量 > opencode 自己的 OPENCODE_CONFIG(指向配置文件,取其目录)
 * > $XDG_CONFIG_HOME/opencode > ~/.config/opencode。失败回报找过哪些位置。
 * @param {Record<string,string>} [env]
 */
function detect(env) {
  const e = env || process.env;
  const candidates = [];
  const nativeConfig = String((e && e.OPENCODE_CONFIG) || '').trim();
  if (nativeConfig) {
    candidates.push({
      path: path.dirname(B.expandHome(nativeConfig, e)),
      why: '环境变量 OPENCODE_CONFIG 所在目录',
    });
  }
  candidates.push({
    path: path.join(B.xdgConfigHome(e), TOOL_ID),
    why: 'XDG 配置目录($XDG_CONFIG_HOME/opencode)',
  });
  return B.probeRoot({ env: e, envKeys: ROOT_ENV_KEYS, candidates });
}

/**
 * 能力声明。
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
      memory: { read: true, write: true, note: '读 AGENTS.md + memory/*.md' },
      tool: { read: true, write: true, note: '仅 opencode.json 的 mcp 键' },
      skill: { read: true, write: true, note: 'command/*.md 与 skill/<name>/SKILL.md' },
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
  const stem = path.basename(relPath, path.extname(relPath));
  const declaredScope = String((fm.data && fm.data.scope) || '').trim();
  const built = M.validateAsset('memory', {
    id: String((fm.data && fm.data.name) || stem),
    scope: M.MEMORY_SCOPES.includes(declaredScope) ? declaredScope : fallbackScope,
    title: String((fm.data && fm.data.title) || (fm.data && fm.data.name) || stem),
    content: fm.body,
    tags: Array.isArray(fm.data && fm.data.tags) ? fm.data.tags : [],
    updatedAt: B.mtimeIso(abs),
    source: { tool: TOOL_ID, path: relPath, format: 'markdown+frontmatter' },
    raw: { frontmatter: fm.data, frontmatterText: fm.raw, frontmatterParsed: fm.parsed },
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
  const data = { name: asset.id, title: asset.title, scope: asset.scope };
  if (Array.isArray(asset.tags) && asset.tags.length) {
    data.tags = asset.tags;
  }
  return B.serializeFrontmatter(data, asset.content, '');
}

// ── tool ────────────────────────────────────────────────────────────────

function _configTarget(root) {
  for (const name of CONFIG_FILES) {
    const abs = path.join(root, name);
    if (B.isFile(abs)) {
      const doc = B.readJson(abs);
      return { name, abs, doc: doc && !doc._parseError ? doc : {}, parseError: doc && doc._parseError };
    }
  }
  return { name: CONFIG_FILES[0], abs: path.join(root, CONFIG_FILES[0]), doc: {}, parseError: '' };
}

/**
 * 列出 mcp 型工具。opencode 的 `mcp.<name>` 形如
 * `{ type:'local'|'remote', command:[...], environment:{...}, url, enabled }`——
 * type 只是传输方式,统一归 mcp_server,传输细节原样留在 spec 里(无损)。
 * @param {Record<string,string>} [env]
 */
function listTools(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const target = _configTarget(d.root);
  if (target.parseError) {
    return { ok: false, error: `${target.name} 解析失败:${target.parseError}` };
  }
  const mcp = target.doc && typeof target.doc.mcp === 'object' && target.doc.mcp ? target.doc.mcp : {};
  const assets = [];
  for (const name of Object.keys(mcp)) {
    const native = mcp[name];
    // 路径不带 `spec.` 前缀:回写时 restoreRedacted 拿到的就是 spec 对象本身。
    const red = M.redactCredentials(native);
    const built = M.validateAsset('tool', {
      name,
      kind: 'mcp_server',
      description: String((native && native.description) || ''),
      spec: red.value && typeof red.value === 'object' ? red.value : {},
      updatedAt: B.mtimeIso(target.abs),
      source: {
        tool: TOOL_ID,
        path: target.name,
        format: 'json:mcp',
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

function _skillFromFile(root, relPath) {
  const abs = path.join(root, relPath);
  const text = B.readText(abs);
  if (text === null) {
    return null;
  }
  const base = path.basename(relPath);
  const fm = B.parseFrontmatter(text);
  const built = M.validateAsset('skill', {
    name: String((fm.data && fm.data.name) || path.basename(relPath, path.extname(relPath))),
    description: String((fm.data && fm.data.description) || ''),
    entry: base,
    files: [],
    contents: { [base]: text },
    metadata: fm.data && typeof fm.data === 'object' ? fm.data : {},
    updatedAt: B.mtimeIso(abs),
    source: { tool: TOOL_ID, path: relPath, format: 'file:md' },
    raw: { binaryFiles: [], frontmatterText: fm.raw },
  });
  return built.ok ? built.asset : null;
}

function _skillFromDir(root, dirRel) {
  const dirAbs = path.join(root, dirRel);
  const entryAbs = path.join(dirAbs, SKILL_ENTRY_FILE);
  if (!B.isFile(entryAbs)) {
    return null;
  }
  const files = B.walkFiles(dirAbs, { maxDepth: 4 });
  const contents = {};
  const binaryFiles = [];
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const text = TEXT_EXTS.includes(ext) ? B.readText(path.join(dirAbs, rel)) : null;
    if (text !== null && Buffer.byteLength(text, 'utf8') <= MAX_INLINE_BYTES) {
      contents[rel] = text;
    } else {
      binaryFiles.push(rel);
    }
  }
  const fm = B.parseFrontmatter(contents[SKILL_ENTRY_FILE] || '');
  const built = M.validateAsset('skill', {
    name: String((fm.data && fm.data.name) || path.basename(dirRel)),
    description: String((fm.data && fm.data.description) || ''),
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
 * 列出技能:command/*.md(单文件型)+ skill/<name>/SKILL.md(目录型)。
 * @param {Record<string,string>} [env]
 */
function listSkills(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const assets = [];
  const cmdDir = path.join(d.root, COMMAND_DIR);
  if (B.isDir(cmdDir)) {
    for (const rel of B.walkFiles(cmdDir, { exts: ['.md'], maxDepth: 2 })) {
      const a = _skillFromFile(d.root, `${COMMAND_DIR}/${rel}`);
      if (a) {
        assets.push(a);
      }
    }
  }
  const skillDir = path.join(d.root, SKILL_DIR);
  if (B.isDir(skillDir)) {
    for (const rel of B.walkFiles(skillDir, { exts: ['.md'], maxDepth: 1 })) {
      if (path.basename(rel) !== SKILL_ENTRY_FILE) {
        continue;
      }
      const a = _skillFromDir(d.root, `${SKILL_DIR}/${path.dirname(rel)}`);
      if (a) {
        assets.push(a);
      }
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
  } else if (a.kind === 'tool') {
    if (a.toolKind !== 'mcp_server') {
      return {
        ok: false,
        unsupported: true,
        error: `${LABEL} 只能承载 mcp_server 型工具,收到 ${a.toolKind}（未写入任何文件）`,
      };
    }
    const target = _configTarget(d.root);
    if (target.parseError) {
      return { ok: false, error: `${target.name} 解析失败,拒绝写入:${target.parseError}` };
    }
    const doc = target.doc && typeof target.doc === 'object' ? target.doc : {};
    const mcp = doc.mcp && typeof doc.mcp === 'object' ? doc.mcp : {};
    const merged = Object.assign({}, a.raw && a.raw.native, a.spec);
    const restored = M.restoreRedacted(merged, mcp[a.name], a.source.redactedFields);
    const nextDoc = Object.assign({}, doc, {
      mcp: Object.assign({}, mcp, { [a.name]: restored }),
    });
    writes.push({
      rel: target.name,
      abs: target.abs,
      content: `${JSON.stringify(nextDoc, null, 2)}\n`,
      reason: `合并 mcp.${a.name}（凭据字段沿用目标侧现值）`,
    });
  } else if (a.kind === 'skill') {
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
      const rel = sameTool ? a.source.path : `${COMMAND_DIR}/${_slug(a.name)}.md`;
      writes.push({
        rel,
        abs: path.join(d.root, rel),
        content: entryText,
        reason: '写入单文件型技能(command/*.md)',
      });
      for (const extra of extras) {
        const dir = path.posix.dirname(rel);
        writes.push({
          rel: `${dir}/${extra}`,
          abs: path.join(d.root, dir, extra),
          content: a.contents[extra],
          reason: '写入技能附属资源',
        });
      }
    } else {
      const dirRel = sameTool ? a.source.path : `${SKILL_DIR}/${_slug(a.name)}`;
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
    const target = _configTarget(d.root);
    const doc = target.doc && typeof target.doc === 'object' ? target.doc : {};
    const mcp = Object.assign({}, doc.mcp);
    delete mcp[a.name];
    const plan = [{ path: target.name, reason: `从 mcp 移除 ${a.name}` }];
    if (dryRun) {
      return { ok: true, dryRun: true, tool: TOOL_ID, plan, removed: [] };
    }
    const nextDoc = Object.assign({}, doc, { mcp });
    const wrote = B.writeText(target.abs, `${JSON.stringify(nextDoc, null, 2)}\n`);
    return wrote
      ? { ok: true, dryRun: false, tool: TOOL_ID, plan, removed: [target.name] }
      : { ok: false, error: `写入失败:${target.name}`, tool: TOOL_ID, plan, removed: [] };
  }

  const isDirSkill = a.kind === 'skill' && a.source.format === 'dir:SKILL.md';
  const abs = path.join(d.root, rel);
  const plan = [{ path: rel, reason: isDirSkill ? '删除整个技能目录' : '删除资产文件' }];
  if (dryRun) {
    return { ok: true, dryRun: true, tool: TOOL_ID, plan, removed: [] };
  }
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
