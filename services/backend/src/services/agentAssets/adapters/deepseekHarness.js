'use strict';

/**
 * adapters/deepseekHarness.js — DeepSeek Harness(dsh)的资产适配器。
 *
 * 磁盘布局(据上游 packages/util/home-paths 与 packages/skill/skill-filesystem 的
 * README 实测确认,不是猜的):
 *   <dshHome>/skills/<name>/SKILL.md   目录型技能(单层,上游**刻意排除**嵌套发现)
 *   <dshHome>/skills/<name>.md         单文件型技能
 *   <dshHome>/cordis.patch.yml         用户层插件补丁,MCP 服务器写在这里
 *
 * 根目录:KHY_AGENT_ASSETS_DSH_ROOT 覆盖 > $DSH_HOME > 主目录下的 .dsh。与 opencode
 * 适配器同一约定——只有 khy 自己的覆盖变量进 envKeys(指错了硬报错),外部工具自己
 * 的变量只做候选(指错了继续往下找)。
 *
 * 三类能力刻意不一致,每条都有实证理由:
 *
 *   memory:**不支持**。dsh 没有第一方记忆存储——全仓递归扫描只在 examples/mcp-memory/
 *     找到三份 MCP 服务器示例配置(engram / memorix / mcp-reference-memory),
 *     记忆整体委托给 MCP 服务器。契约要求「缺失的能力显式声明为不支持,而不是抛异常」,
 *     故此处如实声明 unsupported 并说明委托对象,不假装能读写、也不返回空列表
 *     (空列表会被上层读成「装了但一条都没有」,与「这家根本不存这类资产」是两回事)。
 *
 *   tool:**可读不可写**。MCP 服务器是 cordis.patch.yml 里的插件行,那是用户手写的
 *     YAML,含注释、锚点与 `!!js` 动态表达式。js-yaml 只能 load 后 dump,dump 会丢注释、
 *     把 `!!js process.env.X` 压成字面量——那是有损写入。与其静默毁掉用户的配置,
 *     不如显式声明不可写(与 harness 适配器的 tools.json 同一判断)。
 *
 *   skill:**可读可写**。纯 Markdown + frontmatter,无损。
 *
 * 安全:dsh 的凭据集中在 .credentials.yaml 与 .env(见 NEVER_READ)。这两个文件本
 * 适配器**从不读取**——不在任何遍历路径上(walkFiles 跳过点目录,工具只读 cordis*.yml、
 * 技能只读 skills/),也不出现在任何返回值里。
 */

const path = require('path');

const yaml = require('js-yaml');

const B = require('../_adapterBase');
const M = require('../assetModel');

const TOOL_ID = 'deepseek-harness';
const LABEL = 'DeepSeek Harness';

const ROOT_ENV_KEYS = Object.freeze(['KHY_AGENT_ASSETS_DSH_ROOT']);

const HOME_DIR_NAME = '.dsh';
const SKILLS_DIR = 'skills';
const SKILL_ENTRY_FILE = 'SKILL.md';
const PATCH_FILES = Object.freeze([
  'cordis.patch.yml',
  'cordis.patch.yaml',
  'cordis.yml',
  'cordis.yaml',
]);

/** 上游 MCP 客户端插件包名;认它来把插件行识别成 mcp_server 型工具。 */
const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';

/**
 * 凭据文件清单:**只用于文档与自检断言,永远不作为读取目标**。
 * 写成导出常量而不是注释,是为了让测试能断言「这些名字不出现在任何返回值里」。
 */
const NEVER_READ = Object.freeze(['.credentials.yaml', '.credentials.yml', '.env']);

const TEXT_EXTS = Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.py', '.sh']);
const MAX_INLINE_BYTES = 256 * 1024;

/**
 * `!!js <expr>` 自定义标签。cordis 允许在 config / disabled 里写 JS 表达式,
 * js-yaml 的安全 schema 认不得这个标签会**整篇**解析失败——那会让「只有一行动态配置」
 * 的用户整个工具列表读不出来。这里把表达式原样保留成带前缀的字符串:既不执行
 * (安全 schema 不会构造函数),也不丢弃(表达式只是对 process.env 的引用,不含密钥本身;
 * 真正的密钥值仍由 redactCredentials 按键名/值形态兜底)。
 */
const JS_EXPR_PREFIX = '!!js ';
const _jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => `${JS_EXPR_PREFIX}${data === null || data === undefined ? '' : data}`,
});
const _DSH_SCHEMA = yaml.Schema.create(yaml.DEFAULT_SAFE_SCHEMA, [_jsExprType]);

