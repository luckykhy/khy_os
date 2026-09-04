'use strict';

/**
 * adapters/openclaw.js — OpenClaw 的记忆/工具/技能资产适配器。
 *
 * 磁盘布局(据上游 docs.openclaw.ai 的 concepts/memory、tools/skills、tools/mcp
 * 三页实测确认,不是猜的):
 *   <state>/openclaw.json              主配置,`mcp.servers` 映射 → mcp_server 型工具
 *   <state>/skills/<name>/SKILL.md     状态目录级技能(上游第 4 优先级)
 *   <workspace>/skills/<name>/SKILL.md 工作区级技能(上游第 1 优先级)
 *   <workspace>/MEMORY.md              用户**手工策展**的长期事实
 *   <workspace>/USER.md                用户偏好
 *   <workspace>/memory/<日期>[-slug].md 每日笔记
 *   <workspace>/memory/imports/<来源>/  从别的 agent 工具导入的记忆
 *
 * 根目录:KHY_AGENT_ASSETS_OPENCLAW_ROOT 覆盖 > $OPENCLAW_STATE_DIR >
 * $OPENCLAW_CONFIG_PATH 所在目录 > 主目录下的 .openclaw。
 *
 * 写入落点(不改写用户策展的东西是硬约束):
 *   - 同工具往返(source.tool === 'openclaw' 且带 source.path)原地写回来处;
 *   - 跨工具导入的记忆一律落到 memory/imports/khy-os/ —— 这是**上游自己的约定**
 *     (它已经这样收 codex / claude-code / hermes 的记忆),khy 顺着它走即可,
 *     绝不去append 或重写用户的 MEMORY.md。
 *
 * 安全:openclaw.json 顶层有 `secrets` 段、mcp.servers.*.env / headers / auth 里也
 * 常混凭据。本适配器只读 `mcp.servers` 一个键(secrets 段根本不进遍历),且该键的值
 * 全量过 redactCredentials;回写时 restoreRedacted 用目标侧现值填回,占位符绝不落盘。
 *
 * `__proto__` 被上游列为保留服务器名。JSON.parse 会把它建成普通自有属性,
 * 之后 Object.assign 走 [[Set]] 会触发原型设置器——故读写两侧都显式跳过它。
 */

const path = require('path');

const B = require('../_adapterBase');
const M = require('../assetModel');

const TOOL_ID = 'openclaw';
const LABEL = 'OpenClaw';

const ROOT_ENV_KEYS = Object.freeze(['KHY_AGENT_ASSETS_OPENCLAW_ROOT']);

const STATE_DIR_NAME = '.openclaw';
const WORKSPACE_DIR = 'workspace';
const CONFIG_FILE = 'openclaw.json';
const SKILLS_DIR = 'skills';
const SKILL_ENTRY_FILE = 'SKILL.md';
const MEMORY_DIR = 'memory';
const IMPORTS_DIR = 'memory/imports/khy-os';
const CURATED_MEMORY_FILES = Object.freeze(['MEMORY.md', 'USER.md']);

/** 上游保留的服务器名;当成普通键处理会污染原型。 */
const RESERVED_SERVER_NAME = '__proto__';

/** memory/ 下不当成记忆资产读的子目录:.dreams 是面向机器的内部存储。 */
const MEMORY_SKIP_DIRS = Object.freeze(['.dreams']);

const TEXT_EXTS = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.py', '.sh']);
const MAX_INLINE_BYTES = 256 * 1024;

// ── detect / capabilities ───────────────────────────────────────────────

/**
 * 探测状态目录。绝不硬编码盘符/用户名——全部由 env 与主目录推算。
 * @param {Record<string,string>} [env]
 */
function detect(env) {
  const e = env || process.env;
  const candidates = [];
  const stateDir = String((e && e.OPENCLAW_STATE_DIR) || '').trim();
  if (stateDir) {
    candidates.push({ path: B.expandHome(stateDir, e), why: '环境变量 OPENCLAW_STATE_DIR' });
  }
  const configPath = String((e && e.OPENCLAW_CONFIG_PATH) || '').trim();
  if (configPath) {
    candidates.push({
      path: path.dirname(B.expandHome(configPath, e)),
      why: '环境变量 OPENCLAW_CONFIG_PATH 所在目录',
    });
  }
  candidates.push({
    path: path.join(B.homeDir(e), STATE_DIR_NAME),
    why: `主目录下的 ${STATE_DIR_NAME}（上游默认)`,
  });
  return B.probeRoot({ env: e, envKeys: ROOT_ENV_KEYS, candidates });
}

