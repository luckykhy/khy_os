'use strict';

/**
 * taskScale.js — Unified task scale detection.
 *
 * Single source of truth for classifying user messages as small/normal/large.
 * Used by both ai.js and toolUseLoop.js.
 *
 * ┌──────────┬──────────────────────────────────────────────────────────────┐
 * │  Scale   │  判定原则                                                   │
 * ├──────────┼──────────────────────────────────────────────────────────────┤
 * │  small   │  对话型：问候、笑话、闲聊、简单问答、状态查询               │
 * │          │  无需工具调用或仅需 1 次简单查询                             │
 * │          │  预期 1 轮即可完成，无文件修改                               │
 * ├──────────┼──────────────────────────────────────────────────────────────┤
 * │  normal  │  标准编码任务：单文件修改、Bug 修复、添加函数、代码审查      │
 * │          │  需要工具调用（读 → 改 → 验），涉及 1~5 个文件              │
 * │          │  预期 2~5 轮工具循环                                        │
 * ├──────────┼──────────────────────────────────────────────────────────────┤
 * │  large   │  多文件重构、架构变更、新功能端到端实现、迁移                │
 * │          │  涉及 5+ 个文件或多个模块，需要规划和分步验证               │
 * │          │  预期 5+ 轮工具循环                                         │
 * └──────────┴──────────────────────────────────────────────────────────────┘
 */

// ── Intent patterns ──

/** 明确 large 信号：用户明确要求大范围操作 */
const _LARGE_INTENT = /大型任务|完整实现|全量|全流程|端到端|全部重构|整体迁移|从零搭建|全面改造|批量处理|deep|exhaustive|end-to-end|full implementation|refactor (?:all|entire|whole)|migrate (?:all|entire)|overhaul/i;

/** 明确 small 信号：对话型、状态查询、简单问答 */
const _SMALL_INTENT = /^(你好|hi|hello|hey|嗨|哈喽|帮我看下|看下|查下|状态|help|who are you|你是谁|在吗|谢谢|thanks?|ok|好的|明白|收到)\s*[\?？!！。.]*$/i;

/** 笑话 / 闲聊 / 简单问答 — 即使不在行首也算 small */
const _CHAT_INTENT = /(讲|说|来).{0,6}(笑话|段子|故事|story)|tell\s+me\s+a\s+(joke|story|riddle)|^(什么是|谁是|怎么了|为什么|how\s+(do|does|is|are)|what\s+(is|are)|who\s+(is|are))\b/i;

/** 编码/工程任务关键词 — 提升到 normal */
const _CODE_INTENT = /修复|修改|实现|重构|创建文件|删除文件|添加|移除|替换|更新|升级|降级|安装|卸载|部署|发布|编写|写一个|写个|开发|调试|优化|配置|设置|合并|拆分|提取|封装|fix|implement|refactor|create|delete|add|remove|replace|update|upgrade|install|deploy|publish|write|develop|debug|optimize|configure|merge|split|extract/i;

/** 多目标/多步骤信号 — 提升到 normal 或 large */
/** 多目标/多步骤信号 — 排除版本号误匹配（如 0.1.78） */
// 前导序号有界 `\d{1,15}` 防 ReDoS：`\d+[\)）、]` 的贪婪数字串吞完全部数字后，
// 尾部符号类 `[\)）、]` 失败会在每个起点回溯 → O(n^2)（裸正则实测 100k 数字串 9402ms）。
// 当前活路径**并不可达**该冻结：resolveTaskScale 的 Rule 2（`len >= 700 → large`）在本正则
// （Rule 6）之前短路，任何长到能触发回溯的输入都已在 Rule 2 返回（200k 入口实测 1ms）。
// 但该「安全」仅依赖相邻规则的顺序/阈值这一偶然事实，一旦 Rule 2 阈值上调或规则重排即复活；
// 有界化对真实多目标消息（序号绝不超 15 位）逐字节等价，是零成本的防御纵深（见 taskScaleMultiTargetRedos 守卫）。
const _MULTI_TARGET = /(\d{1,15}[\)）、]|^\s*\d{1,15}\.\s+\S|第[一二三四五六七八九十]|首先.*然后|先.*再.*最后|步骤|分别|依次|并且.*还要|and also|step\s*\d)/im;

/**
 * Classify a user message into a task scale category.
 *
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {string} [opts.taskScale] - Explicit override (small/normal/large)
 * @returns {'small'|'normal'|'large'}
 */
function resolveTaskScale(userMessage = '', opts = {}) {
  const explicit = String(opts.taskScale || '').trim().toLowerCase();
  if (explicit === 'small' || explicit === 'normal' || explicit === 'large') return explicit;

  // Strip system-injected context sections that inflate the message length.
  // These are added by agenticHarnessService (_buildLoopInput) and boulder resume,
  // and should not affect task scale classification.
  const text = String(userMessage || '')
    .replace(/\n\n\[System [^\]]*\][\s\S]*$/i, '')  // [System Memory Hints], [System Skill Hints], etc.
    .replace(/^\[SYSTEM:[\s\S]*?\]\n\n/i, '')        // [SYSTEM: Resuming from checkpoint...]
    .trim();
  const len = text.length;
  const hasLineBreak = /\n/.test(text);

  // ── Rule 1: 明确的 large 意图关键词 ──
  if (_LARGE_INTENT.test(text)) return 'large';

  // ── Rule 2: 长文本 + 多行 = 复杂任务 ──
  if (len >= 700) return 'large';
  if (len >= 450 && hasLineBreak) return 'large';

  // ── Rule 3: 明确的 small 意图（精确匹配） ──
  if (_SMALL_INTENT.test(text)) return 'small';

  // ── Rule 4: 对话/闲聊意图 ──
  if (_CHAT_INTENT.test(text) && len <= 80) return 'small';

  // ── Rule 5: 短文本无编码意图 = small ──
  if (len <= 40 && !hasLineBreak && !_CODE_INTENT.test(text)) return 'small';

  // ── Rule 6: 多目标/多步骤 + 编码意图 = large ──
  if (_MULTI_TARGET.test(text) && _CODE_INTENT.test(text)) return 'large';

  // ── Rule 7: 有编码意图但短文本 = normal ──
  // ── 其他 = normal ──
  return 'normal';
}

module.exports = { resolveTaskScale, _MULTI_TARGET };
