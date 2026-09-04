'use strict';

/**
 * External agent asset CLI — `khy agent-assets …`.
 *
 * 薄壳:所有判定与搬运都在 services/agentAssets/(sync 编排层 + 各家适配器 +
 * assetModel 纯叶子),本文件只负责「把结果排版给人看」。故新增一家外部工具
 * 不需要动这里一行——注册表加一行、适配器加一个文件就够。
 *
 *   agent-assets [discover]        — 全景盘点:每家装没装、资产根在哪、三类各多少项
 *   agent-assets caps              — 逐家的能力声明(哪类资产可读/可写),缺失显式标注
 *   agent-assets list <工具>       — 列某一家的资产
 *   agent-assets plan <工具>       — 只看某个方向会发生什么(不写任何文件)
 *   agent-assets import <工具>     — 外部工具 → khy-os
 *   agent-assets export <工具>     — khy-os → 外部工具
 *   agent-assets sync <工具>       — 双向
 *
 * 干跑优先:import/export/sync **默认只出计划不落盘**,必须显式 `--apply`
 * (或 `--no-dry-run`)才真正写入。冲突默认 keep-both:目标侧原资产一字不动,
 * 来侧内容另存为冲突副本并在冲突清单里逐条列出。
 *
 * @module handlers/agentAssets
 */
const chalk = require('chalk').default || require('chalk');

const M = require('../../services/domain/agents/agentAssets/assetModel.js');
const registry = require('../commands/registry.js');
const sync = require('../../services/domain/agents/agentAssets/sync.js');
const { printInfo, printError, printTable, printSuccess, printWarn } = require('../formatters');

/** khy-os 自己也是注册表里的一家,故 import/export 共用同一段搬运代码。 */
const SELF_ID = 'khy-os';

const _FALSY = new Set(['0', 'false', 'off', 'no']);

const KIND_LABELS = Object.freeze({ memory: '记忆', tool: '工具', skill: '技能' });

const ACTION_LABELS = Object.freeze({
  create: '新建',
  'in-sync': '已一致',
  conflict: '冲突',
  noop: '不动',
});

function _isFalsy(value) {
  return _FALSY.has(String(value === undefined ? '' : value).trim().toLowerCase());
}

/**
 * 干跑判定。默认为**真**:只有 `--apply` / `--no-dry-run` / `--dry-run=false`
 * 这三种显式写法才关掉干跑,其余一切(含未传、含 `--dry-run` 裸标记)都保持干跑。
 */
function _resolveDryRun(options) {
  const o = options || {};
  if (o.apply !== undefined && !_isFalsy(o.apply)) {
    return false;
  }
  if (o['no-dry-run'] !== undefined && !_isFalsy(o['no-dry-run'])) {
    return false;
  }
  if (o['dry-run'] !== undefined && _isFalsy(o['dry-run'])) {
    return false;
  }
  return true;
}

/** `--kind memory,skill` → { kinds, invalid };缺省返 kinds=null(三类全要)。 */
function _resolveKinds(options) {
  const raw = String((options && (options.kind || options.kinds)) || '').trim();
  if (!raw || raw === 'true') {
    return { kinds: null, invalid: [] };
  }
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    kinds: wanted.filter((k) => M.ASSET_KINDS.includes(k)),
    invalid: wanted.filter((k) => !M.ASSET_KINDS.includes(k)),
  };
}

