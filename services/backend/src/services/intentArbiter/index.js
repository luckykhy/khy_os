'use strict';

/**
 * intentArbiter/index.js — IntentArbiter，意图精准裁决门面（§4 编排）。
 *
 * 把「意图光谱解析 + 动态提权 + 分级沙箱 + 误判淬火」串成一条输入预处理闭环，在「防误触」
 * 与「识意图」之间动态平衡：
 *
 *   原始输入
 *     │
 *   dispatch(text)
 *     ├─ IntentSpectrumAnalyzer.analyze   → 连续置信度 + 光谱段
 *     └─ TieredResponseRouter.route       → Chat / Confirm / Execution 沙箱
 *           ├─ Chat       闲聊物理隔绝（你是什么模型 → 模板回答）
 *           ├─ Confirm    歧义强制确认（防呆②：绝不自主猜测执行；防呆④：零副作用）
 *           └─ Execution  放行入闸（下游串数据主权网关 + 权限审批，[DESIGN-ARCH-040]）
 *     │
 *   confirm(originalText, reply)   用户二次明确后才放行（防呆②）
 *     │
 *   feedback(correctionText, ctx)  误触/漏判纠正 → MisjudgmentQuencher 定向进化（防呆③）
 *           ↓
 *   需求池（evoLedger 不可变哈希链）
 *
 * 零侵入：自成纯子系统，不接管输入主循环；可由后续 PR 把真实 NL 输入接入 dispatch、
 * 把 Execution 放行结果串到 [[dataSovereignty]] 与权限审批之前。
 */

const { IntentSpectrumAnalyzer } = require('./intentSpectrumAnalyzer');
const { TieredResponseRouter, EXECUTION_DOWNSTREAM } = require('./tieredResponseRouter');
const { MisjudgmentQuencher, MISJUDGMENT_KIND } = require('./misjudgmentQuencher');
const { BANDS } = require('./intentLexicon');
const calibration = require('./intentCalibration');
const evoLedger = require('../evoEngine/evoLedger');

const DEFAULT_BRANCH = 'intent_arbiter_pool';

// 历史校准读账本上限:只看末尾 N 条误触样本(防账本膨胀拖慢默认关的安全检查)。
// 非静默截断 —— 在校准归因里说明「基于近 N 条纠正」。
const CALIBRATION_POOL_CAP = 200;

const AFFIRMATIVE = Object.freeze(['y', 'yes', '是', '确认', '确定', '对', '好', '嗯', '要', '可以', '进入']);
const NEGATIVE = Object.freeze(['n', 'no', '否', '不', '不要', '取消', '算了', '别']);

class IntentArbiter {
  constructor(opts = {}) {
    this.branch = opts.branch || DEFAULT_BRANCH;
    this.analyzer = opts.analyzer || new IntentSpectrumAnalyzer();
    this.router = opts.router || new TieredResponseRouter();
    this.quencher = opts.quencher || new MisjudgmentQuencher();
    this.ledger = opts.ledger || evoLedger;
  }

  /**
   * 输入预处理主入口：解析意图光谱 → 分级路由。永不直接执行（零侵入）。
   * @param {string} text
   * @returns {{status:'chat'|'confirm'|'execution', analysis:object, route:object}}
   */
  dispatch(text) {
    const analysis = this.analyzer.analyze(text);
    // 确定性历史校准（Phase C-2 第 2 层，best-effort，仅降级）。门控关 → calibrated===analysis。
    const calibrated = this._calibrate(analysis);
    const route = this.router.route(calibrated);
    const status = route.band === BANDS.EXECUTION ? 'execution'
      : route.band === BANDS.CONFIRM ? 'confirm' : 'chat';
    return { status, analysis: calibrated, route };
  }

