'use strict';

/**
 * dualTrackForge/index.js — DualTrackForge，双轨淬火 Bug 升维引擎门面（§4 编排）。
 *
 * 彻底贯彻「一切 Bug 皆需求」：把一次执行现场淬火成进化需求，两轨并行、主干保底：
 *
 *   执行尝试
 *     ├─ 主干：物理断言网关 → 命中即确定性升维 → 保底需求（先落盘，零模型）   [防呆③]
 *     └─ 旁路：模型自评 → 软逻辑增益（带置信度，可超时/失败/低置信被静默丢弃） [防呆①②]
 *            ↓
 *     需求熔铸合并（标 source_track）→ 置信度过滤 → 需求池（不可变哈希链）       [防呆④]
 *
 * 四防呆在编排层硬落实：
 *   ① 模型轨绝不阻塞主干——保底需求在 await 模型之前已铸成并落盘；模型轨 assess 永不抛。
 *   ② 增益需求受置信度阈值（默认 0.6）无情过滤——低置信假设丢弃，绝不污染需求池。
 *   ③ 物理异常被拦截时绝不跳过确定性映射等模型——保底需求最先发出、最先入账。
 *   ④ 每份需求必标 source_track，区分客观铁律与模型猜想。
 *
 * 模型 brain 为注入式：引擎无模型亦能跑（退化为纯确定性保底轨），可确定性单测。
 */

const { PhysicalAssertionGate, PhysicalException } = require('./physicalAssertionGate');
const { DeterministicElevator } = require('./deterministicElevator');
const { LogicalSelfAssessor, LogicalException } = require('./logicalSelfAssessor');
const { DualTrackRequirementMerger, SOURCE_TRACK } = require('./dualTrackMerger');
const { PHYSICAL_CODES } = require('./physicalCodes');
const evoLedger = require('../evoEngine/evoLedger');

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_BRANCH = 'dualtrack_pool';

class DualTrackForge {
  /**
   * @param {object} [opts]
   * @param {function} [opts.brain]      模型自省函数（注入）；缺省则只跑确定性保底轨
   * @param {number}   [opts.threshold]  置信度阈值（默认 0.6）
   * @param {number}   [opts.timeoutMs]  模型超时
   * @param {string}   [opts.branch]     需求池日志分支（默认 dualtrack_pool）
   * @param {object}   [opts.gate] [opts.elevator] [opts.assessor] [opts.merger] [opts.ledger]
   */
  constructor(opts = {}) {
    this.threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
    this.branch = opts.branch || DEFAULT_BRANCH;
    this.gate = opts.gate || new PhysicalAssertionGate();
    this.elevator = opts.elevator || new DeterministicElevator();
    this.merger = opts.merger || new DualTrackRequirementMerger({ threshold: this.threshold });
    this.ledger = opts.ledger || evoLedger;
    this.assessor = opts.assessor
      || (typeof opts.brain === 'function'
        ? new LogicalSelfAssessor({ brain: opts.brain, threshold: this.threshold, timeoutMs: opts.timeoutMs })
        : null);
  }

  /**
   * 淬火一次执行现场为进化需求。永不抛——主干确定性轨永远兜底。
   * @param {object} observation  执行现场（见 PhysicalAssertionGate.assert + { input, goal }）
   * @returns {Promise<object>} { status, source_track, requirement, ...双轨字段 }
   */
  async forge(observation = {}) {
    // —— 主干：物理断言（确定性，同步，最先） ——
    const physical = this.gate.assert(observation);

    // 防呆③：物理硬伤一旦判出，立刻确定性升维 + 落盘，绝不等模型。
    let backstop = null;
    if (physical) {
      backstop = this.elevator.elevate(physical);
      this._log({
        source: 'deterministic',
        track: SOURCE_TRACK.DETERMINISTIC,
        code: physical.code,
        requirementId: backstop.requirement.id,
        finding: backstop.finding,
        level: backstop.requirement.level,
        priority: backstop.priority,
      });
    }

    // —— 旁路：模型自评（可失败、静默丢弃，绝不阻断主干） ——
    let assisted = null;
    if (this.assessor) {
      // assess 自带超时 + try/catch，契约是「要么合格增益、要么 null」，永不抛。
      assisted = await this.assessor.assess(this._snapshot(observation, physical));
    }

    // —— 熔铸合并 ——
    if (backstop) {
      const merged = this.merger.merge(backstop, assisted);
      this._log({ source: 'merged', track: merged.source_track, requirementId: merged.requirementId,
        confidence: merged.confidence, escalatedToL2: merged.escalatedToL2, priority: merged.priority });
      return { status: 'forged', ...merged };
    }

    // 无物理硬伤，但模型捕获到软逻辑异常 → 纯 Assisted 轨。
    if (assisted) {
      const a = this.merger.fromAssisted(assisted, observation);
      this._log({ source: 'assisted', track: a.source_track, requirementId: a.requirementId,
        confidence: a.confidence, escalatedToL2: a.escalatedToL2, priority: a.priority });
      return { status: 'forged', ...a };
    }

    // 两轨皆无所获：物理无硬伤 + 模型无合格增益。
    return { status: 'clean', source_track: null, requirement: null };
  }

  /** 读取需求池（不可变哈希链拷贝）。 */
  pool() {
    try { return this.ledger.read({ branch: this.branch }); } catch { return []; }
  }

  /** 校验需求池链完整性（防呆⑤：进化历史不可篡改）。 */
  verifyPool() {
    try { return this.ledger.verify({ branch: this.branch }); }
    catch { return { ok: false, length: 0, brokenAt: null, reason: 'verify-error' }; }
  }

  _snapshot(observation, physical) {
    return {
      input: observation.input,
      context: observation.context,
      output: observation.output,
      goal: observation.goal,
      physicalCode: physical ? physical.code : null,
    };
  }

  _log(payload) {
    try { return this.ledger.append(evoLedger.KIND.REQUIREMENT, payload, { branch: this.branch }); }
    catch { return { ok: false }; }
  }
}

module.exports = {
  DualTrackForge,
  PhysicalAssertionGate,
  PhysicalException,
  DeterministicElevator,
  LogicalSelfAssessor,
  LogicalException,
  DualTrackRequirementMerger,
  SOURCE_TRACK,
  PHYSICAL_CODES,
};
