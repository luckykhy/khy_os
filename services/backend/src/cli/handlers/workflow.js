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
 *   khy workflow record [--name 名称] [--param 参数名...]  录制桌面操作为工作流
 *   khy workflow stop                                     结束录制并保存
 *   khy workflow playback <名称> [k=v ...] [--step-delay ms]  回放桌面工作流（自动启用操控）
 *   khy workflow stats <名称>                             查看执行统计(成功率/耗时/近况)
 *   别名:wf;import→add,list→ls,validate→check,rm→delete/remove,playback→replay,stats→metrics
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
  printInfo('  khy workflow record [--name 名称] [--param 参数名...]  录制桌面操作为工作流');
  printInfo('  khy workflow stop                                     结束录制并保存');
  printInfo(
    '  khy workflow playback <名称> [k=v ...] [--step-delay ms]  回放桌面工作流（自动启用操控）'
  );
  printInfo(
    '  khy workflow stats <名称>                             查看执行统计(成功率/平均耗时/近 10 次)'
  );
  printInfo('  别名:khy wf …');
}

// 解析 deps + 默认实现(deps 注入供测试)。
function _resolveDeps(deps = {}) {
  const coze = deps.coze || require('@khy/shared/workflow/cozeImport');
  const catalog = deps.catalog || require('@khy/shared/workflow/nodeCatalog');
  const executor = deps.executor || require('../../services/workflow/workflowExecutor');
  const core = deps.core || require('../../services/workflow/workflowCliCore');
  const flowStats = deps.flowStats || require('../../services/workflow/flowStats');
  const dataHome = deps.dataHome || require('../../utils/dataHome');
  const fs = deps.fs || require('fs');
  const path = deps.path || require('path');
  return { coze, catalog, executor, core, flowStats, dataHome, fs, path };
}

function _storeDir(deps, d) {
  if (deps.storeDir) {
    return deps.storeDir;
  }
  return d.dataHome.getAppDataDir('workflows');
}

function _fileFor(d, dir, slug) {
  return d.path.join(dir, `${slug}.json`);
}

// 已保存工作流的 known 节点类型集合(来自 catalog SSOT)。
function _knownTypes(catalog) {
  try {
    return new Set((catalog.NODE_CATALOG || []).map((n) => n.type));
  } catch {
    return null;
  }
}

// ── Desktop workflow recording state ───────────────────────────────────────
// Persists across record/stop calls within the same process (REPL session).
// Holds { name, startedAt, controller } while a recording is active.
let _activeRecording = null;

// Desktop control gate mode (mirrors safetyGate._envMode without reaching into internals).
function _desktopMode() {
  const raw = String(process.env.KHY_DESKTOP_CONTROL || '')
    .trim()
    .toLowerCase();
  if (raw === '' || raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') {
    return 'off';
  }
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') {
    return 'on';
  }
  if (raw === 'ask') {
    return 'ask';
  }
  if (raw === 'strict') {
    return 'strict';
  }
  return 'off';
}

// Resolve the DesktopController module (test-injectable via deps.desktopControl).
function _resolveDesktop(deps) {
  if (deps.desktopControl) {
    return deps.desktopControl;
  }
  return require('../../services/desktopControl');
}

