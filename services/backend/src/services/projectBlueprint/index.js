'use strict';

/**
 * projectBlueprint — 门面：教 khyos 一种类型一种类型地交付项目，弱模型/短上下文也能干成。
 *
 * 推荐使用流（也是 ProjectBlueprintTool 的 prompt 指引）：
 *   match(goal) → plan(id) 看里程碑目录 → 逐 milestone(id, i) 取切片照着写
 *   → scaffold(id, vars) 一把拿到可编译骨架 → verify(dir) 探测构建/启动计划。
 *
 * 透传子模块（catalog/milestonePlanner）便于单测；自身只做编排与渲染。
 */

const catalog = require('./catalog');
const planner = require('./milestonePlanner');
const projectTemplateService = require('../projectTemplateService');

let _stackConflict = null;
function stackConflict() {
  if (!_stackConflict) {
    try { _stackConflict = require('./stackConflict'); } catch { _stackConflict = { detectStackConflict: () => ({ conflict: false }) }; }
  }
  return _stackConflict;
}

let _detector = null;
function detector() {
  if (!_detector) _detector = require('../deploy/projectDetector');
  return _detector;
}

/** 全量目录：可构建原型 + 概念知识卡（紧凑列表）。 */
function listAll() {
  return {
    archetypes: catalog.listArchetypes().map((a) => ({
      id: a.id,
      label: a.label || a.id,
      templateName: a.templateName,
      milestoneCount: (a.milestones || []).length,
      triggers: a.triggers || [],
      summary: a.summary || '',
    })),
    concepts: catalog.listConcepts().map((c) => ({
      id: c.id,
      name: c.name || c.id,
      category: c.category || '',
      triggers: c.triggers || [],
      summary: c.summary || '',
    })),
  };
}

/**
 * 按目标文本命中：先试可构建原型，再试概念卡。
 *
 * 栈冲突守卫（KHY_BLUEPRINT_STACK_CONFLICT_GUARD，默认开）：当用户**明确点名**的数据库与命中
 * 原型绑定的持久层数据库不同时（如要 PostgreSQL 但唯一 Spring 原型是 MyBatis+MySQL），**降级**为
 * kind:'none'——模板不领跑（它本该是最后兜底），但附一条 reference 软指针（可参考其分层/REST/测试
 * 里程碑结构）+ conflict 明细 + guidance（持久层按点名的库自建）。门控关/无冲突/叶子异常 → 逐字节
 * 回退旧的 kind:'archetype'。
 *
 * @param {string} goal
 * @returns {{ kind:'archetype'|'concept'|'none', match:object|null, conflict?:object, reference?:object, guidance?:string }}
 */
function match(goal) {
  const a = catalog.matchArchetype(goal);
  if (a) {
    let cf = { conflict: false };
    try { cf = stackConflict().detectStackConflict(goal, a) || { conflict: false }; } catch { cf = { conflict: false }; }
    if (cf.conflict) {
      // 降级：模板不领跑，但把它作为「仅结构参考」的软指针交回，让模型可取其里程碑而不自动采纳其持久层。
      return {
        kind: 'none',
        match: null,
        conflict: { requested: cf.requested, archetypeHas: cf.archetypeHas, dimension: cf.dimension },
        reference: {
          id: a.id,
          label: a.label || a.id,
          note: `仅作结构参考（分层/REST/测试里程碑）；其持久层是 ${cf.archetypeHas}，不要自动采纳，持久层按 ${cf.requested} 自建。`,
        },
        guidance: cf.guidance,
      };
    }
    return { kind: 'archetype', match: { id: a.id, label: a.label || a.id, templateName: a.templateName } };
  }
  const c = catalog.matchConcept(goal);
  if (c) return { kind: 'concept', match: { id: c.id, name: c.name || c.id } };
  return { kind: 'none', match: null };
}

function _resolveArchetype(idOrGoal) {
  return catalog.getArchetype(idOrGoal) || catalog.matchArchetype(idOrGoal);
}

/**
 * 里程碑总览（紧凑目录，不含文件正文）。
 * @param {string} idOrGoal
 * @returns {object|{error}}
 */
function plan(idOrGoal) {
  const a = _resolveArchetype(idOrGoal);
  if (!a) return { ok: false, error: `未找到可构建原型: ${idOrGoal}` };
  return { ok: true, ...planner.buildPlan(a) };
}

