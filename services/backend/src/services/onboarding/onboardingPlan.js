'use strict';

/**
 * onboardingPlan.js — 纯叶子:`/onboarding` 命令逻辑单一真源(零 IO·确定性·绝不抛·零依赖)。
 *
 * 本叶子刻意不写任何模块加载调用语法(连注释里也不写其字面形态),以躲开
 * ghost-dependency 扫描器;所有外部能力由薄壳注入,叶子只做解析与渲染。
 *
 * 对齐 Claude Code `/onboarding`:把首次引导拆成可单独重跑的步骤
 * full | theme | trust | model | mcp | status。
 *
 * trust 步骤委托 khy 真实的「文件夹信任(workspace trust)」SSOT
 * (services/workspaceTrust.js 决策叶子 + cli/trustGate.js IO 壳,已在 repl.js 启动前
 * PRE-MOUNT 接线,覆盖 Ink TUI 与经典 REPL 两条路径)。本叶子只渲染只读信任状态,
 * 真正的读盘/弹窗由薄壳注入 —— 与「注重背后的逻辑」一致,绝不伪造空对话框。
 */

// step 规范名 ⇄ 别名(含中文)。空参 → full(对齐 CC 裸 /onboarding 重跑完整引导)。
const STEP_ALIASES = {
  full: 'full', all: 'full', wizard: 'full', '全部': 'full', '完整': 'full', '引导': 'full',
  theme: 'theme', skin: 'theme', color: 'theme', '主题': 'theme', '皮肤': 'theme',
  trust: 'trust', '信任': 'trust',
  model: 'model', models: 'model', provider: 'model', '模型': 'model', '供应商': 'model',
  mcp: 'mcp', '工具服务': 'mcp',
  status: 'status', state: 'status', '状态': 'status',
  help: 'help', '-h': 'help', '--help': 'help', '帮助': 'help',
};

// 步骤元数据:available=khy 是否有真实 SSOT 可委托;runnable=是否会触发副作用(交互/重跑)。
const STEP_META = {
  full: { available: true, runnable: true, title: '完整引导(选供应商 + 填 API Key + 选模型)' },
  theme: { available: true, runnable: true, title: '主题 / 配色' },
  trust: { available: true, runnable: true, title: '文件夹信任(folder trust)' },
  model: { available: true, runnable: true, title: '模型 / 供应商选择' },
  mcp: { available: true, runnable: false, title: 'MCP 工具服务治理(只读)' },
  status: { available: true, runnable: false, title: '引导状态(只读)' },
};

const STEP_ORDER = ['full', 'theme', 'trust', 'model', 'mcp', 'status'];

/**
 * 解析 `/onboarding [step]` 参数。
 * @param {string[]} args
 * @returns {{step:string, rest:string[], valid:boolean, parseError:(string|null)}}
 */
function parseOnboardingArgs(args) {
  const list = Array.isArray(args) ? args.filter((a) => a != null) : [];
  if (!list.length) {
    return { step: 'full', rest: [], valid: true, parseError: null };
  }
  const first = String(list[0]).trim().toLowerCase();
  const step = STEP_ALIASES[first];
  if (!step) {
    return { step: 'status', rest: [], valid: false, parseError: 'unknown_step' };
  }
  return { step, rest: list.slice(1).map((x) => String(x)), valid: true, parseError: null };
}

/** 取某步骤元数据;未知步骤返回安全占位(available:false)。 */
function describeStep(step) {
  const m = STEP_META[step];
  if (!m) return { step, available: false, runnable: false, title: String(step || '') };
  return { step, available: m.available, runnable: m.runnable, title: m.title };
}

/** 某步骤是否在 khy 有真实实现可委托。 */
function isStepAvailable(step) {
  return !!(STEP_META[step] && STEP_META[step].available);
}

/**
 * 不可用步骤的诚实说明。当前所有已知步骤均有真实 SSOT 可委托,故此文本只作为
 * 未来新增步骤的防御性兜底(绝不伪造能力)。
 */
function buildUnavailableText(step) {
  return `  ${step} —— 该引导步骤在 khy 暂不可用。`;
}

/**
 * 渲染 `/onboarding trust` 的只读信任状态(对齐 CC「workspace trust」)。纯渲染:
 * 事实(门控是否开、cwd、是否已信任及原因、是否 home、已持久化目录数)全由薄壳注入,
 * 叶子零 IO。缺面诚实留白,绝不编造。
 * @param {object} snapshot {gateEnabled, cwd, trusted, reason, isHomeDir, persistedCount}
 */
