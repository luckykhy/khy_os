'use strict';

/**
 * Gateway generation helpers (extracted from cli/ai.js).
 *
 * A conversation-state-free cluster used around a gateway generation attempt: build a user-facing
 * fallback reply from collected tool results (_buildToolFallbackReply + _salvageRecentToolResult /
 * _extractPlan / _buildWorkSummary / _toolProgressLabel), run a natural tool call under an idle
 * timeout (_runNaturalToolCallWithIdleTimeout), format gateway failure details
 * (_formatGatewayFailureDetails), perform a direct (non-streaming) generation (_directGenerate), and
 * gate task-self-awareness injection (_shouldInjectTaskSelfAwareness).
 *
 * Relocated verbatim (byte-identical bodies) into a same-directory sibling leaf so in-body relative
 * require() paths resolve identically; the host re-imports the entry points by the same names. The
 * bodies touch no mutable conversation/session state; they reference the shared khyUpgradeRuntime +
 * foldOutput singletons (re-required here) and four host accessors (audit-trace context, the two
 * standalone-LLM loggers, and getService) injected via setAiGatewayGenerateHelpersDeps to avoid a
 * require cycle back into ai.js. The leaf performs IO (service calls, logging), so it does NOT
 * self-declare as a pure zero-IO leaf.
 */

const runtime = require('../services/khyUpgradeRuntime');

const { _resolveTaskScale } = require('./aiRequestParsers');
const { foldOutput } = require('./toolDisplayPolicy');
// _shouldInjectTaskSelfAwareness sizes the request via the task-scale helper, which lives in the
// sibling aiRequestParsers leaf (also extracted from cli/ai.js; no require cycle — it only pulls in
// khyUpgradeRuntime). Re-require it here by the same name so the moved body stays byte-identical.

// Host accessors injected at load (all hoisted function declarations, so the setter is load-safe).
let _resolveAuditTraceContext = null;
let _logStandaloneLlmRequest = null;
let _logStandaloneLlmResponse = null;
let getService = null;
function setAiGatewayGenerateHelpersDeps(deps = {}) {
  if (typeof deps._resolveAuditTraceContext === 'function') {
    _resolveAuditTraceContext = deps._resolveAuditTraceContext;
  }
  if (typeof deps._logStandaloneLlmRequest === 'function') {
    _logStandaloneLlmRequest = deps._logStandaloneLlmRequest;
  }
  if (typeof deps._logStandaloneLlmResponse === 'function') {
    _logStandaloneLlmResponse = deps._logStandaloneLlmResponse;
  }
  if (typeof deps.getService === 'function') {
    getService = deps.getService;
  }
}

/**
 * Build a user-friendly reply from collected tool results when the
 * follow-up AI generation fails (timeout, error, empty response).
 * This ensures the user always sees the tool output instead of raw
 * <tool_call> tags or an empty reply.
 */
function _buildToolFallbackReply(toolResults) {
  if (!toolResults || toolResults.length === 0) {
    return '';
  }
  const parts = [];
  for (const tr of toolResults) {
    const text = tr.result.replace(/^\[Tool:\S+\]\s*/, '');
    const action = String(tr.action || '').toLowerCase();
    if (tr.success) {
      // Summarize differently based on tool type
      if (action === 'grep' || action === 'glob') {
        // File list tools: show list compactly, cap at 20 entries
        const lines = text.split('\n').filter((l) => l.trim());
        const header = lines[0] && /^Found \d+/.test(lines[0]) ? lines.shift() : null;
        const { lines: foldedFiles } = foldOutput(lines, {
          maxLines: 20,
          foldHead: 20,
          foldTail: 0,
        });
        let summary = header ? header + '\n' : '';
        summary += foldedFiles.map((f) => `- ${f.trim()}`).join('\n');
        parts.push(summary);
      } else if (action === 'read') {
        // Read: show first 500 chars only, encourage model to analyze
        parts.push(text.length > 500 ? text.slice(0, 500) + '\n...(file content truncated)' : text);
      } else {
        parts.push(text.length > 800 ? text.slice(0, 800) + '\n...(truncated)' : text);
      }
    } else {
      parts.push(text.length > 300 ? text.slice(0, 300) + '...' : text);
    }
  }
  const raw = parts.join('\n\n').trim();
  if (!raw) {
    return '';
  }

  // 自明工具（open_app/shell_command 等）成功后不需要冗余汇报
  const SELF_EVIDENT_TOOLS = new Set([
    'open_app',
    'open_url',
    'open_browser',
    'shell_command',
    'run_command',
  ]);
  const allSelfEvident = toolResults.every(
    (tr) => tr.success && SELF_EVIDENT_TOOLS.has(String(tr.action || '').toLowerCase())
  );
  if (allSelfEvident) {
    return '';
  }

  const toolNames = [...new Set(toolResults.map((t) => t.action).filter(Boolean))];
  const header = toolNames.length ? `执行了 ${toolNames.join('、')}，结果如下：` : '工具执行结果：';
  return `${header}\n\n${raw}`;
}

