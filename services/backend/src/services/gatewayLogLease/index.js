'use strict';

/**
 * gatewayLogLease/index.js — 「网关日志租界隔离」门面（DESIGN-ARCH-031）。
 *
 * 把四件套收成稳定 API，供网关/适配器以非侵入方式接入：
 *
 *   AdapterLogSandbox（sandbox.js）  拦截底层输出 + 静默沙箱 + 后台报错守卫
 *   GatewayLogLease  （logLease.js） 按活跃适配器/查询态裁决可见性（L0/L1/BUFFER/DROP）
 *   NoiseFilter      （noiseFilter） 底层错误→用户友好提示 / 脱敏
 *   context          （context.js）  AsyncLocalStorage 租界上下文
 *
 * 典型接入（最小侵入，对齐 ARCH-025/027/029「自带闭环 + 文档化接缝」先例）：
 *
 *   const lease = require('.../gatewayLogLease');
 *   lease.install();                                   // 进程启动一次（env 门控）
 *
 *   // 请求路径：把一次对话绑定到被选中的适配器
 *   await lease.runForAdapter('kiro', () => gateway.chat(...));
 *
 *   // 适配器内部：Token 刷新 / 初始化放进静默沙箱
 *   const { result, error } = await lease.runSandboxed('kiro', () => refreshToken());
 *
 *   // 后台"发射后不管"：包一层，rejection 永不冒泡
 *   lease.guardBackground('kiro', () => probeHealth());
 *
 *   // 适配器显式打日志（推荐，不依赖文本嗅探）
 *   lease.emit('kiro', 'warn', 'Token refresh failed, falling back');
 *
 *   // /gateways 命令：查询态全量可见
 *   await lease.runStatusQuery(() => buildGatewayStatus());
 */

const ctxMod = require('./context');
const logLease = require('./logLease');
const noiseFilter = require('./noiseFilter');
const devLog = require('./devLog');
const sandbox = require('./sandbox');

module.exports = {
  // 安装 / 卸载
  install: sandbox.install,
  uninstall: sandbox.uninstall,
  installProcessGuards: sandbox.installProcessGuards,

  // 运行器（租界绑定）
  runForAdapter: sandbox.runForAdapter,
  runStatusQuery: sandbox.runStatusQuery,
  runSandboxed: sandbox.runSandboxed,
  guardBackground: sandbox.guardBackground,
  withSource: sandbox.withSource,
  emit: sandbox.emit,

  // 决策 / 净味 / 上下文（按需直用）
  decide: logLease.decide,
  CHANNELS: logLease.CHANNELS,
  translate: noiseFilter.translate,
  sanitize: noiseFilter.sanitize,
  sanitizeForStatus: noiseFilter.sanitizeForStatus,
  context: ctxMod,
  MODES: ctxMod.MODES,
  normalizeAdapterId: ctxMod.normalizeAdapterId,

  // L1 开发日志（排障/状态查询读取）
  devLog,

  ENV_FLAG: sandbox.ENV_FLAG,
};