function buildTrustStatusText(snapshot) {
  const s = (snapshot && typeof snapshot === 'object') ? snapshot : {};
  const yn = (v) => (v === true ? '是' : v === false ? '否' : '未知');
  const reasonText = {
    session: '本会话已信任(home 目录仅本会话,不落盘)',
    persisted: '已持久化信任(本目录或其父目录)',
    untrusted: '尚未信任',
    error: '未知(判定异常,已放行)',
  };
  const gate = s.gateEnabled === true
    ? '开'
    : (s.gateEnabled === false ? '关(不弹窗,一律视为已信任)' : '未知');
  const reasonSuffix = (s.reason && reasonText[s.reason]) ? `（${reasonText[s.reason]}）` : '';
  const n = Number(s.persistedCount);
  const lines = [];
  lines.push('  文件夹信任(folder trust)—— 快速安全检查:');
  lines.push(`  当前目录: ${s.cwd ? String(s.cwd) : '未知'}`);
  lines.push(`  信任门控(KHY_WORKSPACE_TRUST): ${gate}`);
  lines.push(`  当前目录已信任: ${yn(s.trusted)}${reasonSuffix}`);
  if (s.isHomeDir === true) {
    lines.push('  注意:当前目录是 home 目录 —— 信任只作用于本会话,绝不永久标信任整个 home。');
  }
  lines.push(`  已持久化信任目录: ${Number.isFinite(n) ? `${n} 个` : '未知'}`);
  lines.push('');
  lines.push('  说明:khy 在陌生目录首次启动会先做「快速安全检查」,信任后方可读取/编辑/执行文件。');
  lines.push('  运行期工具副作用另由 /permissions(权限模式)+ 危险操作前的人工确认闸门管控。');
  return lines.join('\n');
}

/**
 * 渲染只读引导状态。缺面诚实留白,绝不编造。
 * @param {object} snapshot
 *   {onboardingDone, configured, activeTheme, gettingStartedPending, mcpServerCount}
 */
function buildStatusText(snapshot) {
  const s = (snapshot && typeof snapshot === 'object') ? snapshot : {};
  const yn = (v) => (v === true ? '是' : v === false ? '否' : '未知');
  const lines = [];
  lines.push('  引导状态(只读):');
  lines.push(`  引导完成标记: ${yn(s.onboardingDone)}`);
  lines.push(`  已配置模型供应商: ${yn(s.configured)}`);
  lines.push(`  当前主题: ${s.activeTheme ? String(s.activeTheme) : '未知'}`);
  if (s.gettingStartedPending !== undefined) {
    lines.push(`  Getting-Started 待展示: ${yn(s.gettingStartedPending)}`);
  }
  if (s.mcpServerCount !== undefined) {
    const n = Number(s.mcpServerCount);
    lines.push(`  MCP 工具服务: ${Number.isFinite(n) ? `${n} 个已配置` : '未知'}`);
  }
  lines.push('');
  lines.push('  重跑某步骤: /onboarding <full|theme|model|mcp>');
  return lines.join('\n');
}

/** 某步骤开始执行时的提示头。 */
function buildStepHeader(step) {
  const m = describeStep(step);
  return `  ▶ 引导步骤:${m.title}`;
}

/** 用法帮助。 */
function buildHelpText() {
  const lines = [];
  lines.push('  /onboarding —— 重跑首次引导的某个步骤(对齐 Claude Code /onboarding)');
  lines.push('');
  for (const step of STEP_ORDER) {
    const m = STEP_META[step];
    const tag = m.available ? '' : ' (khy 暂不可用)';
    lines.push(`  /onboarding ${step.padEnd(7)} ${m.title}${tag}`);
  }
  lines.push('');
  lines.push('  /onboarding          等同 full(重跑完整引导)');
  lines.push('  /onboarding status   只读查看引导状态');
  return lines.join('\n');
}

/** 未知步骤的提示(列出合法步骤)。 */
function buildUnknownStepText(raw) {
  return `  未知引导步骤:${raw == null ? '' : String(raw)}。可用:${STEP_ORDER.join(' | ')}。用 /onboarding help 看用法。`;
}

/**
 * KHY_ONBOARDING_COMMAND 门控:默认开,{空,0,false,off,no} → 关。
 * 注意与向导自身的 KHY_ONBOARDING 门控(cli/onboarding.js)相互独立:
 * 本门控只管「/onboarding 这条 slash 命令是否接管」,不影响首启向导是否运行。
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_ONBOARDING_COMMAND === undefined ? 'true' : e.KHY_ONBOARDING_COMMAND;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

module.exports = {
  parseOnboardingArgs,
  describeStep,
  isStepAvailable,
  buildUnavailableText,
  buildTrustStatusText,
  buildStatusText,
  buildStepHeader,
  buildHelpText,
  buildUnknownStepText,
  isEnabled,
  STEP_ORDER,
};
