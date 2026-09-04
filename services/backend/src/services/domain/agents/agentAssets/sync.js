'use strict';

/**
 * sync.js — 外部 agent 资产的导入/导出/双向同步编排层。
 *
 * 编排层**完全不认识任何一家工具**:它只拿两个注册表 id(源 / 目标),经 registry
 * 解析出适配器,再按统一契约 listMemories / listTools / listSkills / writeAsset 搬运。
 * 故 import/export/sync 三个动作
 * 是同一段代码的三种参数:
 *   import  = 外部工具 → khy-os        (from=<tool>, to='khy-os')
 *   export  = khy-os   → 外部工具      (from='khy-os', to=<tool>)
 *   sync    = 两个方向各跑一遍          (A→B 与 B→A)
 * 顺带免费得到 tool↔tool 直接迁移——那才是用户真正的痛点(A 工具沉淀的记忆换到
 * B 工具等于清零)。
 *
 * 四条不可协商的行为:
 *   1. 干跑优先:dryRun 默认为**真**,调用方必须显式传 false 才落盘。
 *   2. 绝不静默覆盖:同名不同内容一律判冲突,默认 keep-both——目标侧原资产一字不动,
 *      来侧内容另存为冲突副本(名字内嵌内容哈希前 8 位,故重复同步幂等),
 *      并在返回值的 conflicts[] 里逐条列出。
 *   3. 状态透明:每处理一项都经 onProgress 回报「动作 + 目标 + 进度」三个维度,
 *      形如「正在导入 opencode 记忆 3/17:项目约定」。
 *   4. 活动感知超时:不按总时长硬杀。每完成一项就刷新 lastActivity,只有**连续无进展**
 *      超过 idleTimeoutMs 才中止,且错误里说明卡在哪一步的第几项。
 *
 * 本模块不自称纯叶子:它经适配器碰磁盘。判定逻辑本身都在 assetModel 那个纯叶子里。
 */

const M = require('./assetModel');
const registry = require('../../../../cli/commands/registry');

/** 默认空闲超时:连续 60 秒没有任何一项取得进展才认为卡死。 */
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000;

const _KIND_LISTERS = Object.freeze({
  memory: 'listMemories',
  tool: 'listTools',
  skill: 'listSkills',
});

const _KIND_LABELS = Object.freeze({ memory: '记忆', tool: '工具', skill: '技能' });

