'use strict';

/**
 * aiGatewayGenerateMethodDepsFailFast.test.js — 锁定 setAiGatewayGenerateMethodDeps 的
 * fail-fast 注入校验契约(Batch 4 语义分组改造):
 *   1) 必选项缺失 → 注入期立即抛错,错误消息点名缺失项(组名.项名)与进度(已注入 n/总 m);
 *      注:绑定先于校验且累积,故该用例必须是本文件首次注入;
 *   2) 可选项(diagnostics 三个 set-once let)缺失不抛;
 *   3) 全量分组注入正常;旧扁平形态与分组形态等价(测试桩增量覆盖惯用法不破);
 *   4) 增量合并语义:全量注入后再部分覆盖(甚至传 undefined)不抛——校验的是合并后模块状态。
 *
 * jest 隔离每个测试文件的 module registry,此处 require 到的叶子是全新未注入实例,
 * 不会污染其他套件共享的 aiGateway 单例注入状态。
 */

const genLeaf = require('../../src/services/gateway/aiGatewayGenerateMethod');

// 与叶子侧 DEP_GROUPS 必选清单一致(32 项;故意在测试里重写一份——清单漂移时全量注入用例会抛错暴露)。
const REQUIRED = [
  // validation
  '_extractResultErrorMessage', '_isDeadEndpointErrorType', '_isHttpRelayAdapter',
  '_isProcessSensitiveAdapter', '_isRetryableResultErrorType', '_isTransientGatewayTransportMessage',
  '_parseMs', '_parsePositiveInt', '_resolveResultErrorType', 'classifyError',
  // failover
  '_defaultModelForApiPoolProvider', '_mapApiPoolProviderToServiceProvider', '_normalizeApiPoolProvider',
  '_prependFailureReason', '_resolveApiPoolProviderForRequest', 'buildPreferredAdapterRecoveryHint',
  'collectProviderSiblingModels', 'createLinkedAbortController', 'normalizeAbortReason',
  'normalizeModelForAdapter', 'resolvePreferredModelForAdapter', 'throwIfAborted',
  // languageRecovery
  '_buildLanguageMismatchFailureMessage', '_createCodexChineseChunkGate',
  '_createKhyLanguageConsistencyTracker', '_injectKhyChineseRecoveryPrompt',
  '_injectKhyChineseRecoverySystem', '_resolveCodexChineseRecoveryRetryBudget',
  '_shouldAutoRecoverCodexChineseMismatch',
  // ocrRescue(遗留项 extractImageOcrTexts 已于 Batch 5 从注入清单移除)
  '_appendVisionKeyOffer', 'extractImageOcrDetails', 'tryRateLimitOcrRescue',
];

function fullFlatStubs() {
  const o = {};
  for (const n of REQUIRED) o[n] = () => {};
  return o;
}

describe('setAiGatewayGenerateMethodDeps fail-fast 注入校验', () => {
  test('必选项缺失 → 抛错,消息含动作+目标+进度与缺失项点名(组名.项名)', () => {
    // 注意:模块级绑定是累积的(先绑定后校验),本用例必须是本文件内的首次注入——
    // 此时叶子实例全新未注入,删掉的 2 项才真正缺失于合并态。
    const partial = fullFlatStubs();
    delete partial.classifyError;
    delete partial.tryRateLimitOcrRescue;
    expect(() => genLeaf.setAiGatewayGenerateMethodDeps(partial)).toThrow(
      /注入 aiGatewayGenerateMethod 依赖失败:必选 32 项中已注入 30 项、缺失 2 项\(validation\.classifyError, ocrRescue\.tryRateLimitOcrRescue\)/,
    );
  });

  test('全量必选注入(旧扁平形态)不抛;可选项缺失不抛', () => {
    // 不带 _advDiag/_modelSwitch/_traceAudit —— 可选,不纳入必选校验。
    expect(() => genLeaf.setAiGatewayGenerateMethodDeps(fullFlatStubs())).not.toThrow();
  });

  test('分组形态注入不抛,与扁平形态等价接受', () => {
    const flat = fullFlatStubs();
    const grouped = {
      validation: {}, failover: {}, languageRecovery: {}, ocrRescue: {},
      diagnostics: { _advDiag: null, _modelSwitch: null, _traceAudit: null },
    };
    // 按组名前缀无关地摊回(setter 内部本就摊平;此处仅验证分组包裹形态被接受)。
    const GROUP_OF = {
      validation: REQUIRED.slice(0, 10),
      failover: REQUIRED.slice(10, 22),
      languageRecovery: REQUIRED.slice(22, 29),
      ocrRescue: REQUIRED.slice(29),
    };
    for (const g of Object.keys(GROUP_OF)) {
      for (const n of GROUP_OF[g]) grouped[g][n] = flat[n];
    }
    expect(() => genLeaf.setAiGatewayGenerateMethodDeps(grouped)).not.toThrow();
  });

  test('增量合并语义:全量注入后,部分覆盖(含 undefined 值)不抛——校验合并后状态', () => {
    genLeaf.setAiGatewayGenerateMethodDeps(fullFlatStubs());
    // 测试桩惯用法:仅覆盖 1-2 项(visionStripImageFloorWiring 等 12 处现存调用形态)。
    expect(() => genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: () => [] })).not.toThrow();
    // undefined 值 = no-op(既有语义),合并态仍全量 → 不抛。
    expect(() => genLeaf.setAiGatewayGenerateMethodDeps({ extractImageOcrDetails: undefined, collectProviderSiblingModels: undefined })).not.toThrow();
  });
});