function _resolveIdleTimeout(options) {
  const raw = Number(String((options && options['idle-timeout']) || '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined;
}

/** 已注册工具 id 提示串,报错时列给用户看。 */
function _knownIds() {
  return registry.AGENT_ASSET_SOURCES.map((s) => s.id).join(' / ');
}

function _requireTool(name, verb) {
  const id = String(name || '').trim();
  if (!id) {
    printError(`用法: agent-assets ${verb} <工具>（已注册:${_knownIds()}）`);
    return '';
  }
  if (!registry.getSource(id)) {
    printError(`未注册的外部 agent 工具:${id}`);
    printInfo(`已注册:${_knownIds()}。用 \`khy agent-assets\` 看各家探测结果。`);
    return '';
  }
  return id;
}

// ── discover / caps ─────────────────────────────────────────────────────

function _handleDiscover(options) {
  const { kinds, invalid } = _resolveKinds(options);
  if (invalid.length) {
    printError(`未知资产类型:${invalid.join(' / ')}（仅 ${M.ASSET_KINDS.join(' / ')}）`);
    return true;
  }
  const res = sync.discover({ kinds: kinds || undefined });
  if (!res.ok) {
    printError(res.error);
    return true;
  }
  printInfo(`已注册外部 agent 工具 ${res.tools.length} 家,合计资产 ${res.totalAssets} 项:`);
  const rows = res.tools.map((t) => [
    t.tool,
    t.detected ? chalk.green('已检测到') : chalk.yellow('未检测到'),
    String(t.counts.memory === undefined ? '-' : t.counts.memory),
    String(t.counts.tool === undefined ? '-' : t.counts.tool),
    String(t.counts.skill === undefined ? '-' : t.counts.skill),
    String(t.total),
  ]);
  printTable(['工具', '状态', '记忆', '工具', '技能', '合计'], rows);

  // 逐家补一行细节:装了的报资产根,没装的报「找过哪些位置」——只说「未找到」等于让
  // 用户自己去猜该配哪个环境变量。
  for (const t of res.tools) {
    if (t.detected) {
      printInfo(`  ${t.label}:资产根 ${t.root}`);
    } else {
      printWarn(`  ${t.label}:${t.error}`);
    }
  }
  printInfo('查看某一家:khy agent-assets list <工具>  |  能力声明:khy agent-assets caps');
  return true;
}

function _handleCaps(name) {
  const res = registry.describeSources(process.env);
  if (!res.ok) {
    printError(res.error);
    return true;
  }
  const wanted = String(name || '').trim();
  const sources = wanted ? res.sources.filter((s) => s.id === wanted) : res.sources;
  if (!sources.length) {
    printError(`未注册的外部 agent 工具:${wanted}（已注册:${_knownIds()}）`);
    return true;
  }
  const rows = [];
  for (const s of sources) {
    const caps = (s.capabilities && s.capabilities.kinds) || {};
    for (const kind of M.ASSET_KINDS) {
      const c = caps[kind];
      // 缺失的能力**显式声明为不支持**,而不是留空让调用方猜。
      const read = c && c.read ? chalk.green('可读') : chalk.yellow('不支持');
      const write = c && c.write ? chalk.green('可写') : chalk.yellow('不支持');
      rows.push([s.id, KIND_LABELS[kind], read, write, (c && c.note) || '—']);
    }
  }
  printTable(['工具', '资产类型', '读', '写', '落点说明'], rows);
  for (const s of sources) {
    const envKeys = ((s.capabilities && s.capabilities.rootEnvKeys) || []).join(' / ') || '—';
    printInfo(`  ${s.label}:资产根环境变量 ${envKeys}`);
  }
  return true;
}

// ── list ────────────────────────────────────────────────────────────────

function _handleList(name, options) {
  const id = _requireTool(name, 'list');
  if (!id) {
    return true;
  }
  const { kinds, invalid } = _resolveKinds(options);
  if (invalid.length) {
    printError(`未知资产类型:${invalid.join(' / ')}（仅 ${M.ASSET_KINDS.join(' / ')}）`);
    return true;
  }
  const res = sync.listTool(id, { kinds: kinds || undefined });
  if (!res.ok) {
    printError(res.error);
    return true;
  }
  if (!res.detected) {
    printWarn(`未检测到 ${res.label || id}:${res.error}`);
    return true;
  }
  if (!res.assets.length) {
    printInfo(`${res.label} 资产根 ${res.root} 下暂无可同步资产。`);
    return true;
  }
  printInfo(`${res.label}（资产根 ${res.root}）共 ${res.assets.length} 项资产:`);
  const rows = res.assets.map((a) => [
    KIND_LABELS[a.kind] || a.kind,
    M.assetIdentity(a),
    a.title || a.name || a.id,
    (a.source && a.source.path) || '—',
    (a.updatedAt || '—').replace('T', ' ').slice(0, 19),
  ]);
  printTable(['类型', '身份', '名称', '来源路径(相对资产根)', '更新时间'], rows);
  if (res.error) {
    printWarn(`部分类型读取有问题:${res.error}`);
  }
  printInfo(`看同步计划:khy agent-assets plan ${id}`);
  return true;
}

// ── plan ────────────────────────────────────────────────────────────────

function _handlePlan(name, options) {
  const o = options || {};
  const from = String(o.from || name || '').trim();
  const to = String(o.to || SELF_ID).trim();
  const src = _requireTool(from, 'plan');
  if (!src) {
    return true;
  }
  if (!_requireTool(to, 'plan')) {
    return true;
  }
  const { kinds, invalid } = _resolveKinds(o);
  if (invalid.length) {
    printError(`未知资产类型:${invalid.join(' / ')}（仅 ${M.ASSET_KINDS.join(' / ')}）`);
    return true;
  }
  const res = sync.plan({ from: src, to, kinds: kinds || undefined });
  if (!res.ok) {
    printError(res.error);
    return true;
  }
  if (res.skipped) {
    printWarn(res.reason);
    return true;
  }
  if (!res.items.length) {
    printInfo(`${res.fromLabel} → ${res.toLabel}:源侧没有可搬运的资产。`);
    return true;
  }
  printInfo(`${res.fromLabel} → ${res.toLabel} 共 ${res.items.length} 项:`);
  printTable(
    ['类型', '名称', '判定', '说明'],
    res.items.map((it) => [
      KIND_LABELS[it.kind] || it.kind,
      it.name,
      _paintAction(it.action),
      it.reason,
    ])
  );
  _printSummary(res.summary);
  printInfo(`真正搬运:khy agent-assets import ${src}（默认干跑,加 --apply 落盘）`);
  return true;
}

function _paintAction(action) {
  const label = ACTION_LABELS[action] || action;
  if (action === 'conflict') {
    return chalk.yellow(label);
  }
  if (action === 'create') {
    return chalk.green(label);
  }
  return label;
}

function _printSummary(summary) {
  const s = summary || {};
  printInfo(
    `判定汇总:新建 ${s.create || 0} · 已一致 ${s['in-sync'] || 0} · 冲突 ${s.conflict || 0} · 不动 ${s.noop || 0}`
  );
}

// ── import / export / sync ──────────────────────────────────────────────

/**
 * 三个搬运动作共用一段代码——方向不同而已(import 外部→khy-os、export 反向、
 * sync 两个方向各跑一遍)。
 */
function _handleTransfer(verb, name, options) {
  const o = options || {};
  const id = _requireTool(name, verb);
  if (!id) {
    return true;
  }
  if (id === SELF_ID) {
    printError(`${verb} 的参数应当是外部工具,khy-os 自己已经是另一侧（已注册:${_knownIds()}）`);
    return true;
  }
  const { kinds, invalid } = _resolveKinds(o);
  if (invalid.length) {
    printError(`未知资产类型:${invalid.join(' / ')}（仅 ${M.ASSET_KINDS.join(' / ')}）`);
    return true;
  }
  const dryRun = _resolveDryRun(o);
  const shared = {
    kinds: kinds || undefined,
    dryRun,
    idleTimeoutMs: _resolveIdleTimeout(o),
    onConflict: String(o['on-conflict'] || '').trim() === 'skip' ? 'skip' : 'keep-both',
    // 状态透明:每处理一项都打一行「动作 + 目标 + 进度」,形如
    // 「正在导入 opencode 记忆 3/17:项目约定」。
    onProgress: (p) => {
      if (p && p.phase === 'transfer' && p.message) {
        printInfo(`  ${p.message}`);
      }
    },
  };

  let res;
  if (verb === 'import') {
    res = sync.importAssets(Object.assign({ from: id }, shared));
  } else if (verb === 'export') {
    res = sync.exportAssets(Object.assign({ to: id }, shared));
  } else {
    res = sync.syncAssets(Object.assign({ a: id, b: SELF_ID }, shared));
  }
  if (!res.ok) {
    printError(res.error || '搬运失败');
    return true;
  }

  const directions = Array.isArray(res.directions) ? res.directions : [res];
  for (const dir of directions) {
    _printDirection(dir);
  }
  _printConflicts([].concat(...directions.map((d) => d.conflicts || [])));
  _printFailures([].concat(...directions.map((d) => d.failures || [])));

  if (dryRun) {
    printWarn('以上为干跑结果,未写入任何文件。确认无误后重跑并加 --apply 落盘。');
  } else {
    printSuccess('已落盘。冲突项以副本形式保留,目标侧原资产未被改动。');
  }
  return true;
}

function _printDirection(dir) {
  if (!dir || typeof dir !== 'object') {
    return;
  }
  const label = `${dir.fromLabel || dir.from} → ${dir.toLabel || dir.to}`;
  if (dir.skipped) {
    printWarn(`${label}:已跳过 —— ${dir.reason}`);
    return;
  }
  const applied = dir.applied || [];
  printInfo(`${label}:${dir.dryRun ? '计划' : '已写入'} ${applied.length} 项`);
  if (!applied.length) {
    // 一项都不动时不能只报一个 0:「没找到资产」与「全部已一致」对用户是两件事,
    // 光看 0 无从分辨。故这一支照样把判定汇总打出来。
    _printSummary(dir.summary);
    return;
  }
  const rows = [];
  for (const item of applied) {
    for (const p of item.plan || []) {
      rows.push([
        KIND_LABELS[item.kind] || item.kind,
        item.identity,
        p.path,
        p.reason,
        `${p.bytes === undefined ? '-' : p.bytes} B`,
      ]);
    }
  }
  if (rows.length) {
    printTable(['类型', '身份', '落点路径', '原因', '字节'], rows);
  }
  _printSummary(dir.summary);
}

function _printConflicts(conflicts) {
  if (!conflicts.length) {
    return;
  }
  printWarn(`冲突 ${conflicts.length} 项（同名不同内容 —— 双方都保留,绝不覆盖）:`);
  printTable(
    ['类型', '身份', '处理', '较新的一侧', '冲突副本'],
    conflicts.map((c) => [
      KIND_LABELS[c.kind] || c.kind,
      c.identity,
      c.resolution === 'skip' ? '跳过' : '保留双方',
      c.newer === 'source' ? '来侧' : c.newer === 'target' ? '目标侧' : '无法判断',
      c.copyIdentity || '—',
    ])
  );
}

function _printFailures(failures) {
  if (!failures.length) {
    return;
  }
  printWarn(`未能搬运 ${failures.length} 项:`);
  for (const f of failures) {
    const tag = f.unsupported ? '目标侧不支持' : '失败';
    printWarn(`  [${tag}] ${KIND_LABELS[f.kind] || f.kind} ${f.identity}:${f.error}`);
  }
}

function _printHelp() {
  // 已接入的家数同样从注册表推导:帮助里写死清单的话,新接一家用户就看不见它。
  const joined = registry.AGENT_ASSET_SOURCES.map((s) => s.id).join('、');
  printInfo(`外部 agent 资产管理(记忆 / 工具 / 技能 三类,已接入:${joined}):`);
  printInfo('  khy agent-assets                    盘点各家装没装、资产根在哪、各有多少项');
  printInfo('  khy agent-assets caps [工具]        逐家能力声明(哪类资产可读/可写)');
  printInfo('  khy agent-assets list <工具>        列某一家的资产');
  printInfo('  khy agent-assets plan <工具>        只看某方向会发生什么(不写文件)');
  printInfo('  khy agent-assets import <工具>      外部工具 → khy-os');
  printInfo('  khy agent-assets export <工具>      khy-os → 外部工具');
  printInfo('  khy agent-assets sync <工具>        双向');
  printInfo('可选参数:');
  printInfo('  --kind memory,skill    只处理指定资产类型(缺省三类全要)');
  printInfo('  --apply                真正落盘(不加 = 干跑,只出计划)');
  printInfo('  --on-conflict skip     冲突项跳过(缺省 keep-both:另存冲突副本)');
  printInfo('  --from / --to          plan 的两侧(缺省 <工具> → khy-os)');
  printInfo('  --idle-timeout 60      连续多少秒无进展算卡死(不是总时长上限)');
  return true;
}

/**
 * @param {object} parsed - { subCommand, args, options }
 * @returns {boolean}
 */
function handleAgentAssets(parsed = {}) {
  const sub = String(parsed.subCommand || '').toLowerCase();
  const args = Array.isArray(parsed.args) ? parsed.args : [];
  const options = parsed.options || {};

  if (!M.isEnabled(process.env)) {
    printError('外部 agent 资产层已被门控关闭(KHY_AGENT_ASSETS=off)。');
    printInfo('要启用:khy capability on 或直接设 KHY_AGENT_ASSETS=1。');
    return true;
  }

  if (!sub || sub === 'discover') {
    return _handleDiscover(options);
  }
  if (sub === 'caps' || sub === 'capabilities') {
    return _handleCaps(args[0]);
  }
  if (sub === 'list') {
    return _handleList(args[0], options);
  }
  if (sub === 'plan') {
    return _handlePlan(args[0], options);
  }
  if (sub === 'import' || sub === 'export' || sub === 'sync') {
    return _handleTransfer(sub, args[0], options);
  }
  if (sub === 'help') {
    return _printHelp();
  }

  printError(`未知子命令:${sub}`);
  return _printHelp();
}

module.exports = { handleAgentAssets };
