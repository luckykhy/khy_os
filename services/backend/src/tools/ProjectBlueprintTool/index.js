'use strict';

const { BaseTool } = require('../_baseTool');
const blueprint = require('../../services/projectBlueprint');

/**
 * ProjectBlueprintTool — 教 khyos 一种类型一种类型地交付项目，弱模型/短上下文也能干成。
 *
 * 知识不压在提示词里，而活在可检索的蓝图数据里——模型每次只取当前里程碑需要的一小片。
 * 全模式只读：本工具只「给知识/计划/脚手架内容」，绝不落盘；真正写文件由模型用
 * scaffold_files 工具完成（那一步自带 high 风险闸）。
 *
 * mode:
 *   catalog   — 列出全部可构建原型(archetype) + 概念知识卡(concept)
 *   match     — 按目标文本命中原型或概念
 *   plan      — 取某原型的里程碑总览(紧凑目录，不含文件正文)
 *   milestone — 取第 N 个里程碑的可执行切片(按上下文窗口收紧体积)
 *   concept   — 取一张概念知识卡(MVC/DDD/CQRS/RAG/LoRA…)
 *   scaffold  — 渲染脚手架(scaffoldFiles 兼容的 directories/files)，供模型转交 scaffold_files
 *   verify    — 探测一个项目目录的构建/启动计划
 *
 * 推荐流：match → plan → 逐 milestone 照着写 → scaffold 拿骨架 → verify 收尾。
 */
class ProjectBlueprintTool extends BaseTool {
  static toolName = 'ProjectBlueprint';
  static category = 'coordinator';
  static risk = 'low';
  // `build_project` intentionally omitted — it is the exact name of a real,
  // side-effecting build tool (tools/buildProject.js, execution/medium). This
  // read-only planner (coordinator/low) must not claim that key: exact-name
  // resolution already shadowed the alias (making it dead), but listing it was a
  // latent foot-gun that also crossed risk/category tiers. Removed for a single,
  // unambiguous owner of the `buildproject` normalized key.
  static aliases = ['blueprint', 'project_blueprint', '项目蓝图'];
  static searchHint = '项目蓝图 脚手架 里程碑 怎么做项目 SSM Spring MVC DDD CQRS SOA EDA BFF 网关 SPA SSR SSG RAG RLHF LoRA OLTP OLAP ETL CDC project blueprint scaffold milestone';

  // 全模式只读：只返回知识/计划/脚手架数据，不写文件。
  isReadOnly() { return true; }
  isDestructive() { return false; }

  prompt() {
    return [
      '按类型交付项目的蓝图引擎：把「一次造一整个项目」拆成有序里程碑，逐阶段按需取一小片，',
      '专为小模型 / 短上下文设计——知识活在可检索数据里，不靠背全书。',
      '',
      'mode:',
      '  catalog   — 列全部可构建原型 + 概念知识卡',
      '  match     — 按目标(如「做一个SSM项目」)命中原型/概念',
      '  plan      — 看某原型的里程碑目录(标题/产物/验收，不含正文)',
      '  milestone — 取第 index 个里程碑的可执行切片(步骤/产物/验收)，体积随窗口自适应',
      '  concept   — 取一张概念卡(MVC/DDD/CQRS/SOA/EDA/BFF/API网关/SPA/SSR/SSG/JAM/OLTP/OLAP/ETL/CDC/RAG/RLHF/LoRA)',
      '  scaffold  — 渲染脚手架(directories+files)；要落盘请把结果交给 scaffold_files 工具',
      '  verify    — 探测项目目录的构建/启动计划',
      '',
      '推荐流：match → plan → 逐 milestone 照着建 → scaffold 拿可编译骨架 → verify 收尾。',
      '小模型建议：每次只取一个 milestone，写完该阶段文件再取下一个，避免一次塞满窗口。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: '操作模式',
          enum: ['catalog', 'match', 'plan', 'milestone', 'concept', 'scaffold', 'verify'],
          default: 'catalog',
        },
        target: {
          type: 'string',
          description: 'plan/milestone/scaffold 的原型 id 或目标文本(如 "ssm"/"做个SSM项目")；concept 的概念 id 或触发词；match 的目标文本；verify 的目录路径',
        },
        index: {
          type: 'number',
          description: 'milestone 模式：里程碑序号(从 0 开始)',
          default: 0,
        },
        variables: {
          type: 'object',
          description: 'scaffold 模式：模板变量覆盖(如 {groupId, artifactId, javaVersion})',
        },
        contextWindow: {
          type: 'number',
          description: '当前模型上下文窗口(tokens)。短窗口会自动收紧 milestone 切片体积；省略=按默认',
        },
      },
      required: [],
    };
  }

  async execute(params = {}) {
    const mode = params.mode || 'catalog';
    const opts = { contextWindow: params.contextWindow };

    switch (mode) {
      case 'catalog': {
        const all = blueprint.listAll();
        return { success: true, mode, ...all };
      }
      case 'match': {
        const m = blueprint.match(params.target);
        return { success: true, mode, ...m };
      }
      case 'plan': {
        const p = blueprint.plan(params.target);
        if (p.ok === false) return { success: false, mode, error: p.error };
        return { success: true, mode, ...p, report: blueprint.renderPlanReport(p) };
      }
      case 'milestone': {
        const slice = blueprint.milestone(params.target, params.index, opts);
        if (slice.ok === false) return { success: false, mode, error: slice.error };
        return { success: true, mode, ...slice };
      }
      case 'concept': {
        const c = blueprint.concept(params.target);
        if (c.ok === false) return { success: false, mode, error: c.error };
        return { success: true, mode, ...c };
      }
      case 'scaffold': {
        const s = blueprint.scaffold(params.target, { variables: params.variables || {} });
        if (s.ok === false) return { success: false, mode, error: s.error };
        return {
          success: true,
          mode,
          archetype: s.archetype,
          variables: s.variables,
          directories: s.directories,
          files: s.files,
          hint: '这是脚手架内容(未落盘)。要创建文件，请把 directories+files 交给 scaffold_files 工具(它带 high 风险闸)。',
        };
      }
      case 'verify': {
        const v = blueprint.verify(params.target);
        if (v.ok === false) return { success: false, mode, error: v.error };
        return { success: true, mode, ...v };
      }
      default:
        return { success: false, mode, error: `未知 mode: ${mode}` };
    }
  }

  getActivityDescription(input) {
    const mode = (input && input.mode) || 'catalog';
    const map = {
      catalog: '列出项目蓝图目录',
      match: '匹配项目蓝图',
      plan: '规划项目里程碑',
      milestone: '取里程碑切片',
      concept: '查概念知识卡',
      scaffold: '渲染项目脚手架',
      verify: '探测项目构建计划',
    };
    return map[mode] || '项目蓝图';
  }
}

module.exports = ProjectBlueprintTool;
