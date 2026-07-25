'use strict';

/**
 * workflow.js — `khy workflow`(别名 `wf`)命令处理器:把工作流子系统接到 khy CLI。
 *
 * khy 已在生产侧具备完整工作流能力——canonical 解释器
 * (services/backend/src/services/workflow/workflowExecutor.runGraph)、Coze 导入器
 * (@khy/shared/workflow/cozeImport.convertCozeWorkflow)、REST 与 Vue 可视化编辑器。
 * 唯独缺一个「从命令行直接 import / list / show / validate / run」的可达面。本处理器
 * 就是那层薄 CLI 桥:**复用既有 Engine A 与导入器,绝不另造引擎**。
 *
 * 纯逻辑(输入解析 / 结构校验 / 摘要 / Mermaid / 报告格式化 / slug)收在纯叶子
 * services/workflow/workflowCliCore.js;本文件只做 IO:读 Coze 文件、读写本地工作流
 * 存储(getAppDataDir('workflows'))、调 runGraph 执行。
 *
 * 用法:
 *   khy workflow import <coze文件> [--name 名称]   导入 Coze 导出(json/容器字节)为 canonical 图并保存
 *   khy workflow list                              列出已保存的工作流
 *   khy workflow show <名称> [--mermaid] [--json]  查看图摘要 / Mermaid / 原始 JSON
 *   khy workflow validate <名称>                   按节点目录端口严格校验
 *   khy workflow run <名称> [k=v ...] [--json]     在本机用真实 primitives 执行
 *   khy workflow rm <名称>                         删除已保存的工作流
 *   别名:wf;import→add,list→ls,validate→check,rm→delete/remove
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printInfo, printWarn, printError, printSuccess } = require('../formatters');

function _printHelp() {
  printInfo('khy workflow — 导入 / 查看 / 运行工作流(复用生产 Engine A + Coze 导入器)');
  printInfo('  khy workflow import <coze文件> [--name 名称]   导入 Coze 导出为 canonical 图并保存');
  printInfo('  khy workflow list                              列出已保存的工作流');
  printInfo('  khy workflow show <名称> [--mermaid] [--json]  查看摘要 / Mermaid / 原始 JSON');
  printInfo('  khy workflow validate <名称>                   按节点端口严格校验');
  printInfo('  khy workflow run <名称> [k=v ...] [--json]      在本机执行(真实 LLM / 工具)');
  printInfo('  khy workflow rm <名称>                          删除已保存的工作流');
  printInfo('  别名:khy wf …');
}

// 解析 deps + 默认实现(deps 注入供测试)。
function _resolveDeps(deps = {}) {
  const coze = deps.coze || require('@khy/shared/workflow/cozeImport');
  const catalog = deps.catalog || require('@khy/shared/workflow/nodeCatalog');
  const executor = deps.executor || require('../../services/workflow/workflowExecutor');
  const core = deps.core || require('../../services/workflow/workflowCliCore');
  const dataHome = deps.dataHome || require('../../utils/dataHome');
  const fs = deps.fs || require('fs');
  const path = deps.path || require('path');
  return { coze, catalog, executor, core, dataHome, fs, path };
}

function _storeDir(deps, d) {
  if (deps.storeDir) return deps.storeDir;
  return d.dataHome.getAppDataDir('workflows');
}

function _fileFor(d, dir, slug) {
  return d.path.join(dir, `${slug}.json`);
}

// 已保存工作流的 known 节点类型集合(来自 catalog SSOT)。
function _knownTypes(catalog) {
  try {
    return new Set((catalog.NODE_CATALOG || []).map((n) => n.type));
  } catch { return null; }
}

// 读出一个已保存工作流文件 → { name, nodes, connections, _meta }。fail-soft → null。
function _loadSaved(d, file) {
  try {
    const raw = d.fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.nodes) && Array.isArray(obj.connections)) return obj;
    // 兼容直接存裸 graph 的情形。
    if (obj && obj.graph && Array.isArray(obj.graph.nodes)) {
      return { name: obj.name, nodes: obj.graph.nodes, connections: obj.graph.connections || [], _meta: obj._meta };
    }
    return null;
  } catch { return null; }
}

// ── import ───────────────────────────────────────────────────────────────────

async function _doImport(d, args, options) {
  const src = String(args[0] || '').trim();
  if (!src) { printError('用法:khy workflow import <coze文件> [--name 名称]'); return true; }
  if (!d.fs.existsSync(src)) { printError(`文件不存在:${src}`); return true; }

  // 以 Buffer 读取——Coze 容器是 JSON 外包一层二进制;cozeImport 会自行碳取 JSON。
  let buf;
  try { buf = d.fs.readFileSync(src); } catch (err) {
    printError(`读取失败:${(err && err.message) || err}`); return true;
  }

  let result;
  try {
    result = d.coze.convertCozeWorkflow(buf, { name: options.name || undefined });
  } catch (err) {
    printError(`导入失败:${(err && err.message) || err}`);
    printInfo('提示:本命令接受单个 Coze 工作流导出(.json 或其容器字节)。');
    printInfo('      整包多工作流枚举请走 Web 编辑器 / ai-backend 的 import/coze/enumerate。');
    return true;
  }

  const { graph, report } = result;
  const name = (options.name && String(options.name).trim()) || report.name || 'Coze 导入工作流';
  const slug = d.core.slugify(name);
  const dir = _storeDir(d._deps, d);
  const file = _fileFor(d, dir, slug);
  const payload = {
    name,
    nodes: graph.nodes,
    connections: graph.connections,
    _meta: { source: 'coze', report, importedAt: new Date().toISOString(), origin: src },
  };
  try {
    d.fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch (err) {
    printError(`保存失败:${(err && err.message) || err}`); return true;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, name, slug, file, report }) + '\n');
    return true;
  }
  printSuccess(`✅ 已导入并保存:${name}`);
  printInfo(`  存储:${file}`);
  for (const line of d.core.formatReport(report)) printInfo('  ' + line);
  // 导入后即时校验,告知是否可直接运行。
  const v = d.core.validateGraph(graph, {
    portsFor: d.catalog.portsFor, knownTypes: _knownTypes(d.catalog), strict: true,
  });
  if (v.ok) printInfo(chalk.green('  ✔ 校验通过,可运行:') + ` khy wf run ${slug}`);
  else printWarn(`  ⚠ 校验有 ${v.errors.length} 项问题(khy wf validate ${slug} 查看)`);
  return true;
}

// ── list ─────────────────────────────────────────────────────────────────────

function _doList(d, options) {
  const dir = _storeDir(d._deps, d);
  let files = [];
  try {
    files = d.fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch { files = []; }
  const items = [];
  for (const f of files.sort()) {
    const saved = _loadSaved(d, d.path.join(dir, f));
    if (!saved) continue;
    const s = d.core.summarizeGraph(saved);
    items.push({ slug: f.replace(/\.json$/, ''), name: saved.name || f, nodeCount: s.nodeCount, edgeCount: s.edgeCount });
  }
  if (options.json) { process.stdout.write(JSON.stringify({ dir, items }) + '\n'); return true; }
  if (!items.length) {
    printInfo('暂无已保存的工作流。用 `khy workflow import <coze文件>` 导入一个。');
    printInfo(`存储目录:${dir}`);
    return true;
  }
  printInfo(`已保存的工作流(${items.length})  存储:${dir}`);
  for (const it of items) {
    printInfo(`  ${chalk.cyan(it.slug)}  ${it.name}  ` + chalk.gray(`[节点 ${it.nodeCount} · 连接 ${it.edgeCount}]`));
  }
  return true;
}

// ── show ─────────────────────────────────────────────────────────────────────

function _doShow(d, args, options) {
  const slug = d.core.slugify(args[0] || '');
  const dir = _storeDir(d._deps, d);
  const file = _fileFor(d, dir, slug);
  const saved = _loadSaved(d, file);
  if (!saved) { printError(`未找到工作流:${args[0] || ''}(${file})`); return true; }
  if (options.json) { process.stdout.write(JSON.stringify(saved) + '\n'); return true; }
  if (options.mermaid) { process.stdout.write(d.core.toMermaid(saved) + '\n'); return true; }

  const s = d.core.summarizeGraph(saved);
  printInfo(`工作流:${chalk.bold(saved.name || slug)}  (${slug})`);
  printInfo(`节点:${s.nodeCount}  连接:${s.edgeCount}  起点:${s.start || '?'}  终点:${s.ends.join(',') || '?'}`);
  if (s.typeCounts && Object.keys(s.typeCounts).length) {
    printInfo('类型:' + Object.entries(s.typeCounts).map(([k, v]) => `${k}×${v}`).join('  '));
  }
  for (const n of s.nodes) printInfo(`  · ${chalk.cyan(n.type)}  ${n.name}  ` + chalk.gray(`(${n.id})`));
  if (saved._meta && saved._meta.report) {
    const r = saved._meta.report;
    if ((r.unsupported && r.unsupported.length) || (r.warnings && r.warnings.length)) {
      printWarn('导入近似(详见 khy wf show ' + slug + ' --json):');
      for (const line of d.core.formatReport(r).slice(2)) printInfo('  ' + line);
    }
  }
  printInfo(chalk.gray(`Mermaid:khy wf show ${slug} --mermaid`));
  return true;
}

// ── validate ───────────────────────────────────────────────────────────────

function _doValidate(d, args, options) {
  const slug = d.core.slugify(args[0] || '');
  const dir = _storeDir(d._deps, d);
  const saved = _loadSaved(d, _fileFor(d, dir, slug));
  if (!saved) { printError(`未找到工作流:${args[0] || ''}`); return true; }
  const v = d.core.validateGraph(saved, {
    portsFor: d.catalog.portsFor, knownTypes: _knownTypes(d.catalog), strict: true,
  });
  if (options.json) { process.stdout.write(JSON.stringify(v) + '\n'); return true; }
  if (v.ok) { printSuccess(`✅ 校验通过:${saved.name || slug}`); return true; }
  printError(`❌ 校验未通过(${v.errors.length} 项):`);
  for (const e of v.errors) printWarn('  · ' + e);
  return true;
}

// ── run ──────────────────────────────────────────────────────────────────────

function _gatherInputs(d, args, options) {
  const pairs = [];
  // 位置参数里形如 k=v 的 token。
  for (const a of args.slice(1)) { if (typeof a === 'string' && a.includes('=')) pairs.push(a); }
  // --input 可重复(数组)或单值(字符串)。
  const inp = options.input;
  if (Array.isArray(inp)) pairs.push(...inp.map(String));
  else if (inp != null) pairs.push(String(inp));
  return d.core.parseInputs(pairs);
}

async function _doRun(d, args, options) {
  const slug = d.core.slugify(args[0] || '');
  const dir = _storeDir(d._deps, d);
  const saved = _loadSaved(d, _fileFor(d, dir, slug));
  if (!saved) { printError(`未找到工作流:${args[0] || ''}`); return true; }

  // 运行前校验,避免把坏图喂进解释器。
  const v = d.core.validateGraph(saved, {
    portsFor: d.catalog.portsFor, knownTypes: _knownTypes(d.catalog), strict: true,
  });
  if (!v.ok) {
    printError(`❌ 图未通过校验,拒绝运行(${v.errors.length} 项):`);
    for (const e of v.errors) printWarn('  · ' + e);
    return true;
  }

  const vars = _gatherInputs(d, args, options);
  const userId = options.userId != null ? options.userId : null;
  const primitives = d._deps.primitives
    || (d.executor.defaultPrimitives ? d.executor.defaultPrimitives({ userId }) : undefined);
  const quantum = Number(options.quantum) > 0 ? Math.floor(Number(options.quantum)) : 0;

  if (!options.json) printInfo(chalk.cyan(`▶ 运行工作流:${saved.name || slug}`));
  const graph = { nodes: saved.nodes, connections: saved.connections };
  let outcome;
  try {
    outcome = await d.executor.runGraph(graph, {
      primitives,
      vars,
      quantum,
      onLog: options.json ? undefined : (entry) => {
        const icon = entry.status === 'failed' ? '✗' : (entry.status === 'skipped' ? '∅' : '✓');
        const tail = entry.summary ? '  ' + chalk.gray(entry.summary) : '';
        printInfo(`  ${icon} ${entry.type} ${chalk.gray('(' + entry.name + ')')}${tail}`);
      },
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (options.json) { process.stdout.write(JSON.stringify({ status: 'failed', error: msg, vars: (err && err.vars) || vars }) + '\n'); return true; }
    printError(`❌ 运行失败:${msg}`);
    return true;
  }

  if (options.json) { process.stdout.write(JSON.stringify(outcome) + '\n'); return true; }
  if (outcome.status === 'paused') {
    printWarn(`⏸ 已暂停(${(outcome.pause && outcome.pause.kind) || 'askUserQuestion'})。`);
    return true;
  }
  printSuccess(`✅ 运行完成(${(outcome.log || []).length} 个节点）`);
  const keys = Object.keys(outcome.vars || {});
  if (keys.length) {
    printInfo('结果变量:');
    for (const k of keys) {
      const val = outcome.vars[k];
      const str = typeof val === 'string' ? val : JSON.stringify(val);
      printInfo(`  ${chalk.cyan(k)} = ${chalk.gray(String(str).slice(0, 400))}`);
    }
  }
  return true;
}

// ── rm ───────────────────────────────────────────────────────────────────────

function _doRemove(d, args, options) {
  const slug = d.core.slugify(args[0] || '');
  const dir = _storeDir(d._deps, d);
  const file = _fileFor(d, dir, slug);
  if (!d.fs.existsSync(file)) { printError(`未找到工作流:${args[0] || ''}`); return true; }
  try { d.fs.unlinkSync(file); } catch (err) { printError(`删除失败:${(err && err.message) || err}`); return true; }
  if (options.json) { process.stdout.write(JSON.stringify({ ok: true, slug, file }) + '\n'); return true; }
  printSuccess(`🗑 已删除:${slug}`);
  return true;
}

/**
 * 处理 `khy workflow` 命令。
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options  已解析的 flag
 * @param {object} [deps]  注入供测试:{ coze, catalog, executor, core, dataHome, fs, path, storeDir, primitives }
 * @returns {Promise<boolean>}
 */
async function handleWorkflow(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'list').toLowerCase();
  if (sub === 'help' || options.help) { _printHelp(); return true; }

  const d = _resolveDeps(deps);
  d._deps = deps;

  switch (sub) {
    case 'import': case 'add':
      return _doImport(d, args, options);
    case 'list': case 'ls':
      return _doList(d, options);
    case 'show': case 'view':
      return _doShow(d, args, options);
    case 'validate': case 'check':
      return _doValidate(d, args, options);
    case 'run': case 'exec':
      return _doRun(d, args, options);
    case 'rm': case 'delete': case 'remove': case 'del':
      return _doRemove(d, args, options);
    default:
      printWarn(`未知子命令:workflow ${subCommand}`);
      _printHelp();
      return true;
  }
}

module.exports = { handleWorkflow };
