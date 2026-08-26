'use strict';

/**
 * assetModel.js — 外部 agent 资产的统一中间表示(IR)与校验。纯叶子:零 IO、确定性、
 * 绝不抛、可单测(唯一 require 是 node 内置 crypto,仅用于确定性内容哈希)。
 *
 * 背景:khy 此前与外部 agent 工具的交集只覆盖「模型与连接配置」(externalApps/*Adapter)
 * 与「khy 自己的技能/记忆」(DiscoverSkillsTool / LocalMemoryRecall)。外部工具各自把
 * 记忆/工具/技能存在私有目录与私有格式里,用户在 A 工具沉淀的资产换到 B 工具等于清零。
 * 本叶子定义三类资产的**厂商无关**中间表示,让注册表与编排层完全不认识任何一家的形状。
 *
 * 无损可逆(硬要求):IR 只吃「共性字段」,任何一家的私有字段一律原样落在 `raw` 里,
 * 绝不静默丢弃。适配器回写时先铺 `raw` 再覆盖被映射的共性字段,故
 * native → IR → native 对非凭据内容逐字段等价(往返测试锁死)。
 *
 * 凭据例外(安全约束优先于无损):外部工具的配置里常混有 apiKey/token/password。
 * IR 绝不承载凭据明文——命中凭据字段的值被替换成 REDACTED 占位并把字段路径记进
 * `source.redactedFields`。回写时 restoreRedacted 用**目标侧已有的值**填回这些路径
 * (目标没有就整键删掉),因此凭据既不进 IR、也不会被占位符覆盖掉用户真实密钥。
 * 这是一处**有意的、可审计的**有损:往返对凭据不等价,对其余内容逐字段等价。
 *
 * 冲突判定:同名资产内容哈希不同即冲突,绝不自动覆盖。updatedAt 只用于「谁更新」的
 * 汇报与冲突副本命名,不用于自动择一。冲突副本名内嵌内容哈希前 8 位而非时间戳,
 * 使重复同步幂等(同一份冲突内容永远落到同一个副本名,不会每跑一次多生一个文件)。
 *
 * 门控 KHY_AGENT_ASSETS(默认开;0/false/off/no 关)。关门时 isEnabled 返 false,
 * 编排层与工具层据此明确拒绝并说明原因,不做半吊子降级。
 */

const crypto = require('crypto');

// ── 常量表(全部 frozen,供注册表/适配器/工具层共享单一真源)────────────────

/** 三类资产。新增一类资产要同时补 normalize/validate 分支,故此处刻意收紧。 */
const ASSET_KINDS = Object.freeze(['memory', 'tool', 'skill']);

/** memory.scope:global = 用户级(跨项目),project = 项目级。 */
const MEMORY_SCOPES = Object.freeze(['global', 'project']);

/** tool.kind:至少区分这三类;未知形态归 local_command 之外的 'builtin' 需显式给。 */
const TOOL_KINDS = Object.freeze(['mcp_server', 'local_command', 'builtin']);

/** 凭据占位符。IR 里出现它即表示该路径的真值从未离开外部工具的磁盘。 */
const REDACTED = '__KHY_REDACTED__';

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 凭据字段名判据(小写子串匹配)。命中即认为该键的值是机密。
 * 刻意宽松:多抹一个非机密字段的代价是那个字段不参与同步(可从报告里看到),
 * 漏抹一个机密字段的代价是密钥进 IR、进日志、进另一家工具的配置。
 */
const CREDENTIAL_KEY_HINTS = Object.freeze([
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'secretkey',
  'secret_key',
  'clientsecret',
  'client_secret',
  'secret',
  'token',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'authorization',
  'auth_token',
  'bearer',
  'session',
  'cookie',
  'privatekey',
  'private_key',
]);

/**
 * 值形态判据:即使键名无辜(如 `env.FOO`),值长得像密钥也抹掉。
 * 与 modernKeyRedaction/errorClassifier 对齐——body 字符类纳入 `-`/`_`,
 * 使 `sk-proj-…` 这类多段现代 key 整体命中。
 */