// Parse --param (repeatable): accepts a string, an array, or comma-separated values.
function _parseParamList(param) {
  if (param == null) {
    return [];
  }
  if (Array.isArray(param)) {
    return param.flatMap((p) =>
      String(p)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  return String(param)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse --step-delay (ms). Defaults to 200 when absent or invalid.
function _parseStepDelay(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200;
}

// 读出一个已保存工作流文件 → { name, nodes, connections, _meta }。fail-soft → null。
function _loadSaved(d, file) {
  try {
    const raw = d.fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.nodes) && Array.isArray(obj.connections)) {
      return obj;
    }
    // 兼容直接存裸 graph 的情形。
    if (obj && obj.graph && Array.isArray(obj.graph.nodes)) {
      return {
        name: obj.name,
        nodes: obj.graph.nodes,
        connections: obj.graph.connections || [],
        _meta: obj._meta,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── import ───────────────────────────────────────────────────────────────────

async function _doImport(d, args, options) {
  const src = String(args[0] || '').trim();
  if (!src) {
    printError('用法:khy workflow import <coze文件> [--name 名称]');
    return true;
  }
  if (!d.fs.existsSync(src)) {
    printError(`文件不存在:${src}`);
    return true;
  }

  // 以 Buffer 读取——Coze 容器是 JSON 外包一层二进制;cozeImport 会自行碳取 JSON。
  let buf;
  try {
    buf = d.fs.readFileSync(src);
  } catch (err) {
    printError(`读取失败:${(err && err.message) || err}`);
    return true;
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
    printError(`保存失败:${(err && err.message) || err}`);
    return true;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, name, slug, file, report }) + '\n');
    return true;
  }
  printSuccess(`✅ 已导入并保存:${name}`);
  printInfo(`  存储:${file}`);
  for (const line of d.core.formatReport(report)) {
    printInfo('  ' + line);
  }
  // 导入后即时校验,告知是否可直接运行。
  const v = d.core.validateGraph(graph, {
    portsFor: d.catalog.portsFor,
    knownTypes: _knownTypes(d.catalog),
    strict: true,
  });
  if (v.ok) {
    printInfo(chalk.green('  ✔ 校验通过,可运行:') + ` khy wf run ${slug}`);
  } else {
    printWarn(`  ⚠ 校验有 ${v.errors.length} 项问题(khy wf validate ${slug} 查看)`);
  }
  return true;
}

// ── list ─────────────────────────────────────────────────────────────────────

function _doList(d, options) {
  const dir = _storeDir(d._deps, d);
  let files = [];
  try {
    files = d.fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const items = [];
  for (const f of files.sort()) {
    const saved = _loadSaved(d, d.path.join(dir, f));
    if (!saved) {
      continue;
    }
    const s = d.core.summarizeGraph(saved);
    items.push({
      slug: f.replace(/\.json$/, ''),
      name: saved.name || f,
      nodeCount: s.nodeCount,
      edgeCount: s.edgeCount,
    });
  }
  if (options.json) {
    process.stdout.write(JSON.stringify({ dir, items }) + '\n');
    return true;
  }
  if (!items.length) {
    printInfo('暂无已保存的工作流。用 `khy workflow import <coze文件>` 导入一个。');
    printInfo(`存储目录:${dir}`);
    return true;
  }
  printInfo(`已保存的工作流(${items.length})  存储:${dir}`);
  for (const it of items) {
    printInfo(
      `  ${chalk.cyan(it.slug)}  ${it.name}  ` +
        chalk.gray(`[节点 ${it.nodeCount} · 连接 ${it.edgeCount}]`)
    );
  }
  return true;
}

// ── show ─────────────────────────────────────────────────────────────────────

function _doShow(d, args, options) {
  const slug = d.core.slugify(args[0] || '');
  const dir = _storeDir(d._deps, d);
  const file = _fileFor(d, dir, slug);
  const saved = _loadSaved(d, file);
  if (!saved) {
    printError(`未找到工作流:${args[0] || ''}(${file})`);
    return true;
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(saved) + '\n');
    return true;
  }
  if (options.mermaid) {
    process.stdout.write(d.core.toMermaid(saved) + '\n');
    return true;
  }

  const s = d.core.summarizeGraph(saved);
  printInfo(`工作流:${chalk.bold(saved.name || slug)}  (${slug})`);
  printInfo(
    `节点:${s.nodeCount}  连接:${s.edgeCount}  起点:${s.start || '?'}  终点:${s.ends.join(',') || '?'}`
  );
  if (s.typeCounts && Object.keys(s.typeCounts).length) {
    printInfo(
      '类型:' +
        Object.entries(s.typeCounts)
          .map(([k, v]) => `${k}×${v}`)
          .join('  ')
    );
  }
  for (const n of s.nodes) {
    printInfo(`  · ${chalk.cyan(n.type)}  ${n.name}  ` + chalk.gray(`(${n.id})`));
  }
  if (saved._meta && saved._meta.report) {
    const r = saved._meta.report;
    if ((r.unsupported && r.unsupported.length) || (r.warnings && r.warnings.length)) {
      printWarn('导入近似(详见 khy wf show ' + slug + ' --json):');
      for (const line of d.core.formatReport(r).slice(2)) {
        printInfo('  ' + line);
      }
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
  if (!saved) {
    printError(`未找到工作流:${args[0] || ''}`);
    return true;
  }
  const v = d.core.validateGraph(saved, {
    portsFor: d.catalog.portsFor,
    knownTypes: _knownTypes(d.catalog),
    strict: true,
  });
  if (options.json) {
    process.stdout.write(JSON.stringify(v) + '\n');
    return true;
  }
  if (v.ok) {
    printSuccess(`✅ 校验通过:${saved.name || slug}`);
    return true;
  }
  printError(`❌ 校验未通过(${v.errors.length} 项):`);
  for (const e of v.errors) {
    printWarn('  · ' + e);
  }
  return true;
}

// ── run ──────────────────────────────────────────────────────────────────────

function _gatherInputs(d, args, options) {
  const pairs = [];
  // 位置参数里形如 k=v 的 token。
  for (const a of args.slice(1)) {
    if (typeof a === 'string' && a.includes('=')) {
      pairs.push(a);
    }
  }
  // --input 可重复(数组)或单值(字符串)。
  const inp = options.input;
  if (Array.isArray(inp)) {
    pairs.push(...inp.map(String));
  } else if (inp != null) {
    pairs.push(String(inp));
  }
  return d.core.parseInputs(pairs);
}

async function _doRun(d, args, options) {
  const slug = d.core.slugify(args[0] || '');
  const dir = _storeDir(d._deps, d);
  const saved = _loadSaved(d, _fileFor(d, dir, slug));
  if (!saved) {
    printError(`未找到工作流:${args[0] || ''}`);
    return true;
  }

  // 运行前校验,避免把坏图喂进解释器。
  const v = d.core.validateGraph(saved, {
    portsFor: d.catalog.portsFor,
    knownTypes: _knownTypes(d.catalog),
    strict: true,
  });
  if (!v.ok) {
    printError(`❌ 图未通过校验,拒绝运行(${v.errors.length} 项):`);
    for (const e of v.errors) {
      printWarn('  · ' + e);
    }
    return true;
  }

  const vars = _gatherInputs(d, args, options);
  const userId = options.userId != null ? options.userId : null;
  const primitives =
    d._deps.primitives ||
    (d.executor.defaultPrimitives ? d.executor.defaultPrimitives({ userId }) : undefined);
  const quantum = Number(options.quantum) > 0 ? Math.floor(Number(options.quantum)) : 0;

  if (!options.json) {
    printInfo(chalk.cyan(`▶ 运行工作流:${saved.name || slug}`));
  }
  const graph = { nodes: saved.nodes, connections: saved.connections };
  let outcome;
  try {
    outcome = await d.executor.runGraph(graph, {
      primitives,
      vars,
      quantum,
      onLog: options.json
        ? undefined
        : (entry) => {
            const icon = entry.status === 'failed' ? '✗' : entry.status === 'skipped' ? '∅' : '✓';
            const tail = entry.summary ? '  ' + chalk.gray(entry.summary) : '';
            printInfo(`  ${icon} ${entry.type} ${chalk.gray('(' + entry.name + ')')}${tail}`);
          },
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ status: 'failed', error: msg, vars: (err && err.vars) || vars }) + '\n'
      );
      return true;
    }
    printError(`❌ 运行失败:${msg}`);
    return true;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(outcome) + '\n');
    return true;
  }
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
  if (!d.fs.existsSync(file)) {
    printError(`未找到工作流:${args[0] || ''}`);
    return true;
  }
  try {
    d.fs.unlinkSync(file);
  } catch (err) {
    printError(`删除失败:${(err && err.message) || err}`);
    return true;
  }
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, slug, file }) + '\n');
    return true;
  }
  printSuccess(`🗑 已删除:${slug}`);
  return true;
}