/**
 * 取第 index 个里程碑的可执行切片（按窗口收紧体积）。
 * @param {string} idOrGoal
 * @param {number} index
 * @param {object} [opts] - { contextWindow }
 */
function milestone(idOrGoal, index, opts = {}) {
  const a = _resolveArchetype(idOrGoal);
  if (!a) return { ok: false, error: `未找到可构建原型: ${idOrGoal}` };
  return planner.milestoneSlice(a, Number(index) || 0, opts);
}

/**
 * 取概念知识卡。
 * @param {string} idOrTrigger
 */
function concept(idOrTrigger) {
  const c = catalog.getConcept(idOrTrigger) || catalog.matchConcept(idOrTrigger);
  if (!c) return { ok: false, error: `未找到概念卡: ${idOrTrigger}` };
  return {
    ok: true,
    id: c.id,
    name: c.name || c.id,
    category: c.category || '',
    triggers: c.triggers || [],
    summary: c.summary || '',
    whenToUse: c.whenToUse || [],
    antiPatterns: c.antiPatterns || [],
    minimalSkeleton: c.minimalSkeleton || '',
    relatedArchetypes: c.relatedArchetypes || [],
  };
}

/**
 * 出脚手架（委派 projectTemplateService.renderTemplate，输出 scaffoldFiles 兼容）。
 * 注意：本函数只「生成内容」，不落盘；真正写文件由模型用 scaffold_files 工具完成（自带 high 闸）。
 * @param {string} idOrGoal
 * @param {object} [opts] - { variables }
 * @returns {{ ok, directories, files, variables }|{error}}
 */
function scaffold(idOrGoal, opts = {}) {
  const a = _resolveArchetype(idOrGoal);
  if (!a) return { ok: false, error: `未找到可构建原型: ${idOrGoal}` };
  if (!a.templateName) return { ok: false, error: `原型 ${a.id} 未关联脚手架模板` };
  try {
    const rendered = projectTemplateService.renderTemplate(a.templateName, opts.variables || {});
    return { ok: true, archetype: a.id, ...rendered };
  } catch (err) {
    return { ok: false, error: `脚手架渲染失败: ${err && err.message}` };
  }
}

/**
 * 探测一个项目目录的构建/启动计划（委派 deploy/projectDetector）。
 * @param {string} dir
 * @param {object} [opts]
 */
function verify(dir, opts = {}) {
  if (!dir) return { ok: false, error: '缺少目录参数' };
  try {
    const detected = detector().detectProject(dir, opts);
    return { ok: true, dir, plan: detected };
  } catch (err) {
    return { ok: false, error: `探测失败: ${err && err.message}` };
  }
}

/** ASCII 框：里程碑总览的人类可读渲染。 */
function renderPlanReport(p) {
  if (!p || p.ok === false) return `（无可渲染计划: ${p && p.error || '未知'}）`;
  const lines = [];
  const title = `项目蓝图: ${p.label || p.id}`;
  const width = Math.max(40, ...[title, ...p.milestones.map((m) => `  ${m.index + 1}. ${m.title} (${m.fileCount} 文件)`)].map((s) => s.length)) + 2;
  const bar = '─'.repeat(width);
  lines.push(`┌${bar}┐`);
  lines.push(`│ ${title.padEnd(width - 1)}│`);
  lines.push(`├${bar}┤`);
  for (const m of p.milestones) {
    const row = `  ${m.index + 1}. ${m.title} (${m.fileCount} 文件)`;
    lines.push(`│ ${row.padEnd(width - 1)}│`);
  }
  lines.push(`└${bar}┘`);
  if (p.build) {
    const b = p.build;
    if (b.install) lines.push(`安装: ${b.install}`);
    if (b.run) lines.push(`运行: ${b.run}`);
    if (b.port) lines.push(`端口: ${b.port}`);
  }
  lines.push(`用法: 逐个取里程碑切片(milestone 模式)照着建，或 scaffold 一把拿骨架。`);
  return lines.join('\n');
}

module.exports = {
  listAll,
  match,
  plan,
  milestone,
  concept,
  scaffold,
  verify,
  renderPlanReport,
  // 透传子模块（测试/外部可见）
  catalog,
  planner,
};
