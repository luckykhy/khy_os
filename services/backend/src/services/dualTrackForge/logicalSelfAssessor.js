'use strict';

/**
 * logicalSelfAssessor.js — 模型辅助增益轨（§3.3 旁路 / 增益）。
 *
 * 物理断言判不出的软性逻辑异常（语义跑偏、张冠李戴、目标未达成），交由模型做一次深度自省：
 * 「为何现有能力拓扑无法达成目标？需要补全什么架构能力？」模型是**增益器**，不是阻塞点——
 *
 *   - 注入式 brain（与 evoEngine.codeGenerator 同构）：引擎本身不内嵌模型，可确定性单测；
 *   - 超时 race + 全程 try/catch：模型超时 / 抛错 / 拒绝评估 → **静默返回 null**（防呆①）；
 *   - 输出严格解析 + 置信度阈值（默认 0.6）过滤：坏格式 / 缺字段 / 低置信 → 丢弃（防呆②）。
 *
 * 本轨任何异常都不得冒泡、不得阻断主干确定性轨。`assess()` 的契约是：要么给一份合格增益，
 * 要么给 null，**永不抛**。
 */

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;   // §5 防呆②：默认阈值（高于 §3.3 注释的 0.5，取严）
const DEFAULT_TIMEOUT_MS = 4000;

/** 软性逻辑异常：模型自评判定业务逻辑未达标。无响应时此路静默（不构造此异常）。 */
class LogicalException extends Error {
  constructor(hypothesis, confidence) {
    super(`LogicalException: ${hypothesis}`);
    this.name = 'LogicalException';
    this.hypothesis = hypothesis;
    this.confidence = confidence;
    this.logical = true;
  }
}

class LogicalSelfAssessor {
  /**
   * @param {object} opts
   * @param {function} opts.brain        (prompt|snapshot) => Promise<assessment>；自省模型（注入）
   * @param {number}   [opts.threshold]  置信度阈值（默认 0.6）
   * @param {number}   [opts.timeoutMs]  模型超时（默认 4000）
   */
  constructor(opts = {}) {
    this.brain = typeof opts.brain === 'function' ? opts.brain : null;
    this.threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_CONFIDENCE_THRESHOLD;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  /**
   * 对一次失败现场做软性自评，产出增益假设（或 null）。永不抛。
   * @param {object} snapshot { input, context, output, goal, physicalCode }
   * @returns {Promise<{root_cause_hypothesis:string, suggested_evo_requirement:string, confidence:number, l2Plan?:object}|null>}
   */
  async assess(snapshot = {}) {
    if (!this.brain) return null;
    let raw;
    try {
      raw = await this._withTimeout(Promise.resolve().then(() => this.brain(this._buildPrompt(snapshot))), this.timeoutMs);
    } catch {
      return null;   // 防呆①：超时 / 模型抛错 / 拒绝评估 → 静默降级
    }
    const ev = this.evaluate(raw);
    return ev.ok ? ev.value : null;
  }

  /**
   * 纯函数：解析 + 校验 + 置信度过滤。供门面与测试无副作用地复核过滤逻辑。
   * @returns {{ok:true, value:object}|{ok:false, reason:string, confidence?:number}}
   */
  evaluate(raw) {
    const obj = this._coerce(raw);
    if (!obj) return { ok: false, reason: 'unparseable' };

    const suggestion = obj.suggested_evo_requirement || obj.suggestion || obj.requirement;
    if (!suggestion || !String(suggestion).trim()) return { ok: false, reason: 'no-suggestion' };

    const confidence = this._num(obj.confidence);
    if (confidence == null) return { ok: false, reason: 'no-confidence' };

    if (confidence < this.threshold) {
      return { ok: false, reason: 'low-confidence', confidence };
    }

    const value = {
      root_cause_hypothesis: String(obj.root_cause_hypothesis || obj.hypothesis || '（模型未给根因）').slice(0, 600),
      suggested_evo_requirement: String(suggestion).slice(0, 600),
      confidence: Math.max(0, Math.min(1, confidence)),
    };
    // 模型若给出架构对比 + 爆炸半径，则允许其建议升至 L2（仍受 planL2 强制降级闸门约束）。
    const l2 = obj.l2Plan || obj.l2_plan;
    if (l2 && (l2.architectureDiff || l2.blastRadius)) {
      value.l2Plan = {
        architectureDiff: String(l2.architectureDiff || '').slice(0, 800),
        blastRadius: String(l2.blastRadius || '').slice(0, 800),
      };
    }
    return { ok: true, value };
  }

  _coerce(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    // 容忍模型在 JSON 前后夹带散文：抽取首个对象。
    try { return JSON.parse(raw); } catch { /* fallthrough */ }
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
    return null;
  }

  _num(x) {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
    return null;
  }

  _buildPrompt(snapshot) {
    return {
      task: '对以下失败现场做根因自省：为何现有能力拓扑无法达成目标？需要补全什么架构能力？',
      input: snapshot.input,
      context: snapshot.context,
      output: snapshot.output,
      goal: snapshot.goal,
      physicalCode: snapshot.physicalCode || null,
      outputFormat: { root_cause_hypothesis: 'string', suggested_evo_requirement: 'string', confidence: '0..1' },
    };
  }

  _withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('assessor-timeout')); }
      }, ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
      p.then(
        (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
        (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
      );
    });
  }
}

module.exports = { LogicalSelfAssessor, LogicalException, DEFAULT_CONFIDENCE_THRESHOLD, DEFAULT_TIMEOUT_MS };