/** 解析 YAML。不存在返 null;解析失败返 { _parseError },与 _adapterBase.readJson 同形。 */
function _loadYaml(file) {
  const text = B.readText(file);
  if (text === null) {
    return null;
  }
  try {
    const doc = yaml.safeLoad(text, { schema: _DSH_SCHEMA, json: true });
    return { _doc: doc === undefined ? null : doc };
  } catch (e) {
    return { _parseError: (e && e.message) || String(e) };
  }
}

// ── detect / capabilities ───────────────────────────────────────────────

/**
 * 探测资产根。绝不硬编码盘符/用户名——全部由 env 与主目录推算。
 * @param {Record<string,string>} [env]
 */
function detect(env) {
  const e = env || process.env;
  const candidates = [];
  const nativeHome = String((e && e.DSH_HOME) || '').trim();
  if (nativeHome) {
    candidates.push({ path: B.expandHome(nativeHome, e), why: '环境变量 DSH_HOME' });
  }
  candidates.push({
    path: path.join(B.homeDir(e), HOME_DIR_NAME),
    why: `主目录下的 ${HOME_DIR_NAME}（上游默认)`,
  });
  return B.probeRoot({ env: e, envKeys: ROOT_ENV_KEYS, candidates });
}

/**
 * 能力声明。三类各不相同,理由见文件头。
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
        read: false,
        write: false,
        note: 'dsh 无第一方记忆存储,记忆整体委托给 MCP 服务器(见上游 examples/mcp-memory)',
      },
      tool: {
        read: true,
        write: false,
        note: 'MCP 插件行在手写 YAML 里(含注释与 !!js 表达式),dump 回写有损,故只读',
      },
      skill: {
        read: true,
        write: true,
        note: 'skills/<name>/SKILL.md 或 skills/<name>.md（上游刻意只认单层)',
      },
    },
    rootEnvKeys: ROOT_ENV_KEYS.slice(),
    neverRead: NEVER_READ.slice(),
  };
}

// ── memory:显式不支持 ──────────────────────────────────────────────────

/**
 * dsh 没有第一方记忆存储。返回 unsupported 而不是抛异常,也不返回空列表。
 * @param {Record<string,string>} [env]
 */
function listMemories(env) {
  const d = detect(env);
  return {
    ok: false,
    unsupported: true,
    error:
      `${LABEL} 不存储记忆资产:上游把记忆整体委托给 MCP 服务器` +
      '(engram / memorix / mcp-reference-memory),本地没有可读写的记忆文件。' +
      '要迁移记忆请改用该 MCP 服务器自己的存储。',
    checked: d.ok
      ? [{ location: d.root, exists: true, why: '资产根已找到,但该根下不存在记忆布局' }]
      : d.checked,
  };
}

// ── tool:cordis 插件行 ─────────────────────────────────────────────────

/** 找出第一个存在的 cordis 配置文件(用户补丁优先于主配置)。 */
function _patchTarget(root) {
  for (const name of PATCH_FILES) {
    const abs = path.join(root, name);
    if (B.isFile(abs)) {
      return { name, abs };
    }
  }
  return null;
}

/**
 * 递归找出所有 MCP 插件行。刻意**不**依赖补丁文件的外层信封形状(顶层数组 /
 * insert 列表 / 嵌套 group 都可能),只认「对象里 name 是 MCP 插件包名」——上游把
 * cordis 标成 developer preview 且明说会破坏性变更,按信封形状硬解析迟早失效。
 */
function _collectMcpRows(node, out, depth) {
  if (depth > B.WALK_MAX_DEPTH || out.length >= 200) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      _collectMcpRows(item, out, depth + 1);
    }
    return;
  }
  if (!node || typeof node !== 'object') {
    return;
  }
  if (String(node.name || '').trim() === MCP_PLUGIN_NAME) {
    out.push(node);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === '__proto__') {
      continue;
    }
    _collectMcpRows(node[key], out, depth + 1);
  }
}

/**
 * 列出 MCP 型工具。
 * @param {Record<string,string>} [env]
 */
