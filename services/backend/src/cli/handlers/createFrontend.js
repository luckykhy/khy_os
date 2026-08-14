'use strict';

/**
 * Create Frontend Command Handler — `khy create-frontend …`.
 *
 * A thin CLI orchestration entry: the user describes the frontend they want in
 * natural language, and the existing agentic loop autonomously plans and builds
 * a large multipage Vue project. This handler NEVER runs its own execution
 * engine — it assembles a guiding task description and hands it to the same AI
 * loop entry used by `khy goal` (the `aiForward` return contract), so the REPL /
 * TUI main loop drives one agentic round through toolUseLoop / the agentic
 * harness, with the read-only ProjectBlueprint tool available for planning.
 *
 * Flow the AI is instructed to follow (via ProjectBlueprint):
 *   match(archetype) → plan(milestones) → per-milestone slice + scaffold_files /
 *   writeFile → per-stage verify → final verify + npm install + npm run build.
 *
 *   create-frontend <自然语言需求…> [--name <项目名>] [--dir <目标目录>]
 *
 * @module handlers/createFrontend
 */

const path = require('path');

const { printInfo, printError } = require('../formatters');

// Naming contract shared with the parallel data-file agent. The handler only
// references these ids/names; it never creates or edits the archetype/template
// JSON (those live under blueprints/ and templates/, owned by another agent).
const ARCHETYPE_ID = 'vue-multipage';
const TEMPLATE_NAME = 'vue-multipage';
// Fallback project name (not an endpoint/host/path — safe under the
// zero-hardcode rule) used only when the user gives no --name.
const DEFAULT_PROJECT_NAME = 'vue-multipage-app';

/**
 * Print Chinese usage examples when the user supplies no requirement text.
 * @returns {number}
 */
function _printUsage() {
  printInfo('用法：create-frontend <自然语言需求描述> [--name <项目名>] [--dir <目标目录>]');
  printInfo('说明：用一句话描述你想要的前端工程，由 AI 自主规划并生成大型 Vue 多页工程。');
  printInfo('示例：');
  printInfo('  create-frontend 做一个带登录、仪表盘和用户管理的后台管理系统');
  printInfo('  create-frontend 电商前端：首页/商品列表/购物车/订单 --name shop-web');
  printInfo('  create-frontend 数据可视化大屏，含多个图表页面 --name bi-dash --dir ./frontend');
  printInfo(
    `原型：${ARCHETYPE_ID}（模板 ${TEMPLATE_NAME}）。目录默认取当前目录下以项目名命名的子目录。`
  );
  return 0;
}

/**
 * Resolve the project name from options, falling back to a safe default.
 * @param {object} options
 * @returns {string}
 */
function _resolveProjectName(options) {
  const raw = options && (options.name || options.n || options['项目名']);
  const name = String(raw == null ? '' : raw).trim();
  return name || DEFAULT_PROJECT_NAME;
}

/**
 * Resolve the target directory. Defaults to <cwd>/<projectName>. Dynamic only —
 * never a hardcoded absolute path.
 * @param {object} options
 * @param {string} projectName
 * @returns {string}
 */
function _resolveTargetDir(options, projectName) {
  const raw =
    options &&
    (options.dir || options.output || options.o || options.target || options['目标目录']);
  const dir = String(raw == null ? '' : raw).trim();
  if (dir) {
    return path.resolve(process.cwd(), dir);
  }
  return path.resolve(process.cwd(), projectName);
}

/**
 * Assemble the guiding task description handed to the existing agentic loop.
 * It pins the ProjectBlueprint flow and the buildable-verification finish line,
 * with explicit action + target + progress status guidance.
 * @param {object} ctx - { requirement, projectName, targetDir }
 * @returns {string}
 */
function _buildKickoffMessage({ requirement, projectName, targetDir }) {
  return [
    '请生成一个大型前端工程。全程使用既有工具自主规划与落盘，不要向我反问，直接开始并持续推进到可构建为止。',
    '',
    `用户需求：${requirement}`,
    `项目名：${projectName}`,
    `目标目录：${targetDir}`,
    '',
    '严格按以下流程执行（使用 ProjectBlueprint 工具，全程只读取知识/计划，落盘用 scaffold_files / writeFile）：',
    `1) ProjectBlueprint mode=match，target 传用户需求，确认命中原型 ${ARCHETYPE_ID}（模板 ${TEMPLATE_NAME}）。`,
    `2) ProjectBlueprint mode=plan，target=${ARCHETYPE_ID}，取里程碑总目录，明确里程碑数量与各自产物/验收。`,
    '3) 从 index=0 开始，逐个里程碑：ProjectBlueprint mode=milestone 取当前切片 → 结合用户需求把该阶段文件用 scaffold_files（骨架）或 writeFile（具体页面/组件/路由/状态）逐个落盘到目标目录。',
    '4) 每个里程碑结束后做一次阶段校验：确认该阶段应产出的文件已存在且内容完整，再取下一个里程碑；未通过则在本阶段内补齐后再推进。',
    `5) 全部里程碑完成后：ProjectBlueprint mode=verify，target=目标目录，得到构建/启动计划；随后在目标目录执行 npm install 与 npm run build，验证工程可构建；有报错则定位修复后重试构建。`,
    '',
    '进度汇报规范（每一步都要带【动作 + 目标 + 进度】）：',
    '  例如「生成 src/views/Dashboard.vue（里程碑 5/7，文件 3/6）」、「执行 npm install（前端依赖安装，重试 1/3）」。',
    '所有页面/组件/路由/状态管理都要围绕用户需求落地，产出真正可运行、可构建的 Vue 多页工程。',
  ].join('\n');
}

/**
 * Handle `khy create-frontend …`.
 *
 * Reuses the existing AI loop entry via the `{ code, aiForward }` return
 * contract (same mechanism as handlers/goal.js). The router forwards `aiForward`
 * to the REPL/TUI main loop, which runs one agentic round — no bespoke while
 * loop calling the AI here.
 *
 * @param {string|null} subCommand - First token after the command (part of the requirement text)
 * @param {string[]} [args] - Remaining positional tokens (rest of the requirement text)
 * @param {object} [options] - Parsed flags (--name/--dir/…)
 * @returns {number | { code: number, aiForward: string }}
 */
function handleCreateFrontend(subCommand, args = [], options = {}) {
  try {
    if (options && (options.help || options.h)) {
      return _printUsage();
    }

    // There are no real subcommands: the whole free-form tail is the requirement.
    const parts = [];
    if (subCommand != null) {
      parts.push(String(subCommand));
    }
    if (Array.isArray(args)) {
      parts.push(...args.map((a) => String(a)));
    }
    const requirement = parts.join(' ').trim();

    if (!requirement) {
      return _printUsage();
    }

    const projectName = _resolveProjectName(options);
    const targetDir = _resolveTargetDir(options, projectName);
    const kickoff = _buildKickoffMessage({ requirement, projectName, targetDir });

    printInfo(`规划前端工程 ${projectName}（原型 ${ARCHETYPE_ID}，输出目录 ${targetDir}）`);
    printInfo(
      '移交既有 AI 循环自主执行：match → plan → 逐里程碑落盘 → 阶段校验 → verify + 构建验证。'
    );

    // Hand off to the existing agentic loop entry (do NOT loop the AI here).
    return { code: 0, aiForward: kickoff };
  } catch (e) {
    printError(`创建前端工程失败：${(e && e.message) || e}`);
    return 1;
  }
}

module.exports = { handleCreateFrontend };