/**
 * 工具循环耗尽/失步后的收尾综合 prompt 构造。
 *
 * 当自然工具循环因轮数耗尽而停止、且收集到了工具结果时,与其直接把原始工具
 * 结果倒给用户(_buildToolFallbackReply),不如让模型基于已收集结果做一次
 * 「收尾综合」—— 生成一份可交付的最终总结(做了什么/得出什么/还有哪些没做),
 * 显著提升复杂任务的交付感。这是**纯文本生成**(禁用工具循环),一次模型往返,
 * 失败时调用方回退到 _buildToolFallbackReply,绝不降低现状。
 *
 * 任务聚合增强:当执行计划存在时(planSteps),把「拆解出的步骤」与「各步骤的
 * 实际工具结果」对应起来,要求模型**按步骤回顾**再**综合成最终交付** —— 实现
 * 「拆解任务步骤 → 逐步执行 → 聚合完成最终目标」的完整闭环。
 *
 * @param {Array<{action:string, arg:any, result:string, success:boolean}>} toolResults
 * @param {string} [userMessage] 原始用户指令(收尾时需要锚定任务目标)
 * @param {Array<{id:number, description:string, status:string}>} [planSteps] 执行计划步骤(可选)
 * @returns {string} 收尾综合 prompt
 */
function _buildWrapUpPrompt(toolResults, userMessage = '', planSteps = null) {
  const lines = [];
  const hasPlan = Array.isArray(planSteps) && planSteps.length > 0;
  lines.push(
    hasPlan
      ? '以下是本任务拆解出的执行计划及每步的实际结果。请按步骤回顾,再综合成一份完整、可交付的最终总结。'
      : '以下是本任务中已执行的工具及其结果。请基于这些结果,给用户一份完整、可交付的最终总结。'
  );
  lines.push('');
  if (String(userMessage || '').trim()) {
    lines.push(`原始任务: ${String(userMessage).trim().slice(0, 500)}`);
    lines.push('');
  }

  if (hasPlan) {
    // 按执行计划步骤组织:每步列出该步的工具结果。
    lines.push('执行计划与步骤结果:');
    const results = Array.isArray(toolResults) ? toolResults : [];
    // 消费式匹配:每个结果只归属一个步骤(避免"创建"同时映射 write/shell 导致重复)。
    // 已失败的步骤(failed)不参与消费 —— 其结果要么是失败的要么本就不该被错误归属,
    // 让成功结果优先匹配给已完成/待执行的步骤。
    const consumed = new Set();
    for (const step of planSteps) {
      const stepDesc = String(step.description || step.prompt || '')
        .trim()
        .slice(0, 120);
      const stepDescLower = stepDesc.toLowerCase();
      const stepResults = [];
      if (step && step.status !== 'failed') {
        for (let i = 0; i < results.length; i++) {
          if (consumed.has(i)) {
            continue;
          }
          const toolName = String(results[i].action || '').toLowerCase();
          if (stepDescLower && descContainsTool(stepDescLower, toolName)) {
            stepResults.push(results[i]);
            consumed.add(i);
            break; // 每步最多消费一个结果(步骤结果通常一一对应)
          }
        }
      }
      lines.push(`- 步骤 ${step.id || '?'}: ${stepDesc || '(无描述)'}`);
      // 步骤失败标注:已标记 failed 的步骤即使无工具结果也如实说明「执行失败」,
      // 聚合时不会被误读为「未执行」。
      if (stepResults.length > 0) {
        for (const tr of stepResults) {
          const status = tr.success ? '成功' : '失败';
          const text = String(tr.result || '')
            .replace(/^\[Tool:\S+\]\s*/, '')
            .slice(0, 800);
          lines.push(`  · [${tr.action}] (${status})${text ? `\n${text}` : ''}`);
        }
      } else if (step && step.status === 'failed') {
        const lastErr = String(step.lastError || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
        lines.push(`  · (执行失败${lastErr ? `: ${lastErr}` : ''})`);
      } else {
        lines.push('  · (本步骤无直接工具结果)');
      }
    }
    // 未匹配到任何步骤的结果(自由工具调用)也列出,避免信息丢失。
    const unmatched = results.filter((_, i) => !consumed.has(i));
    if (unmatched.length > 0) {
      lines.push('其他工具执行记录:');
      for (const tr of unmatched) {
        const status = tr.success ? '成功' : '失败';
        const text = String(tr.result || '')
          .replace(/^\[Tool:\S+\]\s*/, '')
          .slice(0, 800);
        lines.push(`- [${tr.action}] (${status})${text ? `\n${text}` : ''}`);
      }
    }
  } else {
    lines.push('工具执行记录:');
    for (const tr of toolResults || []) {
      const action = String(tr.action || 'unknown');
      const status = tr.success ? '成功' : '失败';
      const text = String(tr.result || '')
        .replace(/^\[Tool:\S+\]\s*/, '')
        .slice(0, 1200);
      lines.push(`- [${action}] (${status})${text ? `\n${text}` : ''}`);
    }
  }
  lines.push('');
  lines.push('总结要求:');
  if (hasPlan) {
    lines.push('1. 按执行计划步骤逐一确认完成情况(每步:完成/失败/未执行);');
    lines.push('2. 明确说明最终产出是什么(文件/数据/结论),指向原始任务目标;');
    lines.push('3. 如有未完成事项或失败步骤,如实说明并给出下一步建议;');
  } else {
    lines.push('1. 明确说明完成了什么、最终产出是什么(文件/数据/结论);');
    lines.push('2. 如有未完成事项或失败步骤,如实说明并给出下一步建议;');
  }
  lines.push(
    hasPlan
      ? '4. 直接输出总结正文,不要使用 <tool_call> 标签,不要请求更多工具。'
      : '3. 直接输出总结正文,不要使用 <tool_call> 标签,不要请求更多工具。'
  );
  return lines.join('\n');
}

/**
 * 执行计划的「步骤驱动」提示构造。
 *
 * 自然工具循环每轮让模型继续时,模型并不知道拆解出的计划进行到哪一步、剩余
 * 步骤是什么 —— 这正是「小任务聚合完成最终目标」的执行缺口:模型可能跳步、
 * 重复或提前收尾。本函数构造一段注入到每轮 loopPrompt 的提示,明确告诉模型:
 *   · 已完成哪些步骤(带描述)
 *   · 哪些步骤失败(✗)以及失败是否已修复
 *   · 下一步该做什么
 *   · 全部完成后如何收尾(聚合最终交付)
 * 让拆解 → 逐步执行 → 失败修复 → 聚合 形成真正的闭环。
 *
 * @param {Array<{id:number, description:string, status:string}>} planSteps
 * @param {number} currentStep - 已完成步数(下一个待执行步骤的索引)
 * @returns {string} 步骤驱动提示(无计划时返回 '')
 */
function _buildStepDriverPrompt(planSteps, currentStep = 0) {
  if (!Array.isArray(planSteps) || planSteps.length === 0) {
    return '';
  }
  const lines = [];
  lines.push('[SYSTEM: 任务执行计划进度]');
  const done = planSteps.filter((s) => s.status === 'completed');
  const failed = planSteps.filter((s) => s.status === 'failed');
  const blocked = planSteps.filter((s) => s.status === 'blocked');
  const pending = planSteps.filter(
    (s) => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'blocked'
  );
  if (done.length > 0) {
    lines.push(`已完成 ${done.length}/${planSteps.length} 步:`);
    for (const s of done) {
      const desc = String(s.description || '')
        .trim()
        .slice(0, 80);
      lines.push(`  ✓ 步骤 ${s.id}: ${desc || '(无描述)'}`);
    }
  } else if (failed.length === 0 && blocked.length === 0 && pending.length === planSteps.length) {
    lines.push(`计划共 ${planSteps.length} 步,尚未开始。`);
  }
  if (blocked.length > 0) {
    lines.push(
      `⚠ 已阻止 ${blocked.length} 步(连续失败 ${blocked.map((s) => s.attempts || 2).join('、')} 次,必须先分析根因):`
    );
    for (const s of blocked) {
      const desc = String(s.description || '')
        .trim()
        .slice(0, 80);
      const err = s.lastError ? ` — ${String(s.lastError).slice(0, 60)}` : '';
      lines.push(`  ⛔ 步骤 ${s.id}: ${desc || '(无描述)'}${err}`);
      lines.push(`     操作：先用 read_file 等工具检查实际状态,分析失败根因,修改步骤描述后重试。`);
    }
  }
  if (failed.length > 0) {
    lines.push(`失败 ${failed.length} 步(已记录,不影响后续):`);
    for (const s of failed) {
      const desc = String(s.description || '')
        .trim()
        .slice(0, 80);
      lines.push(`  ✗ 步骤 ${s.id}: ${desc || '(无描述)'}`);
    }
    lines.push('失败步骤已标记,不要反复重试;继续执行剩余步骤。');
  }
  if (pending.length > 0) {
    const next = pending[0];
    const nextDesc = String(next.description || '')
      .trim()
      .slice(0, 100);
    lines.push(`下一步(步骤 ${next.id}): ${nextDesc || '(无描述)'}`);
    lines.push('请立即执行下一步对应的工具调用。若某步已由前序结果覆盖,说明原因并跳到后续步骤。');
  } else if (done.length > 0 && failed.length > 0 && pending.length === 0) {
    lines.push(
      '除失败步骤外其余步骤已完成。请停止工具调用,输出最终交付总结(如实说明失败步骤,聚合已完成结果,指向原始任务目标)。'
    );
  } else if (pending.length === 0) {
    lines.push(
      '所有步骤已完成。请停止工具调用,直接输出最终交付总结(聚合各步骤结果,指向原始任务目标)。'
    );
  }
  lines.push('[/SYSTEM]');
  return lines.join('\n');
}

/**
 * 「继续/恢复」时的执行计划恢复提示构造。
 *
 * 用户诉求:「断网、token 没了、改到一半、删除一句代码后…怎么回到任务中」。
 * 当用户说「继续」且上一轮存在拆解的执行计划时,本函数构造一段恢复提示,
 * 把上次的步骤状态(已完成/失败/下一步)注入,让模型:
 *   1. 从断点继续(不重复已完成步骤);
 *   2. 对失败步骤先检查工作区实际状态(可能改到一半/被删代码)再决定修复;
 *   3. 回到任务主线,聚合完成最终目标。
 *
 * @param {Array<{id:number, description:string, status:string, lastError?:string}>} savedSteps
 * @returns {string} 恢复提示(无快照时返回 '')
 */
function _buildResumePlanPrompt(savedSteps) {
  if (!Array.isArray(savedSteps) || savedSteps.length === 0) {
    return '';
  }
  const lines = [];
  lines.push('[SYSTEM: 任务断点恢复 — 回到任务中]');
  lines.push('你之前正在执行一个拆解后的多步骤任务。以下是上次中断时的进度:');
  const done = savedSteps.filter((s) => s.status === 'completed');
  const failed = savedSteps.filter((s) => s.status === 'failed' || s.status === 'blocked');
  const blocked = savedSteps.filter((s) => s.status === 'blocked');
  const pending = savedSteps.filter(
    (s) => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'blocked'
  );
  if (done.length > 0) {
    lines.push(`已完成 ${done.length}/${savedSteps.length} 步:`);
    for (const s of done) {
      const desc = String(s.description || '')
        .trim()
        .slice(0, 80);
      lines.push(`  ✓ 步骤 ${s.id}: ${desc || '(无描述)'}`);
    }
  }
  if (blocked.length > 0) {
    lines.push(`⚠ 已阻止 ${blocked.length} 步(连续失败,需先分析根因):`);
    for (const s of blocked) {
      const desc = String(s.description || '')
        .trim()
        .slice(0, 80);
      lines.push(`  ⛔ 步骤 ${s.id}: ${desc || '(无描述)'}`);
      lines.push(
        `     原因: ${String(s.lastError || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)}`
      );
      lines.push(`     操作: 分析失败根因,修改步骤描述后可重试。`);
    }
  }
  if (failed.length > 0) {
    lines.push(`失败 ${failed.length} 步:`);
    for (const s of failed) {
      const desc = String(s.description || '')
        .trim()
        .slice(0, 80);
      const err = String(s.lastError || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      lines.push(`  ✗ 步骤 ${s.id}: ${desc || '(无描述)'}${err ? ` (${err})` : ''}`);
    }
    lines.push(
      '失败步骤请先检查工作区当前实际状态(可能已改到一半 / 代码被删),能修复则修复,不能则如实记录后继续。'
    );
  }
  if (pending.length > 0) {
    const next = pending[0];
    const nextDesc = String(next.description || '')
      .trim()
      .slice(0, 100);
    lines.push(`下一步(步骤 ${next.id}): ${nextDesc || '(无描述)'}`);
    lines.push(
      '请从断点继续执行,不要重复已完成步骤。若文件当前状态与预期不符(如修改未落盘/被回退),先读取确认再行动。'
    );
  } else {
    lines.push('所有步骤均已完成或已记录。请检查最终交付是否完整;若已完整,直接输出最终总结。');
  }
  lines.push('[/SYSTEM]');
  return lines.join('\n');
}

/**
 * 步骤失败后的「修复回到正文」提示构造。
 *
 * 用户诉求:「某一个步骤出错怎么修复回到正文」。当执行计划中的某一步工具调用
 * 失败时,不立即放弃整个任务,而是注入一段修复提示,引导模型:
 *   1. 换一种工具/参数/路径重试该步骤(修复尝试);
 *   2. 若确实无法完成,如实说明失败原因,标记该步骤失败,并继续后续步骤(回到正文/主线),
 *      不让单个步骤的失败拖垮整个任务。
 *
 * @param {object} call - 失败的工具调用 { action, arg }
 * @param {string} [errorText] - 工具失败的错误信息
 * @param {number} [attempt] - 当前重试次数(1 = 首次失败,2 = 第二次…)
 * @param {number} [maxAttempts] - 最大重试次数(超过则放弃该步骤)
 * @returns {string} 修复提示
 */
function _buildStepRecoveryPrompt(call = {}, errorText = '', attempt = 1, maxAttempts = 2) {
  const action = String((call && call.action) || 'unknown');
  const argText = (() => {
    try {
      return JSON.stringify((call && call.arg) || {}).slice(0, 200);
    } catch {
      return '';
    }
  })();
  const attemptNum = Number.isFinite(attempt) && attempt > 0 ? attempt : 1;
  const maxNum = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 2;
  const errBrief = String(errorText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  const lines = [];
  lines.push('[SYSTEM: 步骤执行失败 — 修复指导]');
  lines.push(`工具 ${action} 执行失败${argText ? `(参数: ${argText})` : ''}。`);
  if (errBrief) {
    lines.push(`错误: ${errBrief}`);
  }
  if (attemptNum < maxNum) {
    lines.push(
      `这是第 ${attemptNum}/${maxNum} 次尝试。请分析失败原因,换一种方式重试(如:修正参数/换工具/改路径/降级方案)。`
    );
  } else {
    lines.push(
      `已重试 ${attemptNum} 次仍失败。请如实记录此步骤失败,不要继续消耗尝试;直接继续执行计划中的后续步骤(回到正文),最终交付时说明此步骤失败及原因。`
    );
  }
  lines.push('[/SYSTEM]');
  return lines.join('\n');
}

/** 判断步骤描述是否包含某工具名(小写、去下划线归一)或动作语义匹配。 */
function descContainsTool(desc, toolName) {
  if (!desc || !toolName) {
    return false;
  }
  const normTool = toolName.replace(/_/g, '').replace(/ /g, '');
  if (!normTool) {
    return false;
  }
  // 直接工具名匹配。
  if (desc.includes(normTool)) {
    return true;
  }
  // 动作词 → 工具映射:步骤描述用自然语言(查看/读取 → read,创建/编写/修改 → write,
  // 运行/测试 → runTests,搜索 → grep/glob),归一后匹配。
  const lowerTool = normTool.toLowerCase();
  const ACTION_TOOLS = {
    read: ['查看', '读取', '阅读', '读', '检查', '浏览', '分析文件', '看'],
    write: ['创建', '编写', '写入', '修改', '新增', '生成', '实现', '添加', '编辑', '更新', '文件'],
    shellcommand: [
      '运行',
      '执行',
      '创建',
      '初始化',
      '安装',
      '启动',
      '构建',
      '命令',
      '迁移',
      '建表',
    ],
    runtests: ['测试', '验证', '运行测试', '跑', '检查'],
    grep: ['搜索', '查找', '检索', '定位'],
    glob: ['搜索', '查找', '列出', '枚举'],
  };
  const aliases = ACTION_TOOLS[lowerTool];
  if (aliases) {
    for (const a of aliases) {
      if (desc.includes(a)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 收尾综合的启停判断:仅当收集到工具结果且门控未关时才值得做一次模型往返。
 * 门控 KHY_TOOL_LOOP_WRAPUP(默认开)。fail-soft:判断失败 → 默认开。
 * @returns {boolean}
 */
function _wrapUpEnabled(env = process.env) {
  try {
    const raw = String((env && env.KHY_TOOL_LOOP_WRAPUP) || '')
      .trim()
      .toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(raw);
  } catch {
    return true;
  }
}

/**
 * 截断注解:模型输出被 max_tokens 截断但正文非空时,给回复追加明确的错误
 * 原因提示。杜绝「半截话静默交付、用户不知为何戛然而止」——这正是"被截断
 * 应该显示错误原因"的核心实现。
 *
 * 复用 maxTokensRecovery.buildTruncationNotice 文案(单一真源),带修复方向
 * (调大 maxTokens / 说「继续」)。幂等:回复已含截断提示时不再重复追加。
 *
 * @param {string} [reply] 待交付的回复正文(可能非空)
 * @param {string} [stopReason] 本次生成的实际 stopReason/finishReason
 * @param {number} [continuations] 已尝试的续写段数(展示在提示里)
 * @returns {{ reply: string, truncated: boolean }}
 */
function _annotateTruncation(reply, stopReason = '', continuations = 0) {
  const text = String(reply || '').trim();
  const reason = String(stopReason || '')
    .trim()
    .toLowerCase();
  const isTruncated = /length|max[_-]?tokens|max[_-]?output/.test(reason);
  if (!isTruncated || !text) {
    return { reply: text, truncated: false };
  }
  // 幂等:已带截断提示(含其它来源)则不重复追加。
  if (/截断|truncat|limit/i.test(text)) {
    return { reply: text, truncated: true };
  }
  let notice;
  try {
    notice = require('../services/query').maxTokensRecovery.buildTruncationNotice(continuations);
  } catch {
    notice =
      '\n\n[⚠️ 输出已达长度上限被截断。可调大 KHY 网关 maxTokens（本地模型对应 num_predict），或说「继续」补全剩余内容。]';
  }
  return { reply: text + notice, truncated: true };
}

/**
 * 空响应救援：模型返回空内容时，从最近的会话历史里捞回上一次「成功」的工具结果。
 *
 * 现象（实测）：用户连续执行工具（如 `pip cache purge`）后追问「结果呢」，弱模型把
 * 输出预算耗在思考里 / 被 max_tokens 截断，最终回复为空 —— 旧逻辑直接抛「未返回有效
 * 回复」，但工具其实已成功执行、结果就在历史里。本函数把那条结果直接回显，避免「执行
 * 成功却报截断」的观感。
 *
 * 仅回溯最近 `maxLookback` 条消息（默认 6），确保捞回的是「刚刚这步」的结果而非陈旧
 * 上下文；失败结果（ERROR: 开头）不冒充成功汇报，返回 null 交由下游走正常错误路径。
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {{maxLookback?:number}} [opts]
 * @returns {string|null}
 */
function _salvageRecentToolResult(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const maxLookback = Number.isFinite(opts.maxLookback) ? opts.maxLookback : 6;
  const start = Math.max(0, messages.length - maxLookback);
  for (let i = messages.length - 1; i >= start; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') {
      continue;
    }
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.startsWith('[Tool Result]')) {
      continue;
    }
    // 形如 "[Tool Result]\n[Tool:shellCommand] <text>"
    const body = content.replace(/^\[Tool Result\]\s*/, '');
    const mt = body.match(/^\[Tool:(\S+)\]\s*([\s\S]*)$/);
    const action = mt ? mt[1] : null;
    let text = (mt ? mt[2] : body).trim();
    if (!text || /^ERROR:/i.test(text)) {
      return null;
    }
    const TAIL = 1200;
    if (text.length > TAIL) {
      text = `…${text.slice(-TAIL)}`;
    }
    const head = action ? `上一步已执行 ${action}，工具实际输出如下：` : '上一步工具执行结果如下：';
    return `${head}\n\n${text}`;
  }
  return null;
}

/**
 * Extract [Plan] line from model's initial response.
 * Returns { plan, cleaned } where plan is the extracted text (or null)
 * and cleaned is the reply with the [Plan] line removed.
 */
function _extractPlan(reply) {
  const match = reply.match(/^\[Plan\]\s*(.+)$/m);
  if (!match) {
    return { plan: null, cleaned: reply };
  }
  const plan = match[1].trim();
  const cleaned = reply.replace(match[0], '').trim();
  return { plan, cleaned };
}

/**
 * Build a structured work summary from collected tool results.
 * Used when the model doesn't provide its own [Summary].
 */
function _buildWorkSummary(collectedToolResults) {
  if (!collectedToolResults || collectedToolResults.length === 0) {
    return null;
  }
  const actions = collectedToolResults.map((t) => t.action).filter(Boolean);
  const unique = [...new Set(actions)];
  const succeeded = collectedToolResults.filter((t) => t.success).length;
  const failed = collectedToolResults.length - succeeded;
  let summary = `Used ${unique.join(', ')} (${succeeded} succeeded`;
  if (failed > 0) {
    summary += `, ${failed} failed`;
  }
  summary += ')';
  return summary;
}

// ── 工具点名诚实性校验(KHY_TOOL_MENTION_GUARD·默认开)────────────────────────
// 2026-09 会话 2deaa521 的缺陷:弱模型在收尾汇总里点名从未调用过的工具并宣称其产出
// (「通过 dataFetch 拉取到 30 条日线数据」,本轮工具日志里没有任何 dataFetch 调用)。
// 这里用确定性的工具点名核对(claimReconciler.reconcileToolMentions,零模型、
// 零假阳性优先)比对正文与真实调用记录,发现缺口就在回复末尾**追加**一条诚实纠错
// 注释 —— 只追加,不改写模型正文(与 resultGuard/_appendDeliveryVerdictSummary
// 同款契约);核对/拼接任一异常 → 空串,绝不阻断交付。
function _buildToolMentionNotice(reply, collectedToolResults) {
  try {
    const text = String(reply || '');
    if (!text.trim() || !Array.isArray(collectedToolResults) || collectedToolResults.length === 0) {
      return '';
    }
    const { reconcileToolMentions } = require('../services/domain/trajectory/trajectoryProvenance/claimReconciler');
    const executed = collectedToolResults
      .map((t) => t && (t.action || t.tool))
      .filter(Boolean);
    const { contradictions } = reconcileToolMentions(text, executed);
    if (!Array.isArray(contradictions) || contradictions.length === 0) {
      return '';
    }
    const lines = [
      '> ⚠️ 诚实性校验：上文把下列工具写成了已完成动作，但本轮工具调用记录里没有它们的调用 ——',
    ];
    for (const c of contradictions.slice(0, 3)) {
      lines.push(`> - 「${c.claim}」（缺少 ${c.expectedTool} 的调用记录）`);
    }
    lines.push('> 该部分内容未经真实执行证实，请以实际执行结果为准；需要的话让我真正执行它。');
    return '\n\n' + lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Human-readable description for a tool action being executed.
 */
function _toolProgressLabel(action, arg) {
  const a = String(action || '').toLowerCase();
  if (a === 'read') {
    return `Reading ${arg && arg.file_path ? require('path').basename(arg.file_path) : 'file'}...`;
  }
  if (a === 'write') {
    return `Writing ${arg && arg.file_path ? require('path').basename(arg.file_path) : 'file'}...`;
  }
  if (a === 'edit') {
    return `Editing ${arg && arg.file_path ? require('path').basename(arg.file_path) : 'file'}...`;
  }
  if (a === 'glob') {
    return `Searching files${arg && arg.pattern ? ` (${arg.pattern})` : ''}...`;
  }
  if (a === 'grep') {
    return `Searching code${arg && arg.pattern ? ` (${arg.pattern})` : ''}...`;
  }
  if (a === 'shellcommand' || a === 'bash') {
    return `Running command...`;
  }
  if (a === 'web_search' || a === 'websearch') {
    const query = typeof arg === 'object' ? arg.query || '' : String(arg || '');
    return query ? `Searching web: ${query.slice(0, 60)}...` : 'Searching web...';
  }
  if (a === 'quote') {
    const symbol = typeof arg === 'object' ? arg.symbol || '' : String(arg || '');
    return symbol ? `Fetching quote: ${symbol}` : 'Fetching quote...';
  }
  if (a === 'data_fetch') {
    return `Fetching data...`;
  }
  return `Executing ${action}...`;
}

async function _runNaturalToolCallWithIdleTimeout(call, options = {}) {
  const idleTimeoutMsRaw = parseInt(String(options.idleTimeoutMs || ''), 10);
  const idleTimeoutMs =
    Number.isFinite(idleTimeoutMsRaw) && idleTimeoutMsRaw > 0 ? idleTimeoutMsRaw : 120000;
  const onActivity = typeof options.onActivity === 'function' ? options.onActivity : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  let lastActivityEventAt = 0;
  const minActivityEventGapMs = Math.max(
    250,
    parseInt(String(process.env.KHY_TOOL_ACTIVITY_EVENT_GAP_MS || '1200'), 10) || 1200
  );

  let timeoutReject = null;
  let watchdog = null;
  try {
    const { startWatchdog } = require('../services/resourceGuard');
    watchdog = startWatchdog(
      `natural-tool:${String(call && call.action ? call.action : 'tool')}`,
      idleTimeoutMs,
      (_operationName, elapsedSec) => {
        if (!timeoutReject) {
          return;
        }
        const reject = timeoutReject;
        timeoutReject = null;
        reject(new Error(`Tool execution idle timeout after ${elapsedSec}s`));
      }
    );
  } catch {
    watchdog = null;
  }

  const touch = (payload) => {
    try {
      if (watchdog) {
        watchdog.touch();
      }
    } catch {
      /* non-critical */
    }
    if (onActivity) {
      const now = Date.now();
      if (
        now - lastActivityEventAt >= minActivityEventGapMs ||
        payload === 'start' ||
        payload === 'done'
      ) {
        lastActivityEventAt = now;
        try {
          onActivity(payload);
        } catch {
          /* non-critical */
        }
      }
    }
  };

  const progress = (payload) => {
    touch(payload);
    if (onProgress) {
      try {
        onProgress(payload);
      } catch {
        /* non-critical */
      }
    }
  };

  touch('start');

  const execution = runtime.runNaturalToolCall(call, {
    onActivity: touch,
    onProgress: progress,
  });

  if (!watchdog) {
    const result = await execution;
    touch('done');
    return result;
  }

  const idleTimeoutPromise = new Promise((_, reject) => {
    timeoutReject = reject;
  });

  try {
    const result = await Promise.race([execution, idleTimeoutPromise]);
    touch('done');
    return result;
  } finally {
    timeoutReject = null;
    try {
      if (watchdog) {
        watchdog.done();
      }
    } catch {
      /* non-critical */
    }
  }
}

function _formatGatewayFailureDetails(result) {
  if (!result || !Array.isArray(result.attempts) || result.attempts.length === 0) {
    return '';
  }
  const failed = result.attempts.filter((a) => a && a.success === false);
  if (failed.length === 0) {
    return '';
  }

  const normalizeAdapterSig = (raw) => {
    const s = String(raw || '')
      .trim()
      .toLowerCase();
    if (!s) {
      return 'adapter';
    }
    if (s === 'localllm' || s === 'local llm' || s.includes('local (') || s.includes('本地模型')) {
      return 'localllm';
    }
    if (s === 'codex' || s.includes('openai codex')) {
      return 'codex';
    }
    if (s === 'claude' || s.includes('anthropic')) {
      return 'claude';
    }
    if (s === 'ollama' || s.includes('ollama')) {
      return 'ollama';
    }
    if (s === 'api' || s.includes('multifree')) {
      return 'api';
    }
    if (s === 'relay' || s.includes('relay')) {
      return 'relay';
    }
    return s;
  };

  const lines = [];
  const seen = new Set();
  let uniqueFailedCount = 0;
  for (const attempt of failed) {
    const adapter = String(attempt.adapterKey || attempt.provider || 'adapter').trim();
    const adapterSig = normalizeAdapterSig(attempt.adapterKey || attempt.provider || 'adapter');
    const statusCode = attempt.statusCode ? String(attempt.statusCode) : '';
    const status = statusCode ? ` (${statusCode})` : '';
    const kindCode = String(attempt.errorType || '')
      .trim()
      .toLowerCase();
    const kind = kindCode ? ` [${kindCode}]` : '';
    const err = String(attempt.error || 'unknown error')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    const sig = `${adapterSig}|${statusCode}|${kindCode}|${err}`;
    if (!err || seen.has(sig)) {
      continue;
    }
    seen.add(sig);
    uniqueFailedCount += 1;
    if (lines.length < 6) {
      lines.push(`- ${adapter}${status}${kind}: ${err}`);
    }
  }

  if (lines.length === 0) {
    return '';
  }
  if (uniqueFailedCount > lines.length) {
    lines.push(`- ... 还有 ${uniqueFailedCount - lines.length} 条失败记录`);
  }
  return `真实失败原因:\n${lines.join('\n')}`;
}

// ── 内部处理说明（可交付性）──────────────────────────────────────
// 用户需求:「遇到各种错误优先 khyos 自己内部处理,需要显示处理方法,处理不了
// 后报错」。内部处理(gateway recovery 重试 / rate-limit 重试 / direct fallback /
// 上下文压缩重试 / maxTokens 续写)发生在到达此处之前。到达最终失败时,我们
// 必须向用户说明「内部已尝试了哪些处理」+「该错误类型的处理方法建议」,而不是
// 只丢一句干巴巴的错误 —— 否则用户看到报错却不知道系统已经尽力、也不知道
// 自己能做什么。

/**
 * 从失败结果推导「内部已尝试的处理」描述。
 * @param {object} [result] - gateway 失败结果
 * @returns {string} 描述文本（无 attempts 信息时返回 ''）
 */
function _describeInternalAttempts(result) {
  const attempts = result && Array.isArray(result.attempts) ? result.attempts : [];
  if (attempts.length === 0) {
    return '';
  }
  const failed = attempts.filter((a) => a && a.success === false);
  const tried = attempts.length;
  if (failed.length === 0) {
    return '';
  }
  const providers = new Set(
    failed
      .map((a) => String(a.provider || a.adapterKey || '').trim())
      .filter(Boolean)
      .map((s) => (s.length > 40 ? s.slice(0, 37) + '...' : s))
  );
  const providerList = [...providers].slice(0, 4).join('、');
  return `内部已尝试 ${tried} 次请求（${providerList || '各通道'}），均未成功。`;
}

/**
 * 按错误类型给出「处理方法建议」（用户可执行的下一步）。
 * 与 errorClassifier.suggestRecoveryAction 同构，但输出人类可读的中文建议。
 * @param {string} [errorType] - 失败 errorType（'timeout'/'network'/'rate_limit'/'auth'/'context_length'/'model_not_found'/'empty'/'unknown'…）
 * @param {object} [result] - gateway 失败结果（用于提取具体状态/模型信息）
 * @returns {string[]} 建议列表（可能为空）
 */
function _buildRecoverySuggestions(errorType, result = {}) {
  const t = String(errorType || result?.errorType || '')
    .trim()
    .toLowerCase();
  if (!t) {
    return [];
  }
  const s = [];
  if (/timeout|network|overloaded|server_error|process|unknown|cancelled/.test(t)) {
    s.push('网络/超时类：稍后说「继续」自动重试，或运行 khy gateway status 检查通道健康');
    s.push('可切换其他通道：khy gateway config 调整首选模型通道');
  } else if (/rate_limit|billing/.test(t)) {
    s.push('限流/额度类：已自动重试仍受限，稍后说「继续」再试，或降低请求频率 / 更换通道');
  } else if (/auth/.test(t)) {
    s.push('认证类：请运行 khy gateway config 检查并更新对应通道的 API key');
  } else if (/context_length|context_overflow|payload_too_large/.test(t)) {
    s.push('上下文超长：系统已自动压缩上下文并重试；若仍失败请说「继续」，或 /compact 手动压缩');
  } else if (/model_not_found/.test(t)) {
    s.push('模型不存在：请用 khy gateway models 查看可用模型，并 /model 切换到正确的模型');
  } else if (/empty/.test(t)) {
    s.push(
      '空回复类：系统已自动续写/重试仍无输出，请调大 KHY 网关 maxTokens（本地模型对应 num_predict），或 /model 换更大模型'
    );
  } else if (/refusal|content_filter/.test(t)) {
    s.push('内容安全拦截：请调整请求措辞后重试');
  }
  return s;
}

/**
 * 构造最终失败时的「内部处理 + 处理方法」说明块。
 * 追加到错误消息后，让用户知道系统已尽力且知道下一步怎么做。
 *
 * @param {object} [result] - gateway 失败结果
 * @param {string} [errorType] - 失败 errorType（缺省从 result 取）
 * @returns {string} 说明块（以换行开头；无信息时返回 ''）
 */
function _buildRecoveryAttemptsNote(result, errorType) {
  const type = String(errorType || (result && result.errorType) || '')
    .trim()
    .toLowerCase();
  const parts = [];

  const attemptsDesc = _describeInternalAttempts(result);
  if (attemptsDesc) {
    parts.push(attemptsDesc);
  }

  // 自动续写/压缩等内部处理是否已生效，是透明的（这里只说明到最终失败的路径）。
  const suggestions = _buildRecoverySuggestions(type, result);
  if (suggestions.length > 0) {
    parts.push('处理方法：');
    for (const s of suggestions) {
      parts.push(`· ${s}`);
    }
  }

  if (parts.length === 0) {
    return '';
  }
  return `\n\n${parts.join('\n')}`;
}

async function _directGenerate(conversationPrompt, userMessage, opts, effortPreset) {
  const traceCtx = _resolveAuditTraceContext(opts);
  const startedAt = Date.now();
  _logStandaloneLlmRequest(traceCtx, conversationPrompt, opts, {
    source: 'ai-direct',
    requestedModel: effortPreset?.label || opts.model || 'direct-fallback',
    preferredAdapter: opts.preferredAdapter || opts.adapter || 'direct-fallback',
    localPath: 'multiFreeService.generateResponse',
  });
  const svc = getService();
  const status = svc.getStatus();
  if (!status.available) {
    const unavailable = {
      success: false,
      errorType: 'network',
      content: '所有 AI 通道不可用。',
    };
    _logStandaloneLlmResponse(traceCtx, unavailable, {
      source: 'ai-direct',
      provider: 'multiFreeService',
      adapter: 'direct-fallback',
      durationMs: Date.now() - startedAt,
      localPath: 'multiFreeService.generateResponse',
    });
    return unavailable;
  }
  const result = await svc.generateResponse(conversationPrompt, {
    temperature: runtime.lockTemperature(userMessage),
    top_p: runtime.lockTopP(userMessage),
    maxTokens: effortPreset.maxTokens,
    images: opts.images,
  });
  _logStandaloneLlmResponse(traceCtx, result, {
    source: 'ai-direct',
    provider: result?.provider || 'multiFreeService',
    adapter: result?.provider || 'direct-fallback',
    durationMs: Date.now() - startedAt,
    localPath: 'multiFreeService.generateResponse',
  });
  return result;
}

function _shouldInjectTaskSelfAwareness(userMessage = '', opts = {}) {
  const gate = String(process.env.KHY_TASK_SELF_AWARENESS || 'true')
    .trim()
    .toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(gate)) {
    return false;
  }
  if (opts && opts.disableTaskSelfAwareness === true) {
    return false;
  }

  const text = String(userMessage || '').trim();
  if (!text) {
    return false;
  }

  const scale = _resolveTaskScale(text, opts);
  if (scale !== 'small') {
    return true;
  }

  // Small tasks only inject when user explicitly asks for capability-awareness.
  return /自我认知|能力边界|能力|局限|can you do|what can you|capability|limitations?/i.test(text);
}

module.exports = {
  _buildToolFallbackReply,
  _buildToolMentionNotice,
  _buildWrapUpPrompt,
  _buildStepDriverPrompt,
  _buildStepRecoveryPrompt,
  _buildResumePlanPrompt,
  _wrapUpEnabled,
  _annotateTruncation,
  _buildRecoveryAttemptsNote,
  _salvageRecentToolResult,
  _extractPlan,
  _buildWorkSummary,
  _toolProgressLabel,
  _runNaturalToolCallWithIdleTimeout,
  _formatGatewayFailureDetails,
  _directGenerate,
  _shouldInjectTaskSelfAwareness,
  setAiGatewayGenerateHelpersDeps,
};