  /**
   * 确定性历史校准（Phase C-2 第 2 层）：把只写不读的 intent_arbiter_pool 账本变得可用。
   * 对**歧义带**输入,用既往「误触(false-trigger)」纠正记录做纯词法相似度比对,命中即把
   * 置信度压向更安全的对话带（CHAT）。**绝不**引入向量/模型（确定性 + 可解释 + 零网络延迟）。
   *
   * 安全不变式（防呆②）:校准**只降级不升档** —— intentCalibration 叶子结构上只产出 CHAT
   * 或不调整,facade 这里也绝不抬升 band。`miss`(漏判)样本刻意被过滤掉,不参与自动路由。
   * 全程 best-effort:任何异常 → 返回未校准 analysis,绝不因校准失败影响主裁决。
   *
   * @param {object} analysis  IntentSpectrumAnalyzer.analyze 输出
   * @returns {object} 校准后的 analysis（或原样）
   */
  _calibrate(analysis) {
    try {
      if (!calibration.isEnabled(process.env)) return analysis;
      const entries = this.pool(); // 已内置 try/catch,失败返 []
      if (!Array.isArray(entries) || entries.length === 0) return analysis;
      const exemplars = entries
        .filter((e) => e && e.payload
          && e.payload.misjudgmentKind === MISJUDGMENT_KIND.FALSE_TRIGGER
          && typeof e.payload.originalText === 'string'
          && e.payload.originalText)
        .slice(-CALIBRATION_POOL_CAP)
        .map((e) => ({ originalText: e.payload.originalText }));
      if (exemplars.length === 0) return analysis;

      const c = calibration.selectCalibration(analysis, exemplars, process.env);
      if (!c || !c.adjusted) return analysis;
      // 叶子结构上只产出 CHAT；此处再兜一道防呆②,绝不让校准把 band 抬到执行带。
      if (c.band === BANDS.EXECUTION) return analysis;
      return {
        ...analysis,
        band: c.band,
        confidence: c.confidence,
        reasons: Array.isArray(analysis.reasons) ? [...analysis.reasons, c.reason] : [c.reason],
        calibrated: true,
      };
    } catch {
      return analysis;
    }
  }

  /**
   * 歧义带的二次裁决（防呆②）：只有用户**显式确认**才放行执行；否定即中止。
   * 系统绝不自主猜测——确认权完全交回用户。
   * @param {string} originalText  原歧义输入
   * @param {string} reply         用户答复（Y/N/是/否…）
   * @returns {{status:'execution'|'aborted'|'unclear', route?:object, analysis?:object}}
   */
  confirm(originalText, reply) {
    const r = String(reply || '').trim().toLowerCase();
    const isYes = AFFIRMATIVE.some((w) => r === w.toLowerCase() || r.startsWith(w.toLowerCase()));
    const isNo = NEGATIVE.some((w) => r === w.toLowerCase() || r.startsWith(w.toLowerCase()));

    if (isYes && !isNo) {
      // 显式确认 → 置信度跃升至执行带，放行入闸（仍须经下游主权网关 + 审批）。
      const analysis = this.analyzer.analyze(originalText);
      const confirmed = { ...analysis, confidence: 1.0, band: BANDS.EXECUTION };
      const route = this.router.route(confirmed);
      route.note = '用户二次确认放行（防呆②）；执行前仍须经数据主权网关 + 权限审批';
      return { status: 'execution', analysis: confirmed, route };
    }
    if (isNo) {
      return { status: 'aborted', reason: '用户否决，意图不放行（防误触）' };
    }
    // 答复本身仍歧义 → 不猜测，继续要求明确（防呆②）。
    return { status: 'unclear', reason: '确认答复无法判定，继续要求用户明确，绝不自主猜测执行' };
  }

  /**
   * 误判反馈淬火（防呆③）：捕获用户纠正（误触/漏判）→ 定向进化需求落账本。
   * @param {string} correctionText
   * @param {object} [context] { originalText, confidence, band }
   * @returns {{status:'quenched'|'no-signal', misjudgmentKind?:string, quench?:object}}
   */
  feedback(correctionText, context = {}) {
    const quench = this.quencher.quench(correctionText, context);
    if (!quench) return { status: 'no-signal' };
    this._log(quench);
    return { status: 'quenched', misjudgmentKind: quench.misjudgmentKind, quench };
  }

  /** 意图进化需求池（不可变哈希链拷贝）。 */
  pool() {
    try { return this.ledger.read({ branch: this.branch }); } catch { return []; }
  }

  /** 校验需求池链完整性（复用 evoLedger）。 */
  verifyPool() {
    try { return this.ledger.verify({ branch: this.branch }); }
    catch { return { ok: false, length: 0, brokenAt: null, reason: 'verify-error' }; }
  }

  _log(quench) {
    try {
      return this.ledger.append(this.ledger.KIND.REQUIREMENT, {
        source: 'intent-arbiter',
        misjudgmentKind: quench.misjudgmentKind,
        targetFeature: quench.targetFeature,
        requirementId: quench.requirement.id,
        level: quench.requirement.level,
        originalText: quench.requirement.originalText,
      }, { branch: this.branch });
    } catch { return { ok: false }; }
  }
}

module.exports = {
  IntentArbiter,
  IntentSpectrumAnalyzer,
  TieredResponseRouter,
  MisjudgmentQuencher,
  MISJUDGMENT_KIND,
  BANDS,
  EXECUTION_DOWNSTREAM,
};
