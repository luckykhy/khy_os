'use strict';

/**
 * initVerifiers.js — `/init-verifiers` 命令薄壳:把「创建功能校验器技能」的多阶段脚手架指令
 * 注入到模型对话(经 aiForward),由模型据此扫描项目、问答、生成校验器技能。
 *
 * 对齐 Claude Code 的 init-verifiers(一个 prompt 型命令)。**背后逻辑**(多阶段指令文本的确定性
 * 构造 + 校验器命名约定)在纯叶子 verifierScaffoldPlan.js(单一真源);本薄壳只做:门控、解析项目
 * 技能目录、返回 `{ aiForward }`。
 *
 * **复用既有不另起炉灶**:
 *   - 注入机制 = 既有 aiForward(repl.js / App.js 消费,同 /ulw-loop、/learn);不另造注入缝。
 *   - 脚手架目标 = khy 真正可发现的技能约定 `<projectDir>/.khy/skills/<name>/{manifest.json,prompt.md}`
 *     (skills/index.js discoverAllSkills 的项目级路径),**不是** CC 的 `.claude/skills/<name>/SKILL.md`
 *     (khy 不发现该路径)——这是刻意的诚实分歧:对齐 CC 的「能力」,但落到 khy 真生效的结构上。
 *
 * 用法:`/init-verifiers`。门控 KHY_INIT_VERIFIERS 默认开;关 → 命令不接管(字节回退)。
 */

const { printInfo } = require('../formatters');
const leaf = require('../../services/skills/verifierScaffoldPlan');

/** 解析项目技能目录(展示用,相对项目根)。绝不硬编码绝对路径。 */
function _skillsDir() {
  return leaf.DEFAULT_SKILLS_DIR; // '.khy/skills'(相对项目根,模型在当前工作目录解析)
}

/**
 * @param {string} _subCommand 预留(无子命令)
 * @param {string[]} _args 预留
 * @returns {Promise<true | {aiForward:string}>}
 */
async function handleInitVerifiers(_subCommand, _args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('init-verifiers 命令未启用(KHY_INIT_VERIFIERS=off)。');
    return false;
  }

  const instructions = leaf.buildScaffoldInstructions({ skillsDir: _skillsDir() });
  printInfo('正在分析项目并准备创建功能校验器技能…');
  return { aiForward: instructions };
}

module.exports = { handleInitVerifiers };