// ── record ──────────────────────────────────────────────────────────────────

async function _doRecord(d, args, options) {
  // 1. Gate check — recording real desktop actions requires the gate to be enabled.
  const mode = _desktopMode();
  if (mode === 'off') {
    printError('桌面操控未启用。请先设置 KHY_DESKTOP_CONTROL=on 或使用 /desktop on');
    return true;
  }
  // Refuse nested recording.
  if (_activeRecording) {
    printWarn(`已有录制进行中「${_activeRecording.name}」，请先 /workflow stop 结束后再录制`);
    return true;
  }

  // 2. Parse name + params + step-delay.
  const name = (options.name && String(options.name).trim()) || `recording_${Date.now()}`;
  const paramList = _parseParamList(options.param);
  const stepDelay = _parseStepDelay(
    options['step-delay'] != null ? options['step-delay'] : options.stepDelay
  );

  // 3. Create controller + start recording.
  const dc = _resolveDesktop(d._deps);
  const controller = dc.create({ sessionId: options.sessionId || '__cli__' });
  controller.startRecord({ name, params: paramList, stepDelay });

  // 4. Persist recording state for the stop handler.
  _activeRecording = { name, startedAt: Date.now(), controller };

  // 5. Output.
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, name, params: paramList }) + '\n');
    return true;
  }
  printSuccess(`🎬 工作流录制已开始${name ? `「${name}」` : ''}`);
  printInfo('执行桌面操作后输入 /workflow stop 结束录制');
  if (paramList.length) {
    printInfo(`  参数化:${paramList.join(', ')}`);
  }
  return true;
}

