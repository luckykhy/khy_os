'use strict';

/**
 * verifierScaffoldPlan.js — `/init-verifiers` 的「校验器命名 + 多阶段脚手架指令文本构造」零 IO
 * 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;只读入参,绝不读 process.env、绝不触文件、
 * 绝不 spawn、绝不调 Date。无任何依赖。
 *
 * 背后的逻辑(对齐 Claude Code `init-verifiers`):CC 的 init-verifiers 是 **prompt 型命令** ——
 * 它本身没有后端逻辑,只返回一段约 240 行的多阶段指令文本喂给模型,由模型据此扫描项目、问答、
 * 把「校验器」脚手架成技能文件。CC 的校验器 = `.claude/skills/<name>/SKILL.md`(靠目录名含
 * "verifier" 子串被 Verify agent 发现)。
 *
 * **诚实分歧(刻意与 CC 不同)**:khy **没有** `.claude/skills` 发现路径,`SKILL.md` 只是 legacy
 * 兜底;khy 真正可发现的技能约定(System A `skills/index.js discoverAllSkills`)是
 * `<projectDir>/.khy/skills/<name>/{manifest.json, prompt.md}`。故本指令文本让模型脚手架成 khy
 * **真能发现**的那种结构(manifest.json + prompt.md),而非照抄 CC 的 `.claude/skills/SKILL.md`
 * ——否则就是「对齐在纸面、生成的校验器 khy 根本发现不了」的假对齐。命名沿用 CC 的「含 verifier
 * 子串」约定 + tags 含 "verifier",便于将来按约定发现。
 *
 * 真正的「注入到模型对话」由薄壳 handlers/initVerifiers.js 经 `{ aiForward: <text> }` 完成
 * (复用既有 /ulw-loop、/learn 同款 aiForward 机制);本叶子只**确定性地构造那段文本**。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const DEFAULT_SKILLS_DIR = '.khy/skills'; // khy System A 项目级技能发现路径(绝不写 .claude/skills)

// 三类功能校验器(对齐 CC:Web UI / CLI / API),各自推荐的本地工具(prose 指引,非 khy frontmatter schema)。
const VERIFIER_TYPES = [
  {
    type: 'playwright',
    name: 'verifier-playwright',
    appType: 'web',
    summary: 'Web UI 端到端校验(Playwright / 浏览器自动化 MCP)',
    tools: 'Bash(npm/yarn/pnpm/bun)、浏览器自动化 MCP、Read、Glob、Grep',
  },
  {
    type: 'cli',
    name: 'verifier-cli',
    appType: 'cli',
    summary: 'CLI 校验(在 tmux / 终端里跑命令并断言输出)',
    tools: 'Tmux、Bash、Read、Glob、Grep',
  },
  {
    type: 'api',
    name: 'verifier-api',
    appType: 'api',
    summary: 'HTTP API 校验(curl / http 打本地服务断言响应)',
    tools: 'Bash(curl/http/npm/yarn)、Read、Glob、Grep',
  },
];

function _slug(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * 由应用类型推导校验器名(对齐 CC 命名约定:单一领域 → verifier-<type>)。
 * @param {string} appType  'web'|'cli'|'api'(其它 → 通用 'verifier')
 * @returns {string}
 */
function planVerifierName(appType) {
  const t = String(appType == null ? '' : appType).trim().toLowerCase();
  const hit = VERIFIER_TYPES.find((v) => v.appType === t || v.type === t);
  return hit ? hit.name : 'verifier';
}

/**
 * 多领域项目命名(对齐 CC:多领域 → verifier-<project>-<type>)。
 * @param {string} projectName
 * @param {string} appType
 * @returns {string}
 */
function planVerifierNameScoped(projectName, appType) {
  const proj = _slug(projectName);
  const type = String(appType == null ? '' : appType).trim().toLowerCase();
  const typeHit = VERIFIER_TYPES.find((v) => v.appType === type || v.type === type);
  const typeTok = typeHit ? typeHit.type : 'app';
  if (!proj) return `verifier-${typeTok}`;
  return `verifier-${proj}-${typeTok}`;
}

