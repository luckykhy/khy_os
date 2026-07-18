'use strict';

/**
 * trajectoryProvenance — 轨迹溯源标准（DESIGN-ARCH-047）。
 *
 * 防御「经外部 agent 中转时的轨迹投毒」的核子系统。各模块均为纯函数 / 受控 IO：
 *   - khyTrace            : `_khyTrace` 信封 schema 单一真源
 *   - provenanceClassifier: 入站 producer/trust 分类
 *   - traceProjection     : 人读标签 / 回放投影
 *   - traceChain          : 防篡改 sidecar 哈希链（P2）
 *   - claimReconciler     : 正文声称 vs 本地工具日志的确定性核对（P4）
 *
 * 后续阶段（traceChain/claimReconciler）落地后在此补充 re-export。
 */

const khyTrace = require('./khyTrace');
const provenanceClassifier = require('./provenanceClassifier');
const traceProjection = require('./traceProjection');
const traceChain = require('./traceChain');
const quarantinePolicy = require('./quarantinePolicy');
const claimReconciler = require('./claimReconciler');

module.exports = {
  ...khyTrace,
  classify: provenanceClassifier.classify,
  classifyProducer: provenanceClassifier.classifyProducer,
  projection: traceProjection,
  chain: traceChain,
  quarantine: quarantinePolicy,
  khyTrace,
  provenanceClassifier,
  traceProjection,
  traceChain,
  quarantinePolicy,
  claimReconciler,
};