/** 读主配置。不存在返 { doc:{} };解析失败把错误带出来(JSON5 形态会命中这里)。 */
function _configTarget(root) {
  const abs = path.join(root, CONFIG_FILE);
  const doc = B.readJson(abs);
  if (doc === null) {
    return { name: CONFIG_FILE, abs, doc: {}, parseError: '' };
  }
  if (doc._parseError) {
    return { name: CONFIG_FILE, abs, doc: {}, parseError: doc._parseError };
  }
  return { name: CONFIG_FILE, abs, doc: doc && typeof doc === 'object' ? doc : {}, parseError: '' };
}

/**
 * 工作区目录。优先认配置里 agents.defaults.workspace 的显式声明,否则 <state>/workspace。
 * 返回**相对状态目录的相对路径**,与 source.path 的相对约定保持一致。
 */
function _workspaceRel(root) {
  const target = _configTarget(root);
  const agents = target.doc && typeof target.doc.agents === 'object' ? target.doc.agents : null;
  const defaults = agents && typeof agents.defaults === 'object' ? agents.defaults : null;
  const declared = String((defaults && defaults.workspace) || '').trim();
  if (!declared) {
    return WORKSPACE_DIR;
  }
  const rel = B.toRelPath(root, path.resolve(root, B.expandHome(declared, process.env)));
  // 声明指到状态目录之外(绝对路径或 ../)→ 退回默认:本适配器的相对路径约定
  // 撑不住越界目标,越界写入也不该悄悄发生。
  return rel && !rel.startsWith('..') ? rel : WORKSPACE_DIR;
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
      memory: {
        read: true,
        write: true,
        note: '读 MEMORY.md / USER.md / memory/*.md;跨工具导入写进 memory/imports/khy-os/',
      },
      tool: {
        read: true,
        write: true,
        note: '仅 openclaw.json 的 mcp.servers 键;配置若是 JSON5 形态则拒绝写入而非重写',
      },
      skill: { read: true, write: true, note: '<workspace>/skills 与 <state>/skills 下的 SKILL.md' },
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
  // OpenClaw 的记忆是**纯 Markdown**,上游没有 frontmatter schema。这里仍然解析一次:
  // 有 frontmatter 的(khy 自己导入进去的那些)就认它,没有的正文原样进 IR。
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
    updatedAt: B.mtimeIso(abs),
    source: { tool: TOOL_ID, path: relPath, format: 'markdown+frontmatter' },
    raw: { frontmatter: data, frontmatterText: fm.raw, frontmatterParsed: fm.parsed },
  });
  return built.ok ? built.asset : null;
}

/**
 * 列出记忆。MEMORY.md / USER.md 是用户级(global),memory/ 下的每日笔记与导入件
 * 是项目级(project)。memory/.dreams 面向机器,不当资产读。
 * @param {Record<string,string>} [env]
 */