/**
 * 构造给模型的多阶段脚手架指令文本(对齐 CC init-verifiers 的 Phase 1-5,目标改 khy 真发现约定)。
 * @param {object} [opts]
 *   @param {string} [opts.skillsDir]  项目技能目录(展示用,默认 '.khy/skills')
 * @returns {string}
 */
function buildScaffoldInstructions(opts = {}) {
  const skillsDir = String(opts && opts.skillsDir ? opts.skillsDir : DEFAULT_SKILLS_DIR);

  const typeLines = VERIFIER_TYPES
    .map((v) => `  - \`${v.name}\` — ${v.summary};推荐工具:${v.tools}`)
    .join('\n');

  return [
    '为本项目创建「功能校验器」技能(对齐 Claude Code init-verifiers,但脚手架到 khy 真正可发现的技能约定)。',
    '校验器 = 一个可被 khy 技能系统发现的技能,用真实运行(而非单元测试/类型检查)验证功能端到端可用。',
    '',
    '**只创建功能校验器**(UI / CLI / API),刻意排除单元测试与类型检查。',
    '',
    '## Phase 1 — 自动探测(只读)',
    '扫描项目根的顶层目录,识别:语言/框架/包管理器(package.json / Cargo.toml / pyproject.toml / go.mod);',
    '应用类型(web / CLI / API);已有测试或 E2E 工具;开发服务器命令、URL、就绪信号;已装的浏览器自动化',
    '(package.json 里的 Playwright、`.mcp.json` 里的浏览器 MCP)。先用 Read/Glob/Grep 收集事实,不要臆测。',
    '',
    '## Phase 2 — 工具准备(需用户同意)',
    '若缺少浏览器自动化且应用是 Web,可在征得用户同意后安装 Playwright 或配置浏览器自动化 MCP。',
    '未经同意不要安装依赖或改写 `.mcp.json`。',
    '',
    '## Phase 3 — 交互问答(用 AskUserQuestion)',
    '确认:校验器名、开发服务器启动命令、URL、就绪信号、登录/认证细节。',
    '**密钥安全**:认证用环境变量(如 `TEST_USER` / `TEST_PASSWORD`)引导,绝不把明文密钥写进技能文件。',
    '',
    '## Phase 4 — 生成校验器技能(写文件)',
    `把每个校验器写到 \`${skillsDir}/<name>/\`,**两个文件**(这是 khy 技能系统真正发现的结构):`,
    `  1) \`${skillsDir}/<name>/manifest.json\` — 至少含:`,
    '     `{ "name": "<name>", "command": "/<name>", "description": "...", "version": "1.0.0", "userInvocable": true, "tags": ["verifier", "<type>"] }`',
    '     —— `name` **必须含 "verifier" 子串**(发现约定),`tags` 含 "verifier"。',
    `  2) \`${skillsDir}/<name>/prompt.md\` — 校验器的执行说明正文,分节:`,
    '     项目背景、启动步骤(开发服务器命令/URL/就绪信号)、认证(可选,用环境变量)、',
    '     执行与断言、报告(明确 PASS / FAIL)、清理、自我更新。',
    '  **不要**写 `.claude/skills/<name>/SKILL.md`——khy 不发现该路径(那是 Claude Code 的约定)。',
    '',
    '## 命名约定',
    '单一领域 → 按类型命名:',
    typeLines,
    '多个领域 → `verifier-<project>-<type>`。',
    '',
    '## Phase 5 — 确认',
    `告诉用户每个校验器写到了哪里(\`${skillsDir}/<name>/\`),以及它们如何被发现(技能名/目录名含 "verifier")。`,
    '生成后,用户可像其它技能一样触发它们来做功能校验。',
  ].join('\n');
}

// 收敛到 utils/isOffValue 单一真源(逐字节委托,调用点不变)
const _falsy = require('../../utils/isOffValue');

/** 门控读取(KHY_INIT_VERIFIERS 默认开;关 → 命令不接管)。注入 env,叶子不读 process.env。 */
function isEnabled(env = {}) {
  return !_falsy(env && env.KHY_INIT_VERIFIERS === undefined ? 'true' : (env && env.KHY_INIT_VERIFIERS));
}

module.exports = {
  VERIFIER_TYPES,
  DEFAULT_SKILLS_DIR,
  planVerifierName,
  planVerifierNameScoped,
  buildScaffoldInstructions,
  isEnabled,
};
