'use strict';

const { BaseTool } = require('../_baseTool');
const weipu = require('../../services/weipuxiezuo');

/**
 * WeipuRewriteTool — 维普 AIGC 降重的「确定性检测/评分/判合格」工具。
 *
 * 用户要求：把 weipuxiezuo skill（一段长提示词）改成代码实现。本工具是引擎对模型的
 * 出口：给一段中文学术文本，返回带位置的 16 模式命中清单 + 三维分数 + 硬约束闸 +
 * 结构化改写简报。模型据此**重写**，再调一次本工具**复检**，直到 gate 通过——
 * 取代「把规则讲给模型听」的做法（对照 contextDiagnostics「测不了就优化不了」）。
 *
 * 只读、无副作用、并发安全：纯文本分析，不碰文件/网络。
 */
class WeipuRewriteTool extends BaseTool {
  static toolName = 'WeipuRewrite';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['weipu', 'weipuxiezuo', 'aigc_rewrite', 'descatter'];
  static searchHint = 'AIGC 降重 维普 学术写作 去AI味 检测 改写 论文 burstiness 三维评分';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return [
      '维普学术写作 AIGC 检测与降重引擎（确定性，非提示词）。',
      '输入一段中文学术文本，返回：',
      '  · findings — 16 种 AI 写作模式的带位置命中清单（第几段、触发词、修复法）',
      '  · scores   — 三维评分：AIGC痕迹(≤40合格)/学术质量(≥55合格)/引用化用',
      '  · gate     — 模式相关硬约束闸（代码判合格，非自评）',
      '  · brief    — 按优先级排序的逐条改写任务（含 AI高频词换词表）',
      '  · report   — ASCII 三维评分框',
      'mode: fragment(片段,默认) | chapter(章节) | full(全文,强制15篇引用递增)。',
      '用法：先 analyze 拿 brief → 按 brief 逐条重写 → 再 analyze 复检，直到 gate.pass=true。',
      '引擎不替你写作，只给可复算的度量与定位；改写仍由你完成。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '待检测/降重的中文学术文本',
        },
        mode: {
          type: 'string',
          description: '检测模式：fragment 片段 / chapter 章节 / full 全文',
          enum: ['fragment', 'chapter', 'full'],
          default: 'fragment',
        },
        view: {
          type: 'string',
          description: "返回粒度：'full' 全量(默认) / 'report' 仅评分框 / 'brief' 仅改写简报",
          enum: ['full', 'report', 'brief'],
          default: 'full',
        },
      },
      required: ['text'],
    };
  }

  async execute(params) {
    const text = String(params && params.text != null ? params.text : '');
    if (!text.trim()) {
      return { success: false, error: '文本为空，无可检测内容' };
    }
    const mode = params.mode || 'fragment';
    const view = params.view || 'full';

    const result = weipu.analyze(text, { mode });
    const { detection, scores, gate, brief, report } = result;

    const base = {
      success: true,
      mode,
      passed: scores.aigc.pass && scores.academic.pass && gate.pass,
      scores: {
        aigc: scores.aigc.score,
        aigcPass: scores.aigc.pass,
        academic: scores.academic.score,
        academicPass: scores.academic.pass,
        citation: scores.citation,
      },
      gatePass: gate.pass,
      report,
    };

    if (view === 'report') return base;
    if (view === 'brief') return { ...base, brief };

    // full
    return {
      ...base,
      stats: {
        chars: detection.stats.chars,
        paragraphs: detection.stats.paragraphCount,
        sentences: detection.stats.sentenceCount,
        cv: Math.round(detection.stats.rhythm.cv * 1000) / 1000,
        meanSentenceLen: Math.round(detection.stats.rhythm.mean * 10) / 10,
      },
      totals: detection.totals,
      findings: detection.findings.map((f) => ({
        patternId: f.id,
        pattern: f.name,
        priority: f.priority,
        count: f.count,
        fix: f.fix,
        locations: f.matches.slice(0, 8).map((m) => ({
          paragraph: m.paragraph,
          text: m.text,
          atEnd: m.atEnd,
        })),
      })),
      gate: gate.items,
      brief,
    };
  }

  getActivityDescription(input) {
    const mode = (input && input.mode) || 'fragment';
    return `维普AIGC检测(${mode})`;
  }
}

module.exports = WeipuRewriteTool;
