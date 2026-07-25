'use strict';

/**
 * safetyNotice.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「学 CC 显示但**更重背后逻辑**·第一次在陌生文件夹启动会不会像
 * CC 一样做安全提示」。CC 的首次引导 `src/components/Onboarding.tsx:82-112`(securityStep)
 * 对**每一个**首次用户**无条件**展示一屏安全须知(Onboarding.tsx:157 恒 push):
 *   Before you start, keep in mind:
 *     1. Always review changes before accepting
 *        Claude can make mistakes — especially when running commands or editing
 *        files. You stay in control of every action.
 *     2. Only use Claude Code on projects you trust
 *        Untrusted code could contain prompt injection attacks.
 *        https://code.claude.com/docs/en/security
 *
 * 真缺口(核实后):khy 的引导向导 `cli/onboarding.js` **只做模型/API Key 配置**,
 * 全程不含任何「审阅改动 / 提示词注入」安全教育。另两处安全面也不是这块内容:
 *   - 每文件夹信任门 `workspaceTrust.js`(「这是你信任的项目吗?」)是**准入闸**,
 *     不讲「接受前审阅」原则,也不点名 prompt injection;
 *   - `onboarding/onboardingPlan.js` 只重渲染只读的信任**状态**。
 * → CC 的两条安全原则在 khy **无处触达用户**。本叶子把这屏须知补成 CC 对齐的中文版,
 *   由 `cli/onboarding.js` 在引导全文后注入。
 *
 * 门控 KHY_ONBOARDING_SAFETY_NOTICE(默认开;{0,false,off,no} 关)。关 →
 * `buildSafetyNoticeLines` 返回空数组 → 调用方 for-of 零行输出 → 逐字节回退今日引导。
 *
 * 纯度:只产**未着色**的行数组,着色 / 打印 / 「按 Enter 继续」等交互全留调用方
 * (与 workspaceTrust.buildTrustPromptLines / rewindNotice 同范式)。
 *
 * 诚实边界(刻意):① CC 的 securityStep 用 `<PressEnterToContinue/>` **阻塞**要求用户
 * 显式确认后才进下一步;本刀只把内容**内联**在紧随其后的「现在配置模型吗?」列表提示**之前**
 * 展示(内容已触达=核心缺口已补),显式阻塞式确认留作后续可选精化,以保持薄壳零新增交互轮;
 * ② 仅覆盖**交互式**引导路径(真首次用户所在);非交互(管道 / 无 TTY)路径只打印引导即退出,
 * 不塞安全屏,避免污染脚本输出(honest-NA);③ 中文无复数,原则计数直接数字内联。
 */

const _OFF = ['0', 'false', 'off', 'no'];

// CC 安全指南链接(Onboarding.tsx:106 / TrustDialog.tsx:207 同一 URL)。
const SECURITY_URL = 'https://code.claude.com/docs/en/security';

/**
 * 是否展示首次安全须知。默认开(unset → 开)。fail-soft:任意形状先 String 化。
 * @param {object} [env]
 * @returns {boolean}
 */
function safetyNoticeEnabled(env = process.env) {
  const raw = env && env.KHY_ONBOARDING_SAFETY_NOTICE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/**
 * 构造首次安全须知的**未着色**行数组(CC Onboarding.tsx securityStep 中文对齐)。
 * 门控关 → 返回 `[]`(调用方零输出,逐字节回退)。绝不抛。
 * @param {object} [env]
 * @returns {string[]}
 */
function buildSafetyNoticeLines(env = process.env) {
  if (!safetyNoticeEnabled(env)) return [];
  return [
    '开始之前,请记住:',
    '',
    '  1. 接受前务必审阅每一处改动',
    '     模型可能出错——尤其在运行命令或编辑文件时。每一步操作都由你掌控。',
    '',
    '  2. 只在你信任的项目上使用 khy',
    '     不受信任的代码可能包含提示词注入攻击(prompt injection)。',
    `     安全指南:${SECURITY_URL}`,
  ];
}

module.exports = { safetyNoticeEnabled, buildSafetyNoticeLines, SECURITY_URL };