// ── stop ─────────────────────────────────────────────────────────────────────

async function _doStop(d, args, options) {
  if (!_activeRecording) {
    printWarn('当前没有活跃的工作流录制');
    return true;
  }
  const { name, controller } = _activeRecording;

  // Stop recording → workflow graph.
  let graph;
  try {
    graph = controller.stopRecord();
  } catch (err) {
    printError(`录制停止失败:${(err && err.message) || err}`);
    _activeRecording = null;
    return true;
  }
  if (!graph || !Array.isArray(graph.nodes)) {
    printError('录制未产生工作流图（可能无操作被记录）');
    _activeRecording = null;
    return true;
  }

  // Save to file (same storage convention as import).
  const slug = d.core.slugify(name);
  const dir = _storeDir(d._deps, d);
  const file = _fileFor(d, dir, slug);
  const payload = {
    name,
    nodes: graph.nodes,
    connections: graph.connections,
    _meta: {
      source: 'recorded',
      recordedAt: new Date().toISOString(),
      description: graph.description || '',
    },
  };
  try {
    d.fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch (err) {
    printError(`保存失败:${(err && err.message) || err}`);
    _activeRecording = null;
    return true;
  }

  // Clear state + report.
  _activeRecording = null;
  const stepCount = Math.max(0, graph.nodes.length - 2); // exclude start/end nodes
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, name, slug, file, steps: stepCount }) + '\n');
    return true;
  }
  printSuccess('✅ 工作流录制完成');
  printInfo(`  名称:${name}`);
  printInfo(`  步骤数:${stepCount}`);
  printInfo(`  已保存至:${file}`);
  printInfo(`  运行:khy workflow run ${slug}`);
  return true;
}

// ── playback ─────────────────────────────────────────────────────────────────

