'use strict';

/**
 * dependency/ — Agent 依赖自愈子系统门面。
 *
 * 当工具/依赖不完整时，把「硬中断」转为「交互式修复」：探测缺失 → 询问安装 →
 * 隔离执行（命令仅来自 registry）→ 校验 → 重试原调用恰一次。
 *
 * 接入点：services/toolCalling.executeTool 在工具失败后非侵入调用 heal()。
 * 工具侧可主动用 ensure(depId) / MissingDependencyError 发出结构化缺失信号。
 *
 * 规范：docs/03_DESIGN_设计/[DESIGN-ARCH-027] Agent 依赖自愈机制.md
 */

const registry = require('./registry');
const resolver = require('./resolver');
const installRunner = require('./installRunner');
const healingLoop = require('./healingLoop');
const toolchainVersions = require('./toolchainVersions');

module.exports = {
  // registry
  getDependency: registry.getDependency,
  listDependencyIds: registry.listDependencyIds,
  listDependencies: registry.listDependencies,
  // resolver
  probe: resolver.probe,
  ensure: resolver.ensure,
  detectFromError: resolver.detectFromError,
  buildInstallPlan: resolver.buildInstallPlan,
  MissingDependencyError: resolver.MissingDependencyError,
  defaultEnv: resolver.defaultEnv,
  // install
  runInstall: installRunner.runInstall,
  // healing loop
  isEnabled: healingLoop.isEnabled,
  heal: healingLoop.heal,
  summarizeForAgent: healingLoop.summarizeForAgent,
  createSession: healingLoop.createSession,
  resetSession: healingLoop.resetSession,
  // 按需选版本（「按客户需求」）
  parseDepSpec: toolchainVersions.parseDepSpec,
  isVersionable: toolchainVersions.isVersionable,
  supportedVersions: toolchainVersions.supportedVersions,
  listVersionable: toolchainVersions.listVersionable,
  describeVersions: toolchainVersions.describeVersions,
  // sub-modules for advanced use / tests
  registry,
  resolver,
  installRunner,
  healingLoop,
  toolchainVersions,
};
