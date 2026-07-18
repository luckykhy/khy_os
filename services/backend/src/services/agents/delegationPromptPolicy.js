'use strict';

/**
 * delegationPromptPolicy.js — 纯叶子:零 IO、确定性、绝不抛、单一真源。
 *
 * Goal「教会 Khyos 怎么写提示词,这样 boss ai 派发给员工 ai 时可以更好地干活」
 * (2026-06-28 Stop hook)。
 *
 * 真缺口:boss(主代理)经 Agent 工具把任务派发给 worker(子代理)时,派发提示词的
 * 质量直接决定 worker 产出的上限——子代理看不到父对话,只拿到 prompt 本身。仓库里
 * 教 boss「怎么写派发提示词」的指引(agents/prompt.js 的 writingThePromptSection)
 * 早已存在,但只是一段松散散文、没有单一真源,也没有结构化的「填空式」清单。本叶子
 * 把「一份好的派发提示词应当覆盖什么」收敛成**确定性的结构化教程**(SSOT):目标 /
 * 已掌握的上下文 / 精确指针 / owned 范围与非目标 / 验收标准 / 输出契约 / 自治与升级,
 * 外加两条红线(绝不外包理解、绝不重复已派发的工作)。
 *
 * 它**只教 boss 怎么写**,绝不编造任务事实——返回的是教学/结构本身,不掺入具体任务内容。
 *
 * 门控 KHY_DELEGATION_PROMPT(默认开,仅显式 0/false/off/no 关闭);关闭时
 * resolveWritingThePromptSection 逐字节回退到既有 writingThePromptSection 文案。
 * 与子代理执行纪律(agents/constraints.js 的 SUBAGENT_EXECUTION_SCOPE,worker 侧)正交:
 * 本叶子只管 boss 侧「怎么把活儿讲清楚」,那一处只管 worker 侧「拿到活儿怎么执行」。
 */

// ── env 门控(默认开,仅 0/false/off/no 关)──────────────────────────────
const DELEGATION_PROMPT_GATE = 'KHY_DELEGATION_PROMPT';
const _OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 派发提示词教学是否启用。默认开;仅显式 0/false/off/no(大小写不敏感)关闭。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function isDelegationCoachingEnabled(env = process.env) {
  try {
    const v = (env || {})[DELEGATION_PROMPT_GATE];
    if (v === undefined || v === null) return true;
    return !_OFF.has(String(v).trim().toLowerCase());
  } catch {
    return true; // fail-soft:无法判定时维持默认开
  }
}

/**
 * 既有文案(门控关时的逐字节回退源)。必须与 agents/prompt.js 历史上的
 * writingThePromptSection 字符串**完全一致**——它是字节回退的契约。
 * @type {string}
 */
const LEGACY_WRITING_SECTION = `

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
**Never duplicate delegated work.** If an agent is already researching a slice of the problem, do not repeat the same searches locally unless the returned result is incomplete or conflicting.
`;

/**
 * 升级版「怎么写派发提示词」教程——结构化、确定性的「填空式」清单(SSOT)。
 *
 * 这是既有 LEGACY_WRITING_SECTION 的严格细化:同样的「智慧同事刚进门」框架,
 * 但把「一份好的派发提示词覆盖什么」拆成可逐条对照的七要素 + 三条红线,
 * 让 boss 把活儿讲到 worker 能据此独立判断、而非照本宣科。
 *
 * 纯文案:不含任何随机/时钟/具体任务内容,可单测。
 * @returns {string}
 */
function buildDelegationPromptGuide() {
  return `

## Writing the prompt

A sub-agent is a smart colleague who just walked in: it cannot see this conversation, doesn't know what you've tried, and doesn't know why the task matters. A terse, command-style prompt produces shallow, generic work — the brief you write IS the quality ceiling of what comes back. Hand over a complete, self-contained brief that covers:
- **Objective** — one sentence on what "done" looks like and why it matters. The agent makes better judgment calls when it knows the goal, not just the next step.
- **Context already gathered** — what you've learned, tried, or ruled out, and the surrounding problem. Don't make the agent rediscover what you already know.
- **Exact pointers** — file paths, line numbers, symbols, and the precise commands or queries. Lookups: hand over the exact command. Investigations: hand over the question, not prescribed steps — fixed steps become dead weight when the premise turns out wrong.
- **Owned scope and non-goals** — name the files, modules, or responsibility the agent owns, and state explicitly what is out of scope so it does not broaden the task.
- **Acceptance criteria** — the checkable condition the agent must verify against before reporting done (a passing test, a clean build, a reproduction that no longer fires).
- **Output contract** — the shape and size of the response you need ("report in under 200 words", "return the unified diff", "list findings as file:line ranked by severity").
- **Autonomy and escalation** — what to decide-and-proceed on versus stop-and-ask; and when blocked, try 2–3 adjusted attempts, then report what was tried plus the failure plus the next option instead of thrashing.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it" — that pushes the synthesis you should own onto the agent. Prove you understood: include the file paths, the line numbers, and what specifically to change.
**Never duplicate delegated work.** If an agent already owns a slice of the problem, don't repeat its searches locally unless its result comes back incomplete or conflicting.
**Match depth to the task.** Need a fact? Hand over the one exact command. Need judgment? Hand over the full problem framing so the agent can reason, not just execute.
`;
}

/**
 * boss 侧「怎么写派发提示词」段落的单一裁定点。
 * 门控开 → 升级版结构化教程;门控关 → 逐字节回退到既有文案。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function resolveWritingThePromptSection(env = process.env) {
  try {
    return isDelegationCoachingEnabled(env)
      ? buildDelegationPromptGuide()
      : LEGACY_WRITING_SECTION;
  } catch {
    return LEGACY_WRITING_SECTION; // fail-soft:任何异常都退回既有文案
  }
}

module.exports = {
  DELEGATION_PROMPT_GATE,
  isDelegationCoachingEnabled,
  buildDelegationPromptGuide,
  resolveWritingThePromptSection,
  LEGACY_WRITING_SECTION,
};