function listMemories(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const wsRel = _workspaceRel(d.root);
  const assets = [];
  for (const name of CURATED_MEMORY_FILES) {
    const rel = `${wsRel}/${name}`;
    if (B.isFile(path.join(d.root, rel))) {
      const a = _memoryFromFile(d.root, rel, 'global');
      if (a) {
        assets.push(a);
      }
    }
  }
  const memDir = path.join(d.root, wsRel, MEMORY_DIR);
  if (B.isDir(memDir)) {
    // walkFiles 已跳过点目录,.dreams 顺带排除;这里再挡一次是为了让意图写在代码里,
    // 而不是依赖底座的实现细节。
    for (const rel of B.walkFiles(memDir, { exts: ['.md'], maxDepth: 3 })) {
      const head = rel.split('/')[0];
      if (MEMORY_SKIP_DIRS.includes(head)) {
        continue;
      }
      const a = _memoryFromFile(d.root, `${wsRel}/${MEMORY_DIR}/${rel}`, 'project');
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
  // 来处本就没有 frontmatter(OpenClaw 的记忆就是纯 Markdown)→ 原地写回时正文逐字节
  // 回吐,绝不替人插一段 frontmatter:那既破坏往返等价,也是不可预期的副作用。
  if (sameTool) {
    return asset.content;
  }
  const data = { id: asset.id, title: asset.title, scope: asset.scope };
  if (Array.isArray(asset.tags) && asset.tags.length) {
    data.tags = asset.tags;
  }
  return B.serializeFrontmatter(data, asset.content, '');
}

// ── tool ────────────────────────────────────────────────────────────────

/** 取 mcp.servers 映射(跳过保留名)。 */
function _serverMap(doc) {
  const mcp = doc && typeof doc.mcp === 'object' && doc.mcp ? doc.mcp : {};
  const servers = mcp.servers && typeof mcp.servers === 'object' ? mcp.servers : {};
  const out = {};
  for (const name of Object.keys(servers)) {
    if (name === RESERVED_SERVER_NAME) {
      continue;
    }
    out[name] = servers[name];
  }
  return out;
}

/**
 * 回写时把保留名条目原样带回。用 defineProperty 而不是普通赋值:对 `__proto__` 走
 * [[Set]] 会命中 Object.prototype 的原型设置器(污染原型且条目丢失),defineProperty
 * 直接定义自有属性,JSON.stringify 也照常吐出来 —— 保留名虽然 OpenClaw 自己不加载,
 * 但它是用户文件里的内容,不该被 khy 静默抹掉。
 */
function _carryReserved(nextServers, doc) {
  const mcp = doc && typeof doc.mcp === 'object' && doc.mcp ? doc.mcp : {};
  const servers = mcp.servers && typeof mcp.servers === 'object' ? mcp.servers : {};
  if (!Object.prototype.hasOwnProperty.call(servers, RESERVED_SERVER_NAME)) {
    return nextServers;
  }
  Object.defineProperty(nextServers, RESERVED_SERVER_NAME, {
    value: servers[RESERVED_SERVER_NAME],
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return nextServers;
}

/**
 * 列出 mcp 型工具。`mcp.servers.<name>` 形如
 * `{ url, transport, enabled, command, args, env, toolFilter, ... }`——
 * transport 只是传输方式,统一归 mcp_server,细节原样留在 spec 里(无损)。
 * @param {Record<string,string>} [env]
 */
function listTools(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const target = _configTarget(d.root);
  if (target.parseError) {
    return {
      ok: false,
      error:
        `${target.name} 解析失败:${target.parseError}` +
        '（OpenClaw 允许 JSON5 写法——注释/尾逗号/不带引号的键——但 khy 不重写这类文件,以免抹掉注释)',
    };
  }
  const servers = _serverMap(target.doc);
  const assets = [];
  for (const name of Object.keys(servers)) {
    const native = servers[name];
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
        format: 'json:mcp.servers',
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
  const entryAbs = path.join(dirAbs, SKILL_ENTRY_FILE);
  if (!B.isFile(entryAbs)) {
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
    // 上游:身份取 frontmatter.name,缺省回退目录名。
    name: String(data.name || path.basename(dirRel)),
    description: String(data.description || ''),
    entry: SKILL_ENTRY_FILE,
    files: files.filter((f) => f !== SKILL_ENTRY_FILE),
    contents,
    metadata: data,
    updatedAt: B.mtimeIso(entryAbs),
    source: { tool: TOOL_ID, path: dirRel, format: 'dir:SKILL.md' },
    raw: { binaryFiles, frontmatterText: fm.raw },
  });
  return built.ok ? built.asset : null;
}

/** 技能发现根:工作区优先于状态目录(与上游 6 级优先级里 khy 能触及的两级同序)。 */
function _skillRoots(root) {
  const wsRel = _workspaceRel(root);
  const rels = [`${wsRel}/${SKILLS_DIR}`, SKILLS_DIR];
  const out = [];
  for (const rel of rels) {
    if (!out.includes(rel) && B.isDir(path.join(root, rel))) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * 列出技能。上游允许 SKILL.md 嵌到 6 层深,故这里也扫 6 层(WALK_MAX_DEPTH),
 * 而不是像 dsh 那样只认单层——两家的发现规则不同,适配器各自照抄各自的。
 * 同名技能按「工作区优先」保留第一次见到的那份,与上游优先级一致。
 * @param {Record<string,string>} [env]
 */
function listSkills(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const assets = [];
  const seen = new Set();
  for (const rootRel of _skillRoots(d.root)) {
    const dirAbs = path.join(d.root, rootRel);
    for (const rel of B.walkFiles(dirAbs, { exts: ['.md'], maxDepth: B.WALK_MAX_DEPTH })) {
      if (path.basename(rel) !== SKILL_ENTRY_FILE) {
        continue;
      }
      const dir = path.dirname(rel);
      if (dir === '.') {
        continue;
      }
      const a = _skillFromDir(d.root, `${rootRel}/${dir}`);
      if (a && !seen.has(a.name)) {
        seen.add(a.name);
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
  return String(v || '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'asset';
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
  const wsRel = _workspaceRel(d.root);
  const sameTool = (a.source && a.source.tool) === TOOL_ID && a.source.path;
  const writes = [];

  if (a.kind === 'memory') {
    // 跨工具导入走 memory/imports/khy-os/ —— 上游自己就用 imports/<来源>/ 收别家的
    // 记忆,顺着它的约定走,既不碰用户手工策展的 MEMORY.md,也让来源一眼可见。
    const rel = sameTool ? a.source.path : `${wsRel}/${IMPORTS_DIR}/${_slug(a.id)}.md`;
    writes.push({
      rel,
      abs: path.join(d.root, rel),
      content: _renderMemory(a, Boolean(sameTool)),
      reason: sameTool ? '写入记忆正文' : '写入记忆正文(跨工具导入落到 imports/khy-os)',
    });
  } else if (a.kind === 'tool') {
    if (a.toolKind !== 'mcp_server') {
      return {
        ok: false,
        unsupported: true,
        error: `${LABEL} 只能承载 mcp_server 型工具,收到 ${a.toolKind}（未写入任何文件）`,
      };
    }
    if (a.name === RESERVED_SERVER_NAME) {
      return {
        ok: false,
        error: `${RESERVED_SERVER_NAME} 是 ${LABEL} 的保留服务器名,拒绝写入(未写入任何文件)`,
      };
    }
    const target = _configTarget(d.root);
    if (target.parseError) {
      return {
        ok: false,
        error:
          `${target.name} 解析失败,拒绝写入:${target.parseError}` +
          '（配置若含注释/尾逗号等 JSON5 写法,重写会把它们抹掉,故宁可不写)',
      };
    }
    const doc = target.doc;
    const mcp = doc.mcp && typeof doc.mcp === 'object' ? doc.mcp : {};
    const servers = _serverMap(doc);
    const merged = Object.assign({}, a.raw && a.raw.native, a.spec);
    const restored = M.restoreRedacted(merged, servers[a.name], a.source.redactedFields);
    const nextServers = _carryReserved(Object.assign({}, servers, { [a.name]: restored }), doc);
    const nextDoc = Object.assign({}, doc, {
      mcp: Object.assign({}, mcp, { servers: nextServers }),
    });
    writes.push({
      rel: target.name,
      abs: target.abs,
      content: `${JSON.stringify(nextDoc, null, 2)}\n`,
      reason: `合并 mcp.servers.${a.name}（凭据字段沿用目标侧现值）`,
    });
  } else {
    const entryText = a.contents[a.entry];
    if (typeof entryText !== 'string') {
      return {
        ok: false,
        error: `技能「${a.name}」缺少主文件内容(contents['${a.entry}'])，未写入任何文件`,
      };
    }
    // OpenClaw 只认目录型 SKILL.md,没有单文件形态——跨工具导入的单文件技能
    // 在这里一律升格成目录型,否则写下去 OpenClaw 根本不会加载。
    const dirRel = sameTool ? a.source.path : `${wsRel}/${SKILLS_DIR}/${_slug(a.name)}`;
    writes.push({
      rel: `${dirRel}/${SKILL_ENTRY_FILE}`,
      abs: path.join(d.root, dirRel, SKILL_ENTRY_FILE),
      content: entryText,
      reason: '写入目录型技能主文件',
    });
    for (const extra of Object.keys(a.contents).filter((f) => f !== a.entry)) {
      writes.push({
        rel: `${dirRel}/${extra}`,
        abs: path.join(d.root, dirRel, extra),
        content: a.contents[extra],
        reason: '写入技能附属资源',
      });
    }
  }

  const plan = writes.map((w) => ({
    path: w.rel,
    reason: w.reason,
    bytes: Buffer.byteLength(w.content, 'utf8'),
  }));
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

  if (a.kind === 'tool') {
    const target = _configTarget(d.root);
    if (target.parseError) {
      return { ok: false, error: `${target.name} 解析失败,拒绝写入:${target.parseError}` };
    }
    const doc = target.doc;
    const mcp = doc.mcp && typeof doc.mcp === 'object' ? doc.mcp : {};
    const servers = _serverMap(doc);
    delete servers[a.name];
    const plan = [{ path: target.name, reason: `从 mcp.servers 移除 ${a.name}` }];
    if (dryRun) {
      return { ok: true, dryRun: true, tool: TOOL_ID, plan, removed: [] };
    }
    const nextDoc = Object.assign({}, doc, {
      mcp: Object.assign({}, mcp, { servers: _carryReserved(servers, doc) }),
    });
    const wrote = B.writeText(target.abs, `${JSON.stringify(nextDoc, null, 2)}\n`);
    return wrote
      ? { ok: true, dryRun: false, tool: TOOL_ID, plan, removed: [target.name] }
      : { ok: false, error: `写入失败:${target.name}`, tool: TOOL_ID, plan, removed: [] };
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
  IMPORTS_DIR,
  RESERVED_SERVER_NAME,
  detect,
  capabilities,
  listMemories,
  listTools,
  listSkills,
  readAsset,
  writeAsset,
  removeAsset,
};
