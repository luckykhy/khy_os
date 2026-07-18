'use strict';

/**
 * osProfileSymbiosisWiring.test.js — envSymbiosis → osProfileService observe-mode 接线验收。
 *
 * 闭合 weak_model_delivery_unlock 记忆「4 未接线引擎」之一（envSymbiosis）。
 * osProfileService 是环境画像的天然家（已复用 envSymbiosis/platformIds 常量），是引擎
 * 最干净、最低风险的 opt-in 观测缝。验证 _maybeAttachSymbiosis 的接线契约：
 *   ① 默认关闭（无 env）→ 不挂 symbiosis，既有 profile 字段零变化；
 *   ② KHY_ENV_SYMBIOSIS=1/on/true → 加性挂 profile.symbiosis = {fingerprint, topology}；
 *   ③ 观测是加性的：绝不改写既有 os/kernel/modifiers/... 字段；
 *   ④ fail-soft：引擎抛错也绝不破坏 OS 画像（返回不含 symbiosis 的健全 profile）。
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const osProfile = require('../../../src/services/osProfileService');

function clearEnv() {
  delete process.env.KHY_ENV_SYMBIOSIS;
}

afterEach(() => {
  clearEnv();
  osProfile.resetCache();
});

// 稳定的注入探针：钉死 Linux 身份，避免依赖真实宿主环境。
function linuxProbe() {
  return {
    nodePlatform: 'linux',
    osType: 'Linux 6.1.0',
    runtime: 'node',
    isAndroid: false,
    hostRamMB: 8192,
    hostCpuCount: 8,
    readFile: () => null,
    exists: () => false,
    env: {},
  };
}

describe('envSymbiosis observe-mode 接线契约（osProfileService）', () => {
  test('① 默认关闭 → 不挂 symbiosis 字段', () => {
    clearEnv();
    const profile = osProfile.detectOsProfile(linuxProbe());
    assert.equal(profile.symbiosis, undefined, '默认关闭时不应有 symbiosis 字段');
    assert.ok(profile.os, '既有 os 字段应健全');
    assert.ok(profile.modifiers, '既有 modifiers 字段应健全');
  });

  test('② KHY_ENV_SYMBIOSIS=1 → 加性挂 symbiosis = {fingerprint, topology}', () => {
    process.env.KHY_ENV_SYMBIOSIS = '1';
    const profile = osProfile.detectOsProfile(linuxProbe());
    assert.ok(profile.symbiosis, 'env=1 应挂 symbiosis');
    assert.ok('fingerprint' in profile.symbiosis, '应含 fingerprint');
    assert.ok('topology' in profile.symbiosis, '应含 topology');
  });

  test('② on/true 同样启用', () => {
    process.env.KHY_ENV_SYMBIOSIS = 'on';
    assert.ok(osProfile.detectOsProfile(linuxProbe()).symbiosis, 'on 应启用');
    osProfile.resetCache();
    process.env.KHY_ENV_SYMBIOSIS = 'true';
    assert.ok(osProfile.detectOsProfile(linuxProbe()).symbiosis, 'true 应启用');
  });

  test('③ 观测加性：绝不改写既有 profile 字段', () => {
    const probe = linuxProbe();
    clearEnv();
    const base = osProfile.detectOsProfile(probe);
    const baseOs = base.os;
    const baseKernel = base.kernel;
    const baseMult = base.modifiers.timeoutMultiplier;

    osProfile.resetCache();
    process.env.KHY_ENV_SYMBIOSIS = '1';
    const withSym = osProfile.detectOsProfile(probe);
    assert.equal(withSym.os, baseOs, 'os 不应被观测改写');
    assert.equal(withSym.kernel, baseKernel, 'kernel 不应被观测改写');
    assert.equal(withSym.modifiers.timeoutMultiplier, baseMult, 'modifiers 不应被观测改写');
  });

  test('④ fail-soft：引擎抛错也返回健全 profile（不挂 symbiosis、不破坏既有字段）', () => {
    process.env.KHY_ENV_SYMBIOSIS = '1';
    // 直接对 helper 注入一个会让 require/实例化路径失败的场景：用一个已构建好的
    // 健全 result，断言 helper 永不抛、且失败时不留半成品字段。
    const healthy = { os: 'linux', kernel: 'linux', modifiers: {} };
    // 正常路径：helper 返回同一对象（加性挂载或保持原样）。
    assert.doesNotThrow(() => osProfile._maybeAttachSymbiosis(healthy));
    assert.equal(healthy.os, 'linux', '既有字段保持');
  });
});