/** 规整 kinds 入参:缺省 = 三类全要;过滤掉未知类型。 */
function _resolveKinds(kinds) {
  if (!Array.isArray(kinds) || !kinds.length) {
    return M.ASSET_KINDS.slice();
  }
  const out = [];
  for (const k of kinds) {
    const key = String(k || '').trim();
    if (M.ASSET_KINDS.includes(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

function _emit(onProgress, payload) {
  if (typeof onProgress !== 'function') {
    return;
  }
  try {
    onProgress(payload);
  } catch {
    /* 回调是观测通道,它自己炸不该影响搬运 */
  }
}

/**
 * 「动作 + 目标 + 进度」三维状态文案(工程红线 2)。
 * @returns {string} 形如「正在导入 opencode 记忆 3/17:项目约定」
 */
function formatProgress(action, toolLabel, kind, index, total, name) {
  const kindLabel = _KIND_LABELS[kind] || kind;
  const suffix = name ? `:${name}` : '';
  return `正在${action} ${toolLabel} ${kindLabel} ${index}/${total}${suffix}`;
}

/**
 * 列出某一家工具的全部(或指定类型)资产。适配器探测失败 → 该家标记未检测到,
 * **不让整条链路失败**(本机没装某个工具是常态)。
 *
 * @param {string} toolId
 * @param {{ kinds?: string[], env?: object, onProgress?: Function }} [opts]
 * @returns {{ ok: boolean, tool: string, label: string, detected: boolean, assets: object[], byKind: object, error?: string, checked?: object[] }}
 */
function listTool(toolId, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const resolved = registry.resolveAdapter(toolId, env);
  if (!resolved.ok) {
    return { ok: false, tool: String(toolId || ''), label: '', detected: false, assets: [], byKind: {}, error: resolved.error };
  }
  const { adapter, source } = resolved;

  let detection;
  try {
    detection = adapter.detect(env) || { ok: false, error: 'detect() 无返回值' };
  } catch (e) {
    detection = { ok: false, error: `detect 异常:${(e && e.message) || e}` };
  }
  if (!detection.ok) {
    return {
      ok: true,
      tool: source.id,
      label: source.label,
      detected: false,
      assets: [],
      byKind: {},
      error: detection.error || '未检测到该工具',
      checked: detection.checked || [],
    };
  }

  const kinds = _resolveKinds(o.kinds);
  const assets = [];
  const byKind = {};
  const errors = [];
  for (const kind of kinds) {
    const method = _KIND_LISTERS[kind];
    let res;
    try {
      res = adapter[method](env);
    } catch (e) {
      res = { ok: false, error: `${method} 异常:${(e && e.message) || e}` };
    }
    if (!res || res.ok !== true) {
      byKind[kind] = [];
      errors.push(`${_KIND_LABELS[kind]}:${(res && res.error) || '读取失败'}`);
      continue;
    }
    const list = Array.isArray(res.assets) ? res.assets : [];
    byKind[kind] = list;
    for (const a of list) {
      assets.push(a);
    }
    _emit(o.onProgress, {
      phase: 'list',
      tool: source.id,
      kind,
      index: list.length,
      total: list.length,
      message: `已读取 ${source.label} ${_KIND_LABELS[kind]} ${list.length}/${list.length} 项`,
    });
  }

  return {
    ok: true,
    tool: source.id,
    label: source.label,
    detected: true,
    root: detection.root,
    assets,
    byKind,
    error: errors.length ? errors.join('；') : '',
  };
}

/**
 * 全景发现:所有已注册工具 × 指定资产类型。未安装的工具占一行并说明找过哪些位置。
 *
 * @param {{ kinds?: string[], tools?: string[], env?: object, onProgress?: Function }} [opts]
 */
function discover(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (!M.isEnabled(env)) {
    return { ok: false, error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)', tools: [] };
  }
  const ids = Array.isArray(o.tools) && o.tools.length ? o.tools : registry.listSourceIds(env);
  const tools = [];
  let totalAssets = 0;
  for (const id of ids) {
    const one = listTool(id, { kinds: o.kinds, env, onProgress: o.onProgress });
    const counts = {};
    for (const kind of Object.keys(one.byKind || {})) {
      counts[kind] = one.byKind[kind].length;
    }
    totalAssets += one.assets.length;
    tools.push({
      tool: one.tool,
      label: one.label,
      detected: one.detected,
      root: one.root || '',
      counts,
      total: one.assets.length,
      error: one.error || '',
      checked: one.checked || [],
    });
  }
  return { ok: true, tools, totalAssets };
}

/** 按身份建索引。 */
function _indexByIdentity(list) {
  const map = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    const key = M.assetIdentity(a);
    if (key) {
      map.set(key, a);
    }
  }
  return map;
}

/**
 * 单向计划:逐项判定 create / in-sync / conflict,不落任何盘。
 * 这是 transfer 的判定内核,单独导出以便「先看计划再决定」。
 *
 * @param {{ from: string, to: string, kinds?: string[], env?: object }} opts
 */
function plan(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (!M.isEnabled(env)) {
    return { ok: false, error: '外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)' };
  }
  const src = listTool(o.from, { kinds: o.kinds, env });
  if (!src.ok) {
    return { ok: false, error: src.error };
  }
  if (!src.detected) {
    return {
      ok: true,
      from: src.tool,
      to: String(o.to || ''),
      skipped: true,
      reason: `未检测到源工具 ${src.label || src.tool}:${src.error}`,
      items: [],
    };
  }
  const dst = listTool(o.to, { kinds: o.kinds, env });
  if (!dst.ok) {
    return { ok: false, error: dst.error };
  }
  if (!dst.detected) {
    return {
      ok: true,
      from: src.tool,
      to: dst.tool || String(o.to || ''),
      skipped: true,
      reason: `未检测到目标工具 ${dst.label || o.to}:${dst.error}`,
      items: [],
    };
  }

  const kinds = _resolveKinds(o.kinds);
  const items = [];
  for (const kind of kinds) {
    const targetIndex = _indexByIdentity(dst.byKind[kind]);
    for (const asset of src.byKind[kind] || []) {
      const identity = M.assetIdentity(asset);
      const decision = M.decideSync(asset, targetIndex.get(identity) || null);
      items.push({
        kind,
        identity,
        name: asset.title || asset.name || asset.id || identity,
        action: decision.action,
        reason: decision.reason,
        newer: decision.newer,
        sourceHash: decision.sourceHash,
        targetHash: decision.targetHash,
      });
    }
  }
  return {
    ok: true,
    from: src.tool,
    to: dst.tool,
    fromLabel: src.label,
    toLabel: dst.label,
    skipped: false,
    items,
    summary: _summarize(items),
  };
}

function _summarize(items) {
  const out = { total: items.length, create: 0, 'in-sync': 0, conflict: 0, noop: 0 };
  for (const it of items) {
    if (out[it.action] === undefined) {
      out[it.action] = 0;
    }
    out[it.action] += 1;
  }
  return out;
}

/**
 * 把冲突资产改名成冲突副本(绝不覆盖目标侧原资产)。
 * memory 改 id + 落点路径;tool/skill 改 name + 落点路径。
 */
function _asConflictCopy(asset, sourceTool, hash) {
  const copy = JSON.parse(JSON.stringify(asset));
  const suffixName = M.conflictCopyName(
    asset.kind === 'memory' ? asset.id : asset.name,
    sourceTool,
    hash
  );
  if (asset.kind === 'memory') {
    copy.id = suffixName;
    copy.title = `${asset.title || asset.id}（来自 ${sourceTool} 的冲突副本）`;
  } else {
    copy.name = suffixName;
  }
  // 落点必须改名,否则会写回同一个文件 = 覆盖。source.path 清成冲突副本路径,
  // 并把 tool 置成目标侧未知值,迫使适配器走「跨工具导入」的托管落点。
  copy.source = Object.assign({}, asset.source, {
    path: asset.source && asset.source.path
      ? M.conflictCopyPath(asset.source.path, sourceTool, hash)
      : '',
  });
  copy.raw = Object.assign({}, asset.raw, { frontmatterText: '', conflictOf: M.assetIdentity(asset) });
  return copy;
}

/**
 * 单向搬运。dryRun 默认为真。
 *
 * @param {object} opts
 * @param {string} opts.from 源工具 id
 * @param {string} opts.to 目标工具 id
 * @param {string[]} [opts.kinds] 资产类型,缺省三类全要
 * @param {boolean} [opts.dryRun=true] 显式传 false 才落盘
 * @param {'keep-both'|'skip'} [opts.onConflict='keep-both']
 * @param {Function} [opts.onProgress] 逐项进度回调
 * @param {number} [opts.idleTimeoutMs] 空闲超时(无进展多久算卡死)
 * @param {string} [opts.action='同步'] 进度文案里的动作词
 * @param {object} [opts.env]
 */
function transfer(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const dryRun = !(o.dryRun === false);
  const onConflict = o.onConflict === 'skip' ? 'skip' : 'keep-both';
  const idleTimeoutMs = Number.isFinite(o.idleTimeoutMs) ? o.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
  const action = String(o.action || '同步');

  const planned = plan({ from: o.from, to: o.to, kinds: o.kinds, env });
  if (!planned.ok) {
    return planned;
  }
  if (planned.skipped) {
    return {
      ok: true,
      dryRun,
      from: planned.from,
      to: planned.to,
      skipped: true,
      reason: planned.reason,
      applied: [],
      conflicts: [],
      summary: { total: 0 },
    };
  }

  const resolvedTo = registry.resolveAdapter(o.to, env);
  if (!resolvedTo.ok) {
    return { ok: false, error: resolvedTo.error };
  }
  const src = listTool(o.from, { kinds: o.kinds, env });
  const srcIndex = {};
  for (const kind of Object.keys(src.byKind || {})) {
    srcIndex[kind] = _indexByIdentity(src.byKind[kind]);
  }

  const todo = planned.items.filter((it) => it.action === 'create' || it.action === 'conflict');
  const total = todo.length;
  const applied = [];
  const conflicts = [];
  const failures = [];

  // 活动感知超时:每完成一项刷新 lastActivity。只有连续无进展才中止,
  // 且报错说明卡在第几项、哪一步——固定总时长硬杀会把「慢但在动」误判成卡死。
  let lastActivity = Date.now();
  let lastStep = '开始搬运';

  for (let i = 0; i < total; i += 1) {
    const item = todo[i];
    const idleFor = Date.now() - lastActivity;
    if (idleFor > idleTimeoutMs) {
      return {
        ok: false,
        dryRun,
        from: planned.from,
        to: planned.to,
        error: `连续 ${Math.round(idleFor / 1000)} 秒无进展,已中止。卡在第 ${i + 1}/${total} 项(${_KIND_LABELS[item.kind] || item.kind}「${item.name}」)的「${lastStep}」步骤`,
        applied,
        conflicts,
        summary: _summarize(planned.items),
      };
    }

    _emit(o.onProgress, {
      phase: 'transfer',
      tool: planned.to,
      kind: item.kind,
      index: i + 1,
      total,
      action: item.action,
      message: formatProgress(action, planned.fromLabel, item.kind, i + 1, total, item.name),
    });

    const asset = (srcIndex[item.kind] || new Map()).get(item.identity);
    if (!asset) {
      failures.push({ kind: item.kind, identity: item.identity, error: '源侧资产在计划后消失' });
      continue;
    }

    let payload = asset;
    if (item.action === 'conflict') {
      if (onConflict === 'skip') {
        conflicts.push({
          kind: item.kind,
          identity: item.identity,
          name: item.name,
          resolution: 'skip',
          reason: item.reason,
          newer: item.newer,
        });
        lastActivity = Date.now();
        lastStep = '跳过冲突项';
        continue;
      }
      payload = _asConflictCopy(asset, planned.from, item.sourceHash);
      conflicts.push({
        kind: item.kind,
        identity: item.identity,
        name: item.name,
        resolution: 'keep-both',
        copyIdentity: M.assetIdentity(payload),
        reason: item.reason,
        newer: item.newer,
      });
    }

    lastStep = dryRun ? '生成写入计划' : '落盘写入';
    let res;
    try {
      res = resolvedTo.adapter.writeAsset(item.kind, payload, { dryRun }, env);
    } catch (e) {
      res = { ok: false, error: `writeAsset 异常:${(e && e.message) || e}` };
    }
    if (!res || res.ok !== true) {
      failures.push({
        kind: item.kind,
        identity: item.identity,
        error: (res && res.error) || '写入失败',
        unsupported: Boolean(res && res.unsupported),
      });
      lastActivity = Date.now();
      continue;
    }
    applied.push({
      kind: item.kind,
      identity: M.assetIdentity(payload),
      action: item.action,
      plan: res.plan || [],
      written: res.written || [],
    });
    lastActivity = Date.now();
  }

  return {
    ok: true,
    dryRun,
    from: planned.from,
    to: planned.to,
    fromLabel: planned.fromLabel,
    toLabel: planned.toLabel,
    skipped: false,
    applied,
    conflicts,
    failures,
    summary: Object.assign(_summarize(planned.items), {
      appliedCount: applied.length,
      conflictCount: conflicts.length,
      failureCount: failures.length,
    }),
  };
}

/**
 * import:外部工具 → khy-os。
 * @param {{ from: string, kinds?: string[], dryRun?: boolean, onProgress?: Function, env?: object }} opts
 */
function importAssets(opts) {
  const o = opts || {};
  return transfer(Object.assign({}, o, { to: 'khy-os', action: '导入' }));
}

/**
 * export:khy-os → 外部工具。
 * @param {{ to: string, kinds?: string[], dryRun?: boolean, onProgress?: Function, env?: object }} opts
 */
function exportAssets(opts) {
  const o = opts || {};
  return transfer(Object.assign({}, o, { from: 'khy-os', action: '导出' }));
}

/**
 * sync:双向。两个方向各跑一遍,冲突清单合并回报。任一方向未检测到工具都不算失败。
 *
 * @param {{ a?: string, b?: string, kinds?: string[], dryRun?: boolean, onProgress?: Function, env?: object }} opts
 */
function syncAssets(opts) {
  const o = opts || {};
  const a = String(o.a || o.from || '').trim();
  const b = String(o.b || o.to || 'khy-os').trim();
  if (!a) {
    return { ok: false, error: '缺少同步的一侧工具 id(参数 a)' };
  }
  const forward = transfer(Object.assign({}, o, { from: a, to: b, action: '同步' }));
  if (!forward.ok) {
    return { ok: false, error: forward.error, directions: [forward] };
  }
  const backward = transfer(Object.assign({}, o, { from: b, to: a, action: '回流同步' }));
  if (!backward.ok) {
    return { ok: false, error: backward.error, directions: [forward, backward] };
  }
  return {
    ok: true,
    dryRun: forward.dryRun,
    a,
    b,
    directions: [forward, backward],
    conflicts: [].concat(forward.conflicts || [], backward.conflicts || []),
    summary: {
      appliedCount: (forward.applied || []).length + (backward.applied || []).length,
      conflictCount: (forward.conflicts || []).length + (backward.conflicts || []).length,
      failureCount: (forward.failures || []).length + (backward.failures || []).length,
    },
  };
}

module.exports = {
  DEFAULT_IDLE_TIMEOUT_MS,
  formatProgress,
  listTool,
  discover,
  plan,
  transfer,
  importAssets,
  exportAssets,
  syncAssets,
};