async function _doPlayback(d, args, options) {
  const slug = d.core.slugify(args[0] || '');
  const dir = _storeDir(d._deps, d);
  const saved = _loadSaved(d, _fileFor(d, dir, slug));
  if (!saved) {
    printError(`未找到工作流:${args[0] || ''}`);
    return true;
  }

  // Validate before running (same guard as _doRun).
  const v = d.core.validateGraph(saved, {
    portsFor: d.catalog.portsFor,
    knownTypes: _knownTypes(d.catalog),
    strict: true,
  });
  if (!v.ok) {
    printError(`❌ 图未通过校验,拒绝回放(${v.errors.length} 项):`);
    for (const e of v.errors) {
      printWarn('  · ' + e);
    }
    return true;
  }

  const vars = _gatherInputs(d, args, options);
  const userId = options.userId != null ? options.userId : null;
  const stepDelay = _parseStepDelay(
    options['step-delay'] != null ? options['step-delay'] : options.stepDelay
  );

  // Auto-enable desktop gate (temporarily). Respect stricter user choices:
  // only flip from 'off' → 'on'; leave 'ask'/'strict' as-is.
  const prevMode = process.env.KHY_DESKTOP_CONTROL;
  const needEnable = _desktopMode() === 'off';
  if (needEnable) {
    process.env.KHY_DESKTOP_CONTROL = 'on';
    if (!options.json) {
      printWarn('⚠ 已临时启用桌面操控（KHY_DESKTOP_CONTROL=on）用于本次回放');
    }
  }

  // Build wrapped primitives: inject workflowMode for batch authorization and
  // add an inter-step delay after each DesktopControl action.
  let base;
  if (d._deps.primitives) {
    base = d._deps.primitives;
  } else if (d.executor.defaultPrimitives) {
    base = d.executor.defaultPrimitives({ userId });
  } else {
    printError('无法构建执行原语（primitives 不可用）');
    if (needEnable) {
      if (prevMode === undefined) {
        delete process.env.KHY_DESKTOP_CONTROL;
      } else {
        process.env.KHY_DESKTOP_CONTROL = prevMode;
      }
    }
    return true;
  }
  const wfName = saved.name || slug;
  const primitives = {
    chat: (p, o) => base.chat(p, o),
    executeSkill: (n, p) => base.executeSkill(n, p),
    runSubAgent: (s) => base.runSubAgent(s),
    runCode: (l, s, vv) => base.runCode(l, s, vv),
    http: (r) => base.http(r),
    async executeTool(toolName, params) {
      // Inject workflow batch-authorization context so safetyGate can fast-path.
      const enriched =
        toolName === 'DesktopControl' && params && typeof params === 'object'
          ? { ...params, workflowMode: true, workflowName: wfName }
          : params;
      const result = await base.executeTool(toolName, enriched);
      // Inter-step delay for desktop actions only.
      if (stepDelay > 0 && toolName === 'DesktopControl') {
        await new Promise((r) => setTimeout(r, stepDelay));
      }
      return result;
    },
  };

  if (!options.json) {
    printInfo(chalk.cyan(`▶ 回放工作流:${saved.name || slug}`));
  }

  const graph = { nodes: saved.nodes, connections: saved.connections };
  let outcome;
  try {
    outcome = await d.executor.runGraph(graph, {
      primitives,
      vars,
      onLog: options.json
        ? undefined
        : (entry) => {
            const icon = entry.status === 'failed' ? '✗' : entry.status === 'skipped' ? '∅' : '✓';
            const tail = entry.summary ? '  ' + chalk.gray(entry.summary) : '';
            printInfo(`  ${icon} ${entry.type} ${chalk.gray('(' + entry.name + ')')}${tail}`);
          },
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ status: 'failed', error: msg, vars: (err && err.vars) || vars }) + '\n'
      );
      return true;
    }
    printError(`❌ 回放失败:${msg}`);
    return true;
  } finally {
    // Restore gate mode.
    if (needEnable) {
      if (prevMode === undefined) {
        delete process.env.KHY_DESKTOP_CONTROL;
      } else {
        process.env.KHY_DESKTOP_CONTROL = prevMode;
      }
    }
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(outcome) + '\n');
    return true;
  }
  if (outcome.status === 'paused') {
    printWarn(`⏸ 已暂停(${(outcome.pause && outcome.pause.kind) || 'askUserQuestion'})。`);
    return true;
  }
  printSuccess(`✅ 回放完成(${(outcome.log || []).length} 个节点）`);
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

