// khy.mobileAgent —— Roubao MobileAgent 的 JS 移植版（2026）。
//
// 设计借鉴：Turbo1123/roubao（基于阿里 X-PLUG MobileAgent-v3 的 Kotlin 重写）
//  - Manager：    规划 Agent —— 看完屏幕 + 历史 → 输出"下一步"（纯文本）
//  - Executor：   决策 Agent —— 看 Manager 的"下一步" → 决定调哪个 Tool + 传什么参数
//  - Reflector：  反思 Agent —— 看完 Tool 结果 → 决定"继续 / 调整 / 完成"
//  - Notetaker：  笔记 Agent —— 把关键事实/进度落 InfoPool；当前简化为可调用的 appendNote()
//
// 实现策略（与 ChatView 现有循环的差异）：
//  - 一次 run() 跑"用户说一句话 → 反复循环 → 输出最终结果"，而不是单轮对话里 5 轮 tool_call
//  - 主循环里有四类回调（onPhase / onNote / onToolCall / onFinish），让 AgentView 能画进度
//  - 复用现有 localTools / visionProvider / standalone，不引入新网络协议
//  - 走 Skills 层：先尝试匹配高置信度 Skill（Delegation 模式），不命中再走 GUI 自动化
//
// 与既有 ChatView 的关系：
//  - ChatView：通用对话 + 简单 tool_call 循环（用户跟 AI 闲聊场景）
//  - mobileAgent：复合任务（用户说一句"帮我点份外卖"→ 自动跑完整闭环）
//    两者并行存在；ChatView 不变；AgentView 调 mobileAgent.run()

import { streamChatCompletion } from './standalone.js';
import { localToolSchemas, executeLocalTool } from './localTools.js';
import { listSkills, runSkill, saveSkill } from './programRuntime.js';
import { operationStatus } from './status.js';

// ---------- InfoPool（精简版：执行历史 + 笔记）----------

const INFOPOOL_KEY = 'khy_agent_infopool_v1';
const MAX_RUNS = 50; // 最近 50 次执行，循环覆盖

export async function loadInfoPool() {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: INFOPOOL_KEY });
    return value ? JSON.parse(value) : { runs: [] };
  } catch { return { runs: [] }; }
}

async function saveInfoPool(pool) {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    // 保留最近 MAX_RUNS 条
    if (pool.runs.length > MAX_RUNS) pool.runs = pool.runs.slice(-MAX_RUNS);
    await Preferences.set({ key: INFOPOOL_KEY, value: JSON.stringify(pool) });
  } catch { /* 忽略写失败 */ }
}

export async function appendRun(run) {
  const pool = await loadInfoPool();
  pool.runs.push({ ...run, savedAt: new Date().toISOString() });
  await saveInfoPool(pool);
  return run;
}

export async function listRecentRuns(limit = 20) {
  const pool = await loadInfoPool();
  return pool.runs.slice(-limit).reverse();
}

export async function clearRuns() {
  await saveInfoPool({ runs: [] });
}

// ---------- Skill 匹配（轻量意图识别）----------

// 关键词命中 → Skill。比对 label + description + name + 关键词扩展。
// 命中后看 skill 是否有 steps（说明是可执行任务）→ Delegation
// 没有 steps 的（说明是纯 prompt 流程）→ 走 ChatView 那种工具链
//
// 分词策略：
//   1) 先按中英文标点 split → 拿到"词"
//   2) 对每个 ≥2 字的词 → 滑窗 2-char（中文）+ 整词（英文）
// 这样"看天气"切成 ['看天', '天气'],用户说"看北京天气"时 "天气" 命中。
export function scoreSkill(skill, userInput) {
  const text = String(userInput || '').toLowerCase();
  const fields = [
    skill.label, skill.description, skill.name,
    ...(skill.keywords || []),
  ].filter(Boolean).map((s) => String(s).toLowerCase());
  let score = 0;
  const matchedFields = new Set();
  for (const f of fields) {
    if (!f) continue;
    // 整串命中：强相关
    if (text.includes(f)) { score += 5; matchedFields.add(f); }
    // 分词（标点切）
    const tokens = f.split(/[\s/、,。()【】()（）\-_]+/).filter((t) => t.length >= 2);
    // 2-char 滑窗：把"看天气"切成 ['看天','天气'],让"天气"能命中
    const bigrams = [];
    for (const t of tokens) {
      // 整词（命中后 +1）
      if (t.length >= 2) bigrams.push(t);
      // 中文滑窗 2-char
      if (/[一-鿿]/.test(t) && t.length >= 2) {
        for (let i = 0; i < t.length - 1; i++) bigrams.push(t.slice(i, i + 2));
      }
    }
    for (const t of bigrams) {
      if (text.includes(t)) { score += 1; matchedFields.add(t); }
    }
  }
  // 强意图词加权：用户说"帮我"+"X" 时 +3（让"帮我在美团点外卖"匹配到"点外卖" Skill）
  if (/帮我|给我|请帮|麻烦|想/.test(text) && matchedFields.size > 0) score += 3;
  return score;
}

