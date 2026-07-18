'use strict';

const { BaseTool } = require('../_baseTool');
const wmg = require('../../services/weakModelGuidance');

/**
 * WeakModelGuidanceTool — 「弱/陌生模型改 khyos 前先查这里」的确定性护栏出口。
 *
 * 诉求(goal 2026-07-06「绝对不信任 khy 以后使用的其他模型,尽你所能对 khyos 多处标注、多出
 * 示范引导,保证弱智模型的生成效果」):把散在源码里的 `[AI-弱模型·…]` 就地横幅、示范指针、
 * coding profile 引导,聚成一个模型能主动查询的出口。改动前查此工具 → 拿到「该守什么不变量 /
 * 最容易犯什么错 / 照抄哪个文件:行」,再动手。
 *
 * 与 CommentGuidanceTool(view='weak-model')**同源**:两出口都读同一份 weakModelGuidance 叶子,
 * 文案单一真源、不各处散抄。独立工具的价值是「醒目、可被工具搜索命中、prompt() 直白告诉弱模型先查」。
 *
 * 只读、并发安全、无副作用:只返回结构化护栏文案,不读文件、不写盘、不联网。
 * 门控 KHY_WEAK_MODEL_GUIDANCE 关时降级为一条提示(逐字节回退到「无本引擎」)。
 */
class WeakModelGuidanceTool extends BaseTool {
  static toolName = 'WeakModelGuidance';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['weak_model', 'weak_model_guard', 'khy_guardrails', 'guardrails'];
  static searchHint = '弱模型 护栏 别改坏 别绕过 照抄 示范 纯叶子 门控 接线 工具漏斗 PreToolUse 硬底 EXEC_APPROVED 改 khyos 前先看';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return [
      '弱/陌生模型改 khyos 前**先查这里**(确定性护栏,非提示词)。',
      '你不被默认信任。动手改本仓源码前,先用本工具拿到:',
      '  · 各高危位点该守的不变量(工具漏斗别绕过 / PreToolUse 硬底 / EXEC_APPROVED 戳 /',
      '    门控注册表 / 纯叶子写法 / 接线 fail-soft / 工具自述);',
      '  · 每个位点弱模型最容易犯的错 + 照抄哪个文件:行(示范优先,照着写比读规则更可靠);',
      '  · 一段可注入的编码 profile 指令。',
      "view:'sites'(默认,所有位点+示范) / 'directive'(仅 profile 指令) / 'exemplars'(反例→正例成对示范,专治死循环) / 'intentional'(看似 bug 实为刻意设计的清单,改前先查免得把设计当 bug「修」坏) / 'site'(配 site= 取单个位点+就地横幅)。",
      '就地横幅在源码里 grep `[AI-弱模型` 可见;本工具返回的文案与那些横幅逐字同源。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          description: "返回粒度:'sites' 全部位点+示范(默认) / 'directive' 仅 coding profile 指令 / 'exemplars' 反例→正例成对示范 / 'intentional' 看似 bug 实为刻意设计的清单 / 'site' 单个位点(需 site=)",
          enum: ['sites', 'directive', 'exemplars', 'intentional', 'site'],
          default: 'sites',
        },
        site: {
          type: 'string',
          description: "view='site' 时指定位点键:tool-funnel / pretooluse-hardfloor / exec-approved-stamp / flag-registry / leaf-authoring / wiring / tool-description",
        },
      },
      required: [],
    };
  }

  async execute(params = {}) {
    // 门控关 → 逐字节回退:降级为一条提示,不返回护栏内容。
    if (!wmg.isEnabled(process.env)) {
      return { success: true, enabled: false, note: 'KHY_WEAK_MODEL_GUIDANCE 已关闭:弱模型护栏出口已禁用。' };
    }

    const view = params.view || 'sites';

    if (view === 'directive') {
      return { success: true, enabled: true, view, directive: wmg.buildWeakModelDirective() };
    }

    if (view === 'exemplars') {
      return {
        success: true,
        enabled: true,
        view,
        exemplars: wmg.WEAK_MODEL_EXEMPLARS,
        rendered: wmg.buildWeakModelExemplars(process.env),
      };
    }

    if (view === 'intentional') {
      return {
        success: true,
        enabled: true,
        view,
        intentionalDesigns: wmg.INTENTIONAL_DESIGNS,
        rendered: wmg.buildIntentionalDesigns(process.env),
      };
    }

    if (view === 'site') {
      const key = String(params.site || '');
      const site = wmg.GUARD_SITES[key];
      if (!site) {
        return {
          success: false,
          error: `未知位点:${key || '(空)'}。可选:${Object.keys(wmg.GUARD_SITES).join(' / ')}`,
        };
      }
      return { success: true, enabled: true, view, site: { key, ...site, banner: wmg.bannerFor(key) } };
    }

    // sites(默认):所有位点 + 就地横幅 + 调工具要点 + 反例示范 + 刻意设计清单 + profile 指令。
    return {
      success: true,
      enabled: true,
      view: 'sites',
      sites: wmg.listGuardSites().map(s => ({ ...s, banner: wmg.bannerFor(s.key) })),
      toolCallHint: wmg.toolCallHint(),
      exemplars: wmg.WEAK_MODEL_EXEMPLARS,
      intentionalDesigns: wmg.INTENTIONAL_DESIGNS,
      directive: wmg.buildWeakModelDirective(),
    };
  }

  getActivityDescription(input) {
    const view = (input && input.view) || 'sites';
    if (view === 'directive') return '弱模型编码指令查询';
    if (view === 'exemplars') return '弱模型反例示范查询';
    if (view === 'intentional') return '刻意设计清单查询(勿把设计当 bug)';
    if (view === 'site') return `弱模型护栏查询(${(input && input.site) || '?'})`;
    return '弱模型护栏查询';
  }
}

module.exports = WeakModelGuidanceTool;