// ── stats ────────────────────────────────────────────────────────────────────

// Format a duration in ms into a human-friendly string.
function _fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) {
    return '-';
  }
  if (n < 1000) {
    return `${Math.round(n)}ms`;
  }
  return `${(n / 1000).toFixed(1)}s`;
}

// Total run count = summary aggregate + unrolled detail entries (fail-soft → null).
function _totalRuns(d, name) {
  try {
    const dir = d.dataHome.getAppDataDir('workflow_stats');
    const slug = d.core.slugify(name);
    let summary = null;
    try {
      summary = JSON.parse(d.fs.readFileSync(d.path.join(dir, `${slug}.summary.json`), 'utf8'));
    } catch {
      summary = null;
    }
    let entries = [];
    try {
      entries = d.flowStats.parseJsonl(
        d.fs.readFileSync(d.path.join(dir, `${slug}.jsonl`), 'utf8')
      );
    } catch {
      entries = [];
    }
    const merged = d.flowStats.mergeSummary(summary, d.flowStats.aggregateEntries(entries));
    return merged.runs > 0 ? merged.runs : null;
  } catch {
    return null;
  }
}

function _doStats(d, args, options) {
  const name = String(args[0] || '').trim();
  if (!name) {
    printError('用法:khy workflow stats <名称>');
    return true;
  }

  const rate = d.flowStats.getSuccessRate(name);
  const avg = d.flowStats.getAvgDuration(name);
  const runs = d.flowStats.recentRuns(name, 10);
  const total = _totalRuns(d, name);

  if (rate == null && !runs.length) {
    printInfo(`流程「${name}」暂无执行记录`);
    return true;
  }

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        name,
        successRate: rate,
        avgDurationMs: avg,
        totalRuns: total,
        recentRuns: runs,
      }) + '\n'
    );
    return true;
  }

  printInfo(`流程「${chalk.bold(name)}」执行统计:`);
  printInfo(`  成功率:${rate == null ? '-' : (rate * 100).toFixed(1) + '%'}`);
  printInfo(`  平均耗时:${avg == null ? '-' : _fmtDuration(avg)}`);
  printInfo(`  总执行次数:${total == null ? '-' : total}`);
  if (runs.length) {
    printInfo(`  近 ${runs.length} 次执行(新→旧):`);
    for (const r of runs) {
      const ok = r.status === 'completed';
      const icon = ok ? chalk.green('✓') : chalk.red('✗');
      const parts = [
        `${icon} ${r.startedAt || '?'}`,
        ok ? '完成' : '失败',
        _fmtDuration(r.durationMs),
      ];
      if (!ok && r.failedStep) {
        parts.push(`失败步骤:${r.failedStep}`);
      }
      if (Number(r.retryTotal) > 0) {
        parts.push(`重试:${r.retryTotal}`);
      }
      printInfo('    ' + parts.join('  '));
    }
  }
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
  if (sub === 'help' || options.help) {
    _printHelp();
    return true;
  }

  const d = _resolveDeps(deps);
  d._deps = deps;

  switch (sub) {
    case 'import':
    case 'add':
      return _doImport(d, args, options);
    case 'list':
    case 'ls':
      return _doList(d, options);
    case 'show':
    case 'view':
      return _doShow(d, args, options);
    case 'validate':
    case 'check':
      return _doValidate(d, args, options);
    case 'run':
    case 'exec':
      return _doRun(d, args, options);
    case 'rm':
    case 'delete':
    case 'remove':
    case 'del':
      return _doRemove(d, args, options);
    case 'record':
      return _doRecord(d, args, options);
    case 'stop':
      return _doStop(d, args, options);
    case 'playback':
    case 'replay':
      return _doPlayback(d, args, options);
    case 'stats':
    case 'metrics':
      return _doStats(d, args, options);
    default:
      printWarn(`未知子命令:workflow ${subCommand}`);
      _printHelp();
      return true;
  }
}

module.exports = { handleWorkflow };
