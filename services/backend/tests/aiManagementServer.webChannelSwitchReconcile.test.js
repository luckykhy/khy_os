'use strict';

/**
 * webChannelSwitchReconcile.test.js — [EvoRequirement] 非活跃通道僵尸行为（web 路径补强）。
 *
 * 病灶：web/daemon 配置保存路径 applyGatewayConfigPatch 仅写入
 * GATEWAY_PREFERRED_ADAPTER 环境变量，未触发任何 _syncChannelLifecycle，
 * 弃用通道（如 kiro）要等到下一次 30s 后台 tick 才被收回——这段窗口里它的
 * token 文件 watcher 仍活、"Kiro login required" 仍越权冒泡到 UI，正是症状。
 *
 * CLI 路径（ai.js setActiveChannel）本就立即对齐；本测试守护 web 路径已补上
 * 同样的即时对齐：切换 preferredAdapter 时立刻调用 gateway.setActiveChannel。
 *
 * 全程零真实网络：stub gateway 单例的 setActiveChannel，并隔离 .env 写入。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const gateway = require('../src/services/gateway/aiGateway');
const { __test__ } = require('../src/services/aiManagementServer');
const { applyGatewayConfigPatch } = __test__;

const ENV_KEY = 'GATEWAY_PREFERRED_ADAPTER';
const ENV_PATH = path.resolve(__dirname, '../.env');

let _origPref;
let _origEnvContent;
let _origEnvExisted;
let _origSetActiveChannel;
let _calls;

test.beforeEach(() => {
  _origPref = process.env[ENV_KEY];
  _origEnvExisted = fs.existsSync(ENV_PATH);
  _origEnvContent = _origEnvExisted ? fs.readFileSync(ENV_PATH, 'utf-8') : null;
  _calls = [];
  _origSetActiveChannel = gateway.setActiveChannel;
  gateway.setActiveChannel = (key) => { _calls.push(key); };
});

test.afterEach(() => {
  gateway.setActiveChannel = _origSetActiveChannel;
  if (_origPref === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = _origPref;
  // Restore .env exactly as it was (the patch writes to it).
  if (_origEnvExisted) fs.writeFileSync(ENV_PATH, _origEnvContent, 'utf-8');
  else { try { fs.unlinkSync(ENV_PATH); } catch { /* never existed */ } }
});

test('web 切换 preferredAdapter → 立即对齐生命周期（不等后台 tick）', () => {
  applyGatewayConfigPatch({ preferredAdapter: 'relay_api' });
  assert.strictEqual(process.env[ENV_KEY], 'relay_api', '偏好已写入 env');
  assert.deepStrictEqual(_calls, ['relay_api'], 'setActiveChannel 被立即调用一次，弃用通道当场收回');
});

test('清空 preferredAdapter（回到 auto）也对齐生命周期', () => {
  process.env[ENV_KEY] = 'kiro';
  applyGatewayConfigPatch({ preferredAdapter: '' });
  // unset 后 env 被删除；以空串调用 setActiveChannel → auto 模式，不误杀任何通道。
  assert.deepStrictEqual(_calls, [''], 'setActiveChannel 以空串调用，回到 auto 全活跃');
});

test('未改 preferredAdapter 的配置保存不触发通道对齐（不误动）', () => {
  applyGatewayConfigPatch({ effort: 'high', ollamaHost: 'http://127.0.0.1:11434' });
  assert.deepStrictEqual(_calls, [], '与通道无关的配置变更不应触碰生命周期');
});

test('setActiveChannel 抛错不影响配置保存（fail-safe，硬约束）', () => {
  gateway.setActiveChannel = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => applyGatewayConfigPatch({ preferredAdapter: 'relay_api' }));
  assert.strictEqual(process.env[ENV_KEY], 'relay_api', '即便对齐失败，配置仍正常落盘');
});