export async function matchSkill(userInput, { minScore = 3 } = {}) {
  const skills = await listSkills();
  const ranked = skills
    .map((s) => ({ skill: s, score: scoreSkill(s, userInput) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

// ---------- Agent 主循环 ----------

const SYSTEM_PROMPT = `你是手机上的 AI 自动化助手。你会按 4 个 Agent 角色协作完成任务：

1) **Manager（规划）**：看用户指令 + 当前屏幕 + 笔记 → 输出"下一步要做什么"（1-2 句中文，纯文本）。
2) **Executor（执行）**：把 Manager 的"下一步"翻译成一个 khy.local.* 工具调用（如果不确定，先调 khy.local.lookScreen 看一眼屏幕）。
3) **Reflector（反思）**：看工具执行结果 → 决定「继续 / 调整策略 / 已完成」。
4) **Notetaker（笔记）**：在每个关键节点把已确认的事实写进 InfoPool（通过 appendNote 工具）。

工作约束：
- 一次只发一个 tool_call；不要为同一件事重发工具。
- 看到支付/密码/验证码页面时立即调 khy.local.stopAgent 终止并报告。
- 任务"完成"时调 khy.local.finishAgent 退出循环（必须调，否则会跑到上限）。
- 拿不准时优先调 khy.local.lookScreen 拿当前屏幕 + UI 树（VLM 会同时看到图和结构）。
- **混合点击模式**（无障碍授权后）：UI 操作优先 khy.local.findAndTap（"元素索引 + 坐标兜底"双模式），不卡顿。点不准再调 khy.local.listClickable 看所有按钮。
- **强制重 find（硬约束）**：每次用 findAndTap 之前，**必须**先调一次 khy.local.lookScreen 刷新 UI 树，再调 findAndTap。屏幕会变、UI 树会变，坐标会过期——这条不是建议，是规则。参数 forceRefresh 默认 true 是兜底，明知屏幕已变时建议显式 forceRefresh=true, settleMs=800。

可用工具：khy.local.lookScreen / findAndClick / findAndTap / listClickable / tap / swipe / typeText / openAppByName / deepLinkByApp /
openUrl / readClipboard / writeClipboard / http / listSkills / runSkill / appendNote / finishAgent / stopAgent。`;

const MAX_STEPS = 30; // Manager→Executor→Reflector 一次循环内允许的最大步数

function buildHistory({ userInput, skillContext }) {
  const sys = { role: 'system', content: SYSTEM_PROMPT };
  const skillNote = skillContext
    ? `\n\n提示：用户意图可能匹配 Skill「${skillContext.name}」（${skillContext.label}）。如果该 Skill 是 DeepLink 快速路径（只有 openUrl / compute 之类 steps），你直接调 khy.local.runSkill 一次即可完成，不需要走 GUI 自动化。`
    : '';
  const user = { role: 'user', content: `用户指令：${userInput}${skillNote}` };
  return [sys, user];
}

// 解析模型返回的工具调用（OpenAI 格式：tool_calls 数组）
function pickToolCall(assistant) {
  const tcs = assistant?.tool_calls || assistant?.message?.tool_calls || [];
  if (!Array.isArray(tcs) || tcs.length === 0) return null;
  const c = tcs[0];
  let args = {};
  try { args = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; }
  catch { args = { raw: c.function?.arguments || '' }; }
  return { id: c.id || `call_${Date.now()}`, name: c.function?.name || '', args };
}

// Notetaker 专用工具：让 Agent 自己把笔记写进 InfoPool
function noteToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'khy.local.appendNote',
      description: '把一条关键事实写进 InfoPool（执行历史里能看到），例如"用户想点猪脚饭""已找到美团 App 入口"等。',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: '要记录的笔记（一句话）' } },
        required: ['note'],
      },
    },
  };
}

function finishToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'khy.local.finishAgent',
      description: '告诉 Agent 循环任务已完成，附带给用户的最终答案。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '任务结果总结（中文）' } },
        required: ['summary'],
      },
    },
  };
}

function stopToolSchema() {
  return {
    type: 'function',
    function: {
      name: 'khy.local.stopAgent',
      description: '立即终止 Agent 循环。检测到支付/密码/验证码页面或用户明确取消时调。',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '为什么停止（如"检测到支付页面"）' } },
        required: ['reason'],
      },
    },
  };
}

function agentToolSchemas() {
  // 全部 localTools + Notetaker/Finish/Stop
  const all = localToolSchemas();
  return [...all, noteToolSchema(), finishToolSchema(), stopToolSchema()];
}

// 一次 Agent 跑完，返回最终结果
// options:
//   - baseUrl / apiKey / model: 走独立模式直连
//   - signal: AbortSignal（外部取消）
//   - onPhase({ role, text }): 每次模型产出文本时回调（planner / reflector 都能看到）
//   - onToolCall({ name, args, result, ok }): 每次执行工具后回调
//   - onNote(note): 调 appendNote 工具时回调
export async function run({ userInput, baseUrl, apiKey, model, signal, onPhase, onToolCall, onNote } = {}) {
  if (!userInput) throw new Error('userInput 不能为空');
  if (!baseUrl || !apiKey || !model) throw new Error('缺少 baseUrl / apiKey / model');

  const phases = [];
  const toolLog = [];
  const startedAt = new Date().toISOString();
  let stoppedReason = null;
  let finalSummary = null;

  // 1) 尝试匹配 Skill
  const matched = await matchSkill(userInput).catch(() => null);
  const skillContext = matched?.skill || null;
  if (skillContext) {
    onPhase?.({ role: 'skill-match', text: `匹配到 Skill：${skillContext.label}（${skillContext.name}）score=${matched.score}` });
  }

  // 2) 主循环
  let workingHistory = buildHistory({ userInput, skillContext });
  let stepsTaken = 0;
  let finishReason = 'limit';

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (signal?.aborted) { stoppedReason = 'aborted'; break; }
    stepsTaken += 1;

    // 让模型产出：可能是文本（Manager/Reflector）或 tool_call（Executor/Notetaker/Finish）
    let accText = '';
    let accToolCall = null;
    await streamChatCompletion({
      baseUrl, apiKey, model,
      messages: workingHistory,
      signal,
      tools: agentToolSchemas(),
      onChunk(c) { accText += c; },
      onToolCall(calls) {
        // 只取第一个；Agent 提示词要求"一次只发一个"
        accToolCall = pickToolCall({ tool_calls: calls });
      },
    });

    // 把这一轮的 assistant 消息入历史
    const assistantMsg = {
      role: 'assistant',
      content: accText || '',
      tool_calls: accToolCall ? [{ id: accToolCall.id, type: 'function', function: { name: accToolCall.name, arguments: JSON.stringify(accToolCall.args) } }] : undefined,
    };
    workingHistory.push(assistantMsg);

    if (accText) {
      phases.push({ role: 'planner', text: accText, at: new Date().toISOString() });
      onPhase?.({ role: 'planner', text: accText });
    }

    // 没 tool_call → 可能是模型认为已完成 / 自由发挥；记录并继续
    if (!accToolCall) {
      workingHistory.push({ role: 'user', content: '请继续：调用一个工具以推进任务，或调 khy.local.finishAgent 结束。' });
      continue;
    }

    // Executor 决策好了：执行
    const { name, args, id } = accToolCall;
    onPhase?.({ role: 'executor', text: `${name}(${JSON.stringify(args).slice(0, 200)})` });

    // 终止类工具
    if (name === 'khy.local.finishAgent') {
      finalSummary = args.summary || accText || '已完成';
      finishReason = 'finished';
      onPhase?.({ role: 'finish', text: finalSummary });
      break;
    }
    if (name === 'khy.local.stopAgent') {
      stoppedReason = args.reason || 'agent stopped';
      finishReason = 'stopped';
      onPhase?.({ role: 'stop', text: stoppedReason });
      break;
    }
    if (name === 'khy.local.appendNote') {
      const note = String(args.note || '').trim();
      onNote?.(note);
      toolLog.push({ name, args, result: note, ok: true, ts: new Date().toISOString() });
      workingHistory.push({ role: 'tool', tool_call_id: id, content: `已记录笔记：${note}` });
      onPhase?.({ role: 'reflector', text: `记笔记：${note}` });
      continue;
    }

    // 通用工具：走 executeLocalTool
    let result;
    try {
      const r = await executeLocalTool(name, args);
      result = r;
    } catch (cause) {
      result = { ok: false, content: `执行失败：${cause.message || cause}` };
    }
    toolLog.push({ name, args, result: result.content, ok: result.ok, ts: new Date().toISOString() });
    onToolCall?.({ name, args, result: result.content, ok: result.ok });
    workingHistory.push({ role: 'tool', tool_call_id: id, content: String(result.content).slice(0, 6000) });

    // 简单 Reflector 信号：结果前 80 字作为"反思"展示
    const reflectHint = result.ok
      ? `结果：${String(result.content).slice(0, 80)}${String(result.content).length > 80 ? '...' : ''}`
      : `失败：${String(result.content).slice(0, 80)}`;
    phases.push({ role: 'reflector', text: reflectHint, at: new Date().toISOString() });
    onPhase?.({ role: 'reflector', text: reflectHint });
  }

  // 3) 落 InfoPool
  const run = {
    id: `run_${Date.now()}`,
    userInput,
    skill: skillContext?.name || null,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: stepsTaken,
    finishReason, // 'finished' | 'stopped' | 'aborted' | 'limit'
    finalSummary,
    stoppedReason,
    phases,
    toolLog,
  };
  await appendRun(run).catch(() => {});

  return { ...run, status: operationStatus('完成', 'Agent 任务', finishReason, finishReason === 'finished' ? 'success' : finishReason === 'stopped' || finishReason === 'aborted' ? 'error' : 'info') };
}