function listTools(env) {
  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked, unsupported: false };
  }
  const target = _patchTarget(d.root);
  if (!target) {
    return { ok: true, assets: [], root: d.root };
  }
  const loaded = _loadYaml(target.abs);
  if (loaded && loaded._parseError) {
    return { ok: false, error: `${target.name} 解析失败:${loaded._parseError}` };
  }
  const rows = [];
  _collectMcpRows(loaded && loaded._doc, rows, 0);

  const assets = [];
  for (const row of rows) {
    const config = row.config && typeof row.config === 'object' ? row.config : {};
    const name = String(config.serverName || row.id || '').trim();
    if (!name) {
      continue;
    }
    // 路径不带 `spec.` 前缀:回写时 restoreRedacted 拿到的就是 spec 对象本身。
    const red = M.redactCredentials(config);
    // raw 同样要过脱敏:它会随 IR 一起流到别的工具去。
    const rawRed = M.redactCredentials({
      pluginName: String(row.name || ''),
      pluginId: String(row.id || ''),
      disabled: row.disabled === undefined ? null : row.disabled,
      file: target.name,
    });
    const built = M.validateAsset('tool', {
      name,
      kind: 'mcp_server',
      description: String(config.description || row.description || ''),
      spec: red.value && typeof red.value === 'object' ? red.value : {},
      updatedAt: B.mtimeIso(target.abs),
      source: {
        tool: TOOL_ID,
        path: target.name,
        format: 'yaml:cordis-plugin',
        redactedFields: red.redactedFields,
      },
      raw: rawRed.value && typeof rawRed.value === 'object' ? rawRed.value : {},
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

/**
 * 列出技能。**只扫单层**——上游 skill-filesystem 明说嵌套发现是刻意排除的,
 * 多扫一层会把 dsh 自己根本不会加载的东西报成技能。上游跳过的 `.system` 子目录
 * 由 walkFiles「跳过点目录」顺带排除,无需特例。
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

/** dsh 要求技能名 kebab-case,跨工具导入时按它的规矩取落盘名(不改 IR 里的原名)。 */
function _kebab(v) {
  const out = String(v || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'skill';
}

/**
 * 写单个资产。dryRun 默认为真;memory 与 tool 明确不支持(不抛,回 unsupported)。
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

  if (a.kind === 'memory') {
    return {
      ok: false,
      unsupported: true,
      error: `${LABEL} 不存储记忆资产(记忆委托给 MCP 服务器),未写入任何文件`,
    };
  }
  if (a.kind === 'tool') {
    return {
      ok: false,
      unsupported: true,
      error:
        `${LABEL} 的 MCP 配置是手写 YAML(含注释与 !!js 动态表达式),` +
        'dump 回写会丢注释并把表达式压成字面量——那是有损写入,故声明不可写,未写入任何文件。' +
        `请手动把该服务器加进 ${PATCH_FILES[0]}。`,
    };
  }

  const d = detect(env);
  if (!d.ok) {
    return { ok: false, error: d.error, checked: d.checked };
  }
  const entryText = a.contents[a.entry];
  if (typeof entryText !== 'string') {
    return {
      ok: false,
      error: `技能「${a.name}」缺少主文件内容(contents['${a.entry}'])，未写入任何文件`,
    };
  }
  const sameTool = (a.source && a.source.tool) === TOOL_ID && a.source.path;
  const extras = Object.keys(a.contents).filter((f) => f !== a.entry);
  const asFile = sameTool ? a.source.format === 'file:md' : extras.length === 0;
  const writes = [];
  if (asFile) {
    const rel = sameTool ? a.source.path : `${SKILLS_DIR}/${_kebab(a.name)}.md`;
    writes.push({ rel, abs: path.join(d.root, rel), content: entryText, reason: '写入单文件型技能' });
  } else {
    const dirRel = sameTool ? a.source.path : `${SKILLS_DIR}/${_kebab(a.name)}`;
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
 * 删单个资产。dryRun 默认为真;只允许删技能——另两类本就声明为不可写,
 * 「读得到但删得掉」会是比不支持更糟的半吊子能力。
 * @param {'memory'|'tool'|'skill'} kind
 * @param {string} id
 * @param {{ dryRun?: boolean }} [opts]
 * @param {Record<string,string>} [env]
 */
function removeAsset(kind, id, opts, env) {
  const dryRun = !(opts && opts.dryRun === false);
  const k = String(kind || '').trim();
  if (k !== 'skill') {
    return {
      ok: false,
      unsupported: true,
      error: `${LABEL} 只允许删除技能资产(${k || '(空)'} 类在本适配器里是只读的),未删除任何文件`,
    };
  }
  const found = readAsset(k, id, env);
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
  const isDirSkill = a.source.format === 'dir:SKILL.md';
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
  NEVER_READ,
  JS_EXPR_PREFIX,
  detect,
  capabilities,
  listMemories,
  listTools,
  listSkills,
  readAsset,
  writeAsset,
  removeAsset,
};
