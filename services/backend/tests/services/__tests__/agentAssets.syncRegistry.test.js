'use strict';

/**
 * agentAssets/sync.js 的注册表解析回归测试。
 *
 * 背景（2026-09-22）：sync.js 曾 `require('../../../../cli/commands/registry')`。
 * 那是 CLI **命令**注册表，导出 getCommandNames / getHandler / registerCommand /
 * getCategories / getCommandMeta / hasHandler / getAllCommands / registerCommand —
 * **没有** resolveAdapter 也**没有** listSourceIds。
 *
 * 于是 sync.js 里三处 `registry.resolveAdapter(...)` / `registry.listSourceIds(...)`
 * 在运行期必然抛 "is not a function"。它藏得住有两个原因：
 *   ① 三处都在普通函数体里（模块加载期不求值），require 本身不会报错；
 *   ② 既有测试只覆盖 assetModel 与 adapters，从没驱动过 discover/plan/transfer
 *      这三条会走到注册表的路径。
 *
 * 真源是**同目录**的 ./registry。本测试锁两件事：
 *   1. sync.js 使用的每个 registry 成员，在它实际 require 的对象上都存在；
 *   2. cli/commands/registry 里**没有**这些成员 —— 一旦有人改回去，第 1 条即红。
 */

const path = require('path');
const fs = require('fs');
const assert = require('node:assert');

const SYNC = '../../../src/services/domain/agents/agentAssets/sync.js';
const SIBLING = '../../../src/services/domain/agents/agentAssets/registry.js';
const CLI_REGISTRY = '../../../src/cli/commands/registry.js';

describe('agentAssets/sync — registry resolution', () => {
  it('sync.js requires the SIBLING registry, not the CLI command registry', () => {
    // 直接读源文件，锁住 require 的**目标路径**。
    // 只断言「兄弟注册表上有这些方法」是空转的：sync.js 换成坏目标后，
    // 兄弟注册表照样有那些方法，测试照样绿。必须断到 sync.js 自己的绑定上。
    const src = fs.readFileSync(path.join(__dirname, SYNC), 'utf-8');
    assert.match(
      src,
      /require\(['"]\.\/registry['"]\)/,
      "sync.js must require './registry' (the sibling adapter registry)"
    );
    assert.doesNotMatch(
      src,
      /require\(['"][^'"]*cli\/commands\/registry['"]\)/,
      'sync.js must NOT require cli/commands/registry — it lacks resolveAdapter'
    );
  });

  it('the sibling registry provides every member sync.js calls', () => {
    const sync = require(SYNC);
    const registry = require(SIBLING);

    assert.equal(typeof registry.resolveAdapter, 'function', 'resolveAdapter must exist');
    assert.equal(typeof registry.listSourceIds, 'function', 'listSourceIds must exist');
    // sync.js 的公开面必须完整导出，否则调用方拿不到编排入口。
    for (const fn of ['importAssets', 'exportAssets', 'syncAssets', 'discover', 'plan', 'transfer']) {
      assert.equal(typeof sync[fn], 'function', `sync.js must export ${fn}`);
    }
  });

  it('BEHAVIOURAL: discover() works end-to-end through the resolved registry', () => {
    // 端到端证明：discover 会真的走到 registry.resolveAdapter / listSourceIds。
    // 用坏目标时这里会抛 "registry.resolveAdapter is not a function"。
    const sync = require(SYNC);
    assert.doesNotThrow(
      () => sync.discover({ from: 'khy-os', kinds: ['memory'] }, { dryRun: true }),
      'discover() must not throw — a wrong registry target throws here'
    );
  });

  it('REGRESSION: cli/commands/registry does NOT provide them (the old wrong target)', () => {
    const cliRegistry = require(CLI_REGISTRY);
    assert.equal(
      typeof cliRegistry.resolveAdapter,
      'undefined',
      'cli/commands/registry must NOT have resolveAdapter — it is the command registry, not the adapter registry'
    );
    assert.equal(
      typeof cliRegistry.listSourceIds,
      'undefined',
      'cli/commands/registry must NOT have listSourceIds'
    );
  });

  it('resolveAdapter actually resolves a known source through the sibling registry', () => {
    const registry = require(SIBLING);
    const ids = registry.listSourceIds({});
    assert.ok(Array.isArray(ids) && ids.length > 0, 'at least one source id is discoverable');
    assert.ok(ids.includes('khy-os'), "the built-in 'khy-os' source must be registered");

    const adapter = registry.resolveAdapter('opencode', {});
    assert.ok(adapter && typeof adapter === 'object', 'a known source resolves to an adapter object');
  });
});