// 同步装入几个 Roubao 风格的内置 Skill（若已装则跳过）。
// 现有 programRuntime.js 已有 6 个 Delegation Skill；这里只补一个"GUI 自动化"形态的示例
// 让 SkillsView 能演示"双模式"在 UI 里的差异。
export async function ensureGuiSkillSample() {
  const existing = await listSkills();
  if (existing.find((s) => s.name === 'auto-search-baidu')) return false;
  const skill = {
    name: 'auto-search-baidu',
    label: '百度搜索（GUI 自动化示例）',
    description: '示范 GUI 自动化 Skill：调 khy.local.lookScreen 看屏幕、调 khy.local.findAndClick 点击搜索框、调 khy.local.typeText 输入关键字。AI 在没有 DeepLink 可用时会自动回退到这条 GUI 路径。',
    params: { q: '搜索关键字' },
    keywords: ['百度', '搜索', '百度一下', 'baidu'],
    // 注：本 Skill 是"提示流程"型——AI 看到它会知道要按这些步骤去做，
    // 而不是用 steps 解释器跑（步骤解释器没有 GUI 工具）。
    // 标志：steps 为空 + 有 "guiSteps" 字段
    guiSteps: [
      { action: 'openApp', args: { name: '百度' } },
      { action: 'lookScreen', note: '看搜索框在哪' },
      { action: 'findAndClick', args: { query: '搜索框' } },
      { action: 'typeText', args: { text: '${q}' } },
      { action: 'findAndClick', args: { query: '百度一下' } },
    ],
    steps: [],
  };
  await saveSkill(skill);
  return true;
}