const CREDENTIAL_VALUE_RE =
  /\b(?:sk|pk|ghp|gho|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

// ── 门控 ────────────────────────────────────────────────────────────────

/**
 * 门控 KHY_AGENT_ASSETS(默认开)。flagRegistry 优先(集中优先级),
 * 取不到则回退本地 CANON 词表。绝不抛。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' && process.env) || {};
  try {
    const reg = require('./../flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      typeof reg.isFlagEnabled === 'function' &&
      reg.isRegistryEnabled(e)
    ) {
      return reg.isFlagEnabled('KHY_AGENT_ASSETS', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const v = e.KHY_AGENT_ASSETS;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function _str(v) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

function _trim(v) {
  return _str(v).trim();
}

function _isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 字符串数组规整:去空、去重、保序。非数组返 []。 */
function _strArray(v) {
  if (!Array.isArray(v)) {
    return [];
  }
  const out = [];
  for (const item of v) {
    const s = _trim(item);
    if (s && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

/**
 * ISO8601 规整。可解析 → toISOString();不可解析 → ''。
 * 冲突判定只在两侧都有合法时间戳时才谈「谁更新」。
 */
function _isoOrEmpty(v) {
  if (v === null || v === undefined || v === '') {
    return '';
  }
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : _trim(v));
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : '';
}

/** JSON 键排序序列化,使内容哈希与键序无关(不同工具写出的键序不同)。 */
function _stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(_stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${_stableStringify(value[k])}`).join(',')}}`;
}

// ── 凭据脱敏 ────────────────────────────────────────────────────────────

/**
 * 键名是否命中凭据判据。
 * @param {string} key
 * @returns {boolean}
 */
function isCredentialKey(key) {
  const k = _trim(key).toLowerCase().replace(/[\s-]+/g, '_');
  if (!k) {
    return false;
  }
  const flat = k.replace(/_/g, '');
  return CREDENTIAL_KEY_HINTS.some((hint) => {
    const h = hint.replace(/_/g, '');
    return k.includes(hint) || flat.includes(h);
  });
}

/**
 * 深度脱敏:命中凭据键名的值、或值本身长得像密钥的,一律替换为 REDACTED,
 * 并把 `a.b[0].c` 式路径记进 redactedFields。输入不被修改(返回新结构)。
 *
 * @param {any} value 任意 JSON 可序列化结构
 * @param {{ pathPrefix?: string }} [opts]
 * @returns {{ value: any, redactedFields: string[] }}
 */
function redactCredentials(value, opts) {
  const redactedFields = [];
  const prefix = _trim(opts && opts.pathPrefix);

  const walk = (node, path) => {
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${path}[${i}]`));
    }
    if (_isPlainObject(node)) {
      const out = {};
      for (const key of Object.keys(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (isCredentialKey(key)) {
          out[key] = REDACTED;
          redactedFields.push(childPath);
          continue;
        }
        out[key] = walk(node[key], childPath);
      }
      return out;
    }
    if (typeof node === 'string' && CREDENTIAL_VALUE_RE.test(node)) {
      redactedFields.push(path);
      return REDACTED;
    }
    return node;
  };

  try {
    return { value: walk(value, prefix), redactedFields };
  } catch {
    // 结构异常(循环引用等)→ 宁可整块丢弃也不放行可能含密钥的内容。
    return { value: null, redactedFields: redactedFields.slice() };
  }
}

/**
 * 回写前把被脱敏的路径还原成**目标侧已有的值**;目标没有该路径就整键删除。
 * 这保证「IR 里的 REDACTED 占位符永远不会被写进任何一家工具的配置」,
 * 也保证同步不会拿占位符覆盖掉用户真实密钥。
 *
 * @param {any} incoming 待写入的结构(可能含 REDACTED)
 * @param {any} existing 目标侧当前结构(凭据真值的来源)
 * @param {string[]} redactedFields redactCredentials 记录的路径清单
 * @returns {any} 处理后的结构(新结构,不改动入参)
 */
function restoreRedacted(incoming, existing, redactedFields) {
  const paths = Array.isArray(redactedFields) ? redactedFields.filter((p) => _trim(p)) : [];
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(incoming === undefined ? null : incoming));
  } catch {
    return incoming;
  }
  if (!paths.length) {
    return clone;
  }

  const tokenize = (p) => {
    const parts = [];
    for (const seg of _str(p).split('.')) {
      const m = seg.match(/^([^[\]]*)((?:\[\d+\])*)$/);
      if (!m) {
        return null;
      }
      if (m[1]) {
        parts.push(m[1]);
      }
      for (const idx of m[2].match(/\d+/g) || []) {
        parts.push(Number(idx));
      }
    }
    return parts.length ? parts : null;
  };

  const readAt = (root, parts) => {
    let cur = root;
    for (const part of parts) {
      if (cur === null || typeof cur !== 'object') {
        return { found: false, value: undefined };
      }
      if (!(part in cur)) {
        return { found: false, value: undefined };
      }
      cur = cur[part];
    }
    return { found: true, value: cur };
  };

  for (const p of paths) {
    const parts = tokenize(p);
    if (!parts) {
      continue;
    }
    const leaf = parts[parts.length - 1];
    const parentParts = parts.slice(0, -1);
    const parent = readAt(clone, parentParts);
    if (!parent.found || parent.value === null || typeof parent.value !== 'object') {
      continue;
    }
    const prior = readAt(existing === undefined ? null : existing, parts);
    if (prior.found && prior.value !== REDACTED) {
      parent.value[leaf] = prior.value;
    } else if (Array.isArray(parent.value) && typeof leaf === 'number') {
      parent.value.splice(leaf, 1);
    } else {
      delete parent.value[leaf];
    }
  }
  return clone;
}

// ── source(来源信息)─────────────────────────────────────────────────────

/**
 * 规整来源信息。`path` 刻意存**相对该工具资产根的相对路径**——绝对路径会把
 * 用户名/盘符带进返回值与日志,适配器自己知道根在哪,回写时再拼回去。
 *
 * `redactedFields` 的路径**相对 spec 本身**(如 `environment.API_KEY`),不带 `spec.` 前缀:
 * restoreRedacted 回写时拿到的就是 spec 对象,前缀会让路径寻址失败 → 占位符原样落盘。
 *
 * @param {object} input
 * @returns {{ tool: string, path: string, format: string, redactedFields: string[] }}
 */
function normalizeSource(input) {
  const s = _isPlainObject(input) ? input : {};
  return {
    tool: _trim(s.tool),
    path: _trim(s.path).replace(/\\/g, '/'),
    format: _trim(s.format),
    redactedFields: _strArray(s.redactedFields),
  };
}

// ── 三类资产的规整 + 校验 ────────────────────────────────────────────────

/**
 * memory:{ id, scope, title, content, tags[], source, updatedAt, raw }
 * @returns {{ ok: true, asset: object } | { ok: false, error: string }}
 */
function normalizeMemory(input) {
  if (!_isPlainObject(input)) {
    return { ok: false, error: 'memory 必须是对象' };
  }
  const id = _trim(input.id);
  if (!id) {
    return { ok: false, error: 'memory.id 不能为空' };
  }
  const scope = _trim(input.scope) || 'project';
  if (!MEMORY_SCOPES.includes(scope)) {
    return { ok: false, error: `memory.scope 非法:${scope}（仅 ${MEMORY_SCOPES.join('/')}）` };
  }
  if (typeof input.content !== 'string') {
    return { ok: false, error: 'memory.content 必须是字符串' };
  }
  return {
    ok: true,
    asset: {
      kind: 'memory',
      id,
      scope,
      title: _trim(input.title) || id,
      content: input.content,
      tags: _strArray(input.tags),
      source: normalizeSource(input.source),
      updatedAt: _isoOrEmpty(input.updatedAt),
      raw: _isPlainObject(input.raw) ? input.raw : {},
    },
  };
}

/**
 * tool:{ name, kind, description, spec, source, raw }
 * @returns {{ ok: true, asset: object } | { ok: false, error: string }}
 */
function normalizeTool(input) {
  if (!_isPlainObject(input)) {
    return { ok: false, error: 'tool 必须是对象' };
  }
  const name = _trim(input.name);
  if (!name) {
    return { ok: false, error: 'tool.name 不能为空' };
  }
  // 两种入参形态都要认:原生输入把类型放在 `kind`,已进过 IR 的资产 `kind` 恒为
  // 'tool'、真正的类型在 `toolKind`。少认后者的话,writeAsset(listTools() 的产物)
  // 会在自己的校验关卡上被判「tool 不是合法的 tool.kind」——工具类资产根本导不出去。
  const declared = _trim(input.kind);
  const kind = declared === 'tool' && _trim(input.toolKind) ? _trim(input.toolKind) : declared;
  if (!TOOL_KINDS.includes(kind)) {
    return { ok: false, error: `tool.kind 非法:${kind || '(空)'}（仅 ${TOOL_KINDS.join('/')}）` };
  }
  if (!_isPlainObject(input.spec)) {
    return { ok: false, error: 'tool.spec 必须是对象(该 kind 下的原始配置,不做有损压缩)' };
  }
  return {
    ok: true,
    asset: {
      kind: 'tool',
      name,
      toolKind: kind,
      description: _trim(input.description),
      spec: input.spec,
      source: normalizeSource(input.source),
      updatedAt: _isoOrEmpty(input.updatedAt),
      raw: _isPlainObject(input.raw) ? input.raw : {},
    },
  };
}

/**
 * skill:{ name, description, entry, files[], metadata, source, raw }
 * @returns {{ ok: true, asset: object } | { ok: false, error: string }}
 */
function normalizeSkill(input) {
  if (!_isPlainObject(input)) {
    return { ok: false, error: 'skill 必须是对象' };
  }
  const name = _trim(input.name);
  if (!name) {
    return { ok: false, error: 'skill.name 不能为空' };
  }
  const entry = _trim(input.entry).replace(/\\/g, '/');
  if (!entry) {
    return { ok: false, error: 'skill.entry 不能为空(技能主文件的相对路径)' };
  }
  const files = _strArray(input.files).map((f) => f.replace(/\\/g, '/'));
  return {
    ok: true,
    asset: {
      kind: 'skill',
      name,
      description: _trim(input.description),
      entry,
      files,
      contents: _isPlainObject(input.contents) ? input.contents : {},
      metadata: _isPlainObject(input.metadata) ? input.metadata : {},
      source: normalizeSource(input.source),
      updatedAt: _isoOrEmpty(input.updatedAt),
      raw: _isPlainObject(input.raw) ? input.raw : {},
    },
  };
}

const _NORMALIZERS = Object.freeze({
  memory: normalizeMemory,
  tool: normalizeTool,
  skill: normalizeSkill,
});

/**
 * 按 kind 分派规整 + 校验。这是编排层与适配器的唯一入口:任何资产进 IR 前必过这里。
 * @param {'memory'|'tool'|'skill'} kind
 * @param {object} input
 * @returns {{ ok: true, asset: object } | { ok: false, error: string }}
 */
function validateAsset(kind, input) {
  const k = _trim(kind);
  const fn = _NORMALIZERS[k];
  if (!fn) {
    return { ok: false, error: `未知资产类型:${k || '(空)'}（仅 ${ASSET_KINDS.join('/')}）` };
  }
  try {
    return fn(input);
  } catch (e) {
    return { ok: false, error: `资产校验异常:${(e && e.message) || e}` };
  }
}

/**
 * 资产的稳定身份(同步时用它配对两侧)。memory 用 scope+id,tool/skill 用 name。
 * @returns {string} 失败返 ''
 */
function assetIdentity(asset) {
  if (!_isPlainObject(asset)) {
    return '';
  }
  if (asset.kind === 'memory') {
    return `${_trim(asset.scope) || 'project'}:${_trim(asset.id)}`;
  }
  return _trim(asset.name);
}

/** spec 里被提升成 IR 一等字段的键。见 _hashableSpec 的「双份」说明。 */
const SPEC_PROMOTED_KEYS = Object.freeze(['kind', 'description']);

/**
 * 把 spec 规整成「可判等」的形态。剥掉两类**表示层产物**,否则它们会被当成内容差异:
 *
 *  1. 被提升的共性字段(kind / description):IR 把它们提升成一等字段,而部分目标侧
 *     (khy-os 的 tools.json 是映射形态)回写时又把它们物化回 spec 里。若不剥掉,
 *     同一个工具在「提升前」与「回写后」的 spec 一多两键 → 永远判冲突。
 *  2. 值为 REDACTED 的键:凭据从不进 IR(见文件头「凭据例外」),故「被抹掉的凭据」
 *     与「目标侧本来就没有这个键」在语义上不可区分,必须判等。两侧都会在出口处抹,
 *     所以两侧都会被剥,判等是对称的——凭据干脆不参与判等。
 */
function _hashableSpec(value) {
  if (Array.isArray(value)) {
    return value.map(_hashableSpec);
  }
  if (!_isPlainObject(value)) {
    return value === undefined ? null : value;
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (value[key] === REDACTED) {
      continue;
    }
    out[key] = _hashableSpec(value[key]);
  }
  return out;
}

/**
 * 内容哈希:只吃「语义内容」,刻意排除 source(来源路径/工具因迁移必然不同)、
 * updatedAt(mtime 因复制必然不同)与 raw(厂商私有字段不参与同名判等)。
 * 否则同一份记忆从 A 拷到 B 之后会永远判为冲突。
 *
 * 同理排除各家的**落盘形态**:技能的主文件叫什么(opencode 目录型叫 SKILL.md、
 * 单文件型叫 <name>.md)是布局而非内容,故主文件正文按固定键入哈希、文件名不入。
 * 判等必须幂等——不然「导入成功后立刻再同步」会凭空报冲突并不断生出副本文件。
 * @returns {string} sha256 hex;失败返 ''
 */
function contentHash(asset) {
  if (!_isPlainObject(asset)) {
    return '';
  }
  try {
    let payload;
    if (asset.kind === 'memory') {
      payload = {
        kind: 'memory',
        scope: _trim(asset.scope) || 'project',
        id: _trim(asset.id),
        title: _trim(asset.title),
        content: _str(asset.content),
        tags: _strArray(asset.tags).slice().sort(),
      };
    } else if (asset.kind === 'tool') {
      const spec = _hashableSpec(_isPlainObject(asset.spec) ? asset.spec : {});
      for (const key of SPEC_PROMOTED_KEYS) {
        delete spec[key];
      }
      payload = {
        kind: 'tool',
        name: _trim(asset.name),
        toolKind: _trim(asset.toolKind),
        description: _trim(asset.description),
        spec,
      };
    } else if (asset.kind === 'skill') {
      const contents = _isPlainObject(asset.contents) ? asset.contents : {};
      const entry = _trim(asset.entry);
      const extras = {};
      for (const rel of Object.keys(contents)) {
        if (rel !== entry) {
          extras[rel] = contents[rel];
        }
      }
      payload = {
        kind: 'skill',
        name: _trim(asset.name),
        description: _trim(asset.description),
        entryContent: _str(contents[entry]),
        extras,
        files: _strArray(asset.files)
          .filter((f) => f !== entry)
          .slice()
          .sort(),
        metadata: _hashableSpec(_isPlainObject(asset.metadata) ? asset.metadata : {}),
      };
    } else {
      return '';
    }
    return crypto.createHash('sha256').update(_stableStringify(payload), 'utf8').digest('hex');
  } catch {
    return '';
  }
}

// ── 冲突判定 ────────────────────────────────────────────────────────────

/**
 * 单个身份在「源侧 / 目标侧」的同步决策。绝不返回「覆盖」——内容不同一律 conflict,
 * 由调用方按 keep-both 生成冲突副本。
 *
 * @param {object|null} source 源侧资产(已过 validateAsset)
 * @param {object|null} target 目标侧同身份资产
 * @returns {{ action: 'create'|'in-sync'|'conflict'|'noop', reason: string, newer: 'source'|'target'|'unknown', sourceHash: string, targetHash: string }}
 */
function decideSync(source, target) {
  const sourceHash = source ? contentHash(source) : '';
  const targetHash = target ? contentHash(target) : '';

  if (!source && !target) {
    return { action: 'noop', reason: '两侧都不存在', newer: 'unknown', sourceHash, targetHash };
  }
  if (source && !target) {
    return { action: 'create', reason: '目标侧不存在,可直接新建', newer: 'source', sourceHash, targetHash };
  }
  if (!source && target) {
    return { action: 'noop', reason: '仅目标侧存在,本方向不动它', newer: 'target', sourceHash, targetHash };
  }
  if (sourceHash && sourceHash === targetHash) {
    return { action: 'in-sync', reason: '内容哈希一致', newer: 'unknown', sourceHash, targetHash };
  }

  const st = _isoOrEmpty(source.updatedAt);
  const tt = _isoOrEmpty(target.updatedAt);
  let newer = 'unknown';
  if (st && tt && st !== tt) {
    newer = Date.parse(st) > Date.parse(tt) ? 'source' : 'target';
  }
  const detail =
    newer === 'unknown'
      ? '两侧时间戳无法比较'
      : `${newer === 'source' ? '源侧' : '目标侧'}更新时间较晚`;
  return {
    action: 'conflict',
    reason: `同名但内容哈希不同(${detail})——保留双方,生成冲突副本`,
    newer,
    sourceHash,
    targetHash,
  };
}

/**
 * 冲突副本名。内嵌**内容哈希前 8 位**而非时间戳,故同一份冲突内容重复同步永远
 * 落到同一个副本名(幂等),不会每跑一次多生一个文件。
 *
 * @param {string} base 原身份(memory.id / tool.name / skill.name)
 * @param {string} sourceTool 冲突内容来自哪家工具
 * @param {string} hash contentHash 结果
 * @returns {string}
 */
function conflictCopyName(base, sourceTool, hash) {
  const b = _trim(base) || 'asset';
  const t = _trim(sourceTool).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const h = _trim(hash).slice(0, 8) || 'nohash';
  return `${b}.conflict-${t || 'unknown'}-${h}`;
}

/**
 * 冲突副本的文件名(保留原扩展名,后缀插在扩展名之前)。
 * @param {string} relPath 原相对路径
 * @param {string} sourceTool
 * @param {string} hash
 * @returns {string}
 */
function conflictCopyPath(relPath, sourceTool, hash) {
  const p = _trim(relPath).replace(/\\/g, '/');
  if (!p) {
    return '';
  }
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '';
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${dir}${conflictCopyName(stem, sourceTool, hash)}${ext}`;
}

module.exports = {
  ASSET_KINDS,
  MEMORY_SCOPES,
  TOOL_KINDS,
  REDACTED,
  CREDENTIAL_KEY_HINTS,
  isEnabled,
  isCredentialKey,
  redactCredentials,
  restoreRedacted,
  normalizeSource,
  normalizeMemory,
  normalizeTool,
  normalizeSkill,
  validateAsset,
  assetIdentity,
  contentHash,
  decideSync,
  conflictCopyName,
  conflictCopyPath,
};
