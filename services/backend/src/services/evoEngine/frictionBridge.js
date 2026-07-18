'use strict';

/**
 * frictionBridge.js — evoEngine 与活执行路径的非侵入接入适配器（协作，而非替代）。
 *
 * 这是「自举创世」从离线子系统接进运行态的接缝。核心铁律：**协作不替代**。
 *   - executeTool 单漏斗在工具**真实失败**时，旁路抄送一份 friction 给本桥。核心循环照常
 *     产出/降级它自己的结果——本桥只是「顺手抄一份」，绝不接管工具分发权。
 *   - 本桥只做**轻量感知 + 留痕**：经 `PainPointScanner` 归因铸造 `EvoRequirement`，落入
 *     `evoLedger` 的 `observations` 分支作为运行态痛点**待办积压**。
 *   - 它**绝不**在热路径上跑代码生成或沙箱——那是离线 `SelfBootstrapEngine.evolve` 的事
 *     （消费本积压）。把昂贵的影子验证留在热路径之外，是「不拖慢工具调用」的硬约束。
 *
 * fail-soft 三连：有界去重（同一痛点签名每进程只留痕一次，带上限淘汰）、永不抛、永不阻断
 * 工具结果。任何内部异常都被吞掉——观测失败绝不能影响一次工具调用的正确性。
 *
 * 接入开关 `KHY_EVO_ENGINE`（默认**开启**，置 `off` 关闭）——自进化观测随弱模型交付解锁默认介入；
 * 注意本桥自身不读该 env，门控由各调用方（toolCalling / learningImprove）按统一约定执行。
 */

const OBSERVATION_BRANCH = 'observations';
const SEEN_CAP = 2000; // 去重集合上限：超出按插入序淘汰最旧，防无界增长。

let _scanner = null;
let _ledger = null;
const _seen = new Set(); // 已留痕的 EvoRequirement.id，跨调用去重。

function _getScanner() {
  if (_scanner) return _scanner;
  try {
    const { PainPointScanner } = require('./painPointScanner');
    _scanner = new PainPointScanner();
  } catch { _scanner = null; }
  return _scanner;
}

function _getLedger() {
  if (_ledger) return _ledger;
  try { _ledger = require('./evoLedger'); } catch { _ledger = null; }
  return _ledger;
}

function _remember(id) {
  if (_seen.size >= SEEN_CAP) {
    const oldest = _seen.values().next().value;
    if (oldest !== undefined) _seen.delete(oldest);
  }
  _seen.add(id);
}

/**
 * 观测一次工具失败：感知 → 归因 → 铸造需求 → 留痕（待离线演进消费）。
 *
 * 轻量且 fail-soft——不生成代码、不碰沙箱、永不抛、永不阻断调用方。
 *
 * @param {object} friction
 * @param {string} [friction.signal]   evoRequirement.SIGNALS.*（默认 tool-failure）
 * @param {string} [friction.surface]  失败发生面（工具名/模块），用于签名与定位
 * @param {Error|object|string} [friction.error]  原始失败信号（喂给归因诊断）
 * @param {object} [friction.context]  诊断上下文 { tool, sessionId, ... }
 * @returns {{observed:boolean, requirementId?:string, level?:string, deduped?:boolean, reason?:string}}
 */
function observeFailure(friction = {}) {
  try {
    const scanner = _getScanner();
    const ledger = _getLedger();
    if (!scanner || !ledger) return { observed: false, reason: 'bridge-unavailable' };

    const req = scanner.scan(friction);
    if (!req || !req.id) return { observed: false, reason: 'no-requirement' };

    // 有界去重：同一痛点签名每进程只留痕一次，避免反复失败刷爆日志。
    if (_seen.has(req.id)) return { observed: false, deduped: true, requirementId: req.id, level: req.level };
    _remember(req.id);

    ledger.append(
      ledger.KIND.REQUIREMENT,
      {
        source: 'runtime-friction',
        requirementId: req.id,
        signal: req.signal,
        level: req.level,
        executionLevel: req.executionLevel,
        painPoint: req.painPoint,
        attribution: req.attribution,
        impact: req.impact,
        surface: req.attribution && req.attribution.surface,
      },
      { branch: OBSERVATION_BRANCH },
    );
    return { observed: true, requirementId: req.id, level: req.level };
  } catch {
    // 防呆：观测路径任何异常都不得冒泡到工具调用。
    return { observed: false, reason: 'observe-error' };
  }
}

/** 读取运行态痛点待办积压（供离线 evolve 消费 / 测试）。 */
function pendingObservations() {
  const ledger = _getLedger();
  if (!ledger) return [];
  try { return ledger.read({ branch: OBSERVATION_BRANCH }); }
  catch { return []; }
}

/** 仅供测试：清空进程内去重集合（不动盘上日志）。 */
function _resetForTest() { _seen.clear(); _scanner = null; _ledger = null; }

module.exports = {
  OBSERVATION_BRANCH,
  observeFailure,
  pendingObservations,
  _resetForTest,
};
