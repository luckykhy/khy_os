'use strict';

/**
 * auditTrajectory — 审计级开发轨迹通道（外部质检的交付物本体）。
 *
 * 这条通道存在的前提：外部质检方用脚本解析轨迹，逐轮判定「有效轮」，三条同时
 * 满足才算 —— 有新的增量要求、有可见的工具调用行为、有非空 diff 或「运行 + 截图」
 * 的验证动作。所以轨迹是**审计记录**，不是对话缓存：运行时的上下文压缩不许反向
 * 写回轨迹文件。
 *
 * 与既有两条通道的关系（三条互不读写）：
 *   - cli/aiSession.js 的 saveConversation()：单个 .json，超过 6 条消息就 aggressive
 *     compact 只留约 20%。是对话缓存，本通道不碰它。
 *   - services/sessionPersistence.js 的 transcript JSONL：从 `_chatState.messages`
 *     按高水位增量推导，压缩截短 messages 后就停止追加。同样不能当审计记录。
 *   - 本通道：事件发生的当下直接 append + fsync，物理上没有截断路径。
 *
 * 模块分工：
 *   recorder     写：append-only JSONL，永不压缩/裁剪/摘要
 *   diffCapture  证：文件修改类工具的 before/after/unified diff
 *   parser       读：{messages:[]} 形态通用解析器 + 有效轮判定（QA 脚本的本地等价物）
 *   wire         接：把上面三者挂到既有 hook 事件上，零侵入（不改一行现有代码）
 *
 * 提示词起草与验收（人工确认才发出，验证成本分三级）：
 *   drafter     草：下一轮提示词的草稿 + 六道硬性自检；无发送能力，confirmDraft 需真人署名
 *   acceptance  验：一级 grep（秒级，每块都过）/ 二级实际点一遍（分钟级）/ 三级完整套件（收尾一次）
 *
 * 双进程隔离（Driver 在项目根，Worker 钉死在 workspace）：
 *   workspaceGuard 校：Worker 工作目录的启动前校验，不在 workspace 下就拒绝启动
 *   channel        隔：Driver 到 Worker 的唯一通道（一段纯自然语言文本）+ 环境变量白名单
 *   workerProcess  起：启动前钉死 cwd 拉起 Worker，滑动空闲超时（红线 3）
 *
 * 门控 KHY_AUDIT_TRAJECTORY（opt-in，默认关）。
 *
 * @module services/auditTrajectory
 */

const acceptance = require('./acceptance');
const channel = require('./channel');
const diffCapture = require('./diffCapture');
const drafter = require('./drafter');
const parser = require('./parser');
const recorder = require('./recorder');
const wire = require('./wire');
const workerProcess = require('./workerProcess');
const workspaceGuard = require('./workspaceGuard');

module.exports = {
  // 写
  AuditTrajectoryRecorder: recorder.AuditTrajectoryRecorder,
  normalizeOrigin: recorder.normalizeOrigin,
  isoWithOffset: recorder.isoWithOffset,
  EVENT: recorder.EVENT,
  ORIGIN: recorder.ORIGIN,

  // 证
  captureBefore: diffCapture.captureBefore,
  captureAfter: diffCapture.captureAfter,
  captureAfterAll: diffCapture.captureAfterAll,
  unifiedDiff: diffCapture.unifiedDiff,
  hasNonEmptyDiff: diffCapture.hasNonEmptyDiff,

  // 读
  parseTrajectory: parser.parseTrajectory,
  parseTrajectoryText: parser.parseTrajectoryText,
  judgeRounds: parser.judgeRounds,
  auditTrajectory: parser.auditTrajectory,
  similarity: parser.similarity,

  // 接
  attach: wire.attach,
  isEnabled: wire.isEnabled,

  // 校 / 隔 / 起（双进程隔离）
  isUnderWorkspace: workspaceGuard.isUnderWorkspace,
  validateWorkerCwd: workspaceGuard.validateWorkerCwd,
  assertWorkerCwd: workspaceGuard.assertWorkerCwd,
  WorkerCwdError: workspaceGuard.WorkerCwdError,
  scanForbidden: channel.scanForbidden,
  buildWorkerMessage: channel.buildWorkerMessage,
  assertWorkerMessage: channel.assertWorkerMessage,
  sanitizeEnv: channel.sanitizeEnv,
  ChannelViolationError: channel.ChannelViolationError,
  // 草 / 验（提示词起草器 + 三级验收器）
  composeDraft: drafter.composeDraft,
  draft: drafter.draft,
  splitDraft: drafter.splitDraft,
  runSelfChecks: drafter.runSelfChecks,
  buildAnchorSet: drafter.buildAnchorSet,
  stripDashes: drafter.stripDashes,
  confirmDraft: drafter.confirmDraft,
  DraftNotConfirmedError: drafter.DraftNotConfirmedError,
  tier1Grep: acceptance.tier1Grep,
  tier2Interact: acceptance.tier2Interact,
  tier3FullSuite: acceptance.tier3FullSuite,
  runLadder: acceptance.runLadder,
  AcceptancePolicy: acceptance.AcceptancePolicy,
  Tier3RefusedError: acceptance.Tier3RefusedError,
  TIER: acceptance.TIER,

  planWorkerLaunch: workerProcess.planWorkerLaunch,
  launchWorker: workerProcess.launchWorker,
  pinnedCwdFromEnv: workerProcess.pinnedCwdFromEnv,
  attachInWorker: workerProcess.attachInWorker,

  // 子模块（需要完整表面时直接取）
  recorder,
  diffCapture,
  parser,
  wire,
  workspaceGuard,
  channel,
  workerProcess,
  drafter,
  acceptance,
};
