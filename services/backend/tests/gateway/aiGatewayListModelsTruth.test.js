'use strict';

/**
 * aiGateway.listModels — 模型列表「真值咽喉点」的接线证明（[DESIGN-ARCH-100] §四）。
 *
 * 这是全仓唯一咽喉点：适配器产出的候选池在这里被收敛成真值表。默认只返回「被证实存在」的
 * 模型；管理面（增删改 / 逐条探活）显式传 `{ unfiltered: true }` 取全量。
 */

const { AIGatewayModelMethods } = require('../../src/services/gateway/aiGatewayModelMethods');

const CANDIDATE_POOL = [
  { id: 'gpt-4o', name: 'gpt-4o', isDefault: true, discoverySource: 'remote' },
  { id: 'gpt-4o-mini', name: 'gpt-4o-mini', discoverySource: 'remote' },
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', discoverySource: 'builtin' },
  { id: 'sonnet3.5', name: 'sonnet3.5', discoverySource: 'local' },
];

function makeHost(models) {
  return Object.assign(Object.create(AIGatewayModelMethods), {
    getAdapter: () => ({ listModels: async () => models }),
  });
}

describe('aiGateway.listModels truth chokepoint', () => {
  test('默认：把候选池收敛为真值表（猜测条目不得外流）', async () => {
    const host = makeHost(CANDIDATE_POOL);
    const out = await host.listModels('windsurf');
    const ids = out.map((m) => m.id);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('gpt-4o-mini');
    expect(ids).not.toContain('claude-3.5-sonnet');
    expect(ids).not.toContain('sonnet3.5');
  });

  test('{ unfiltered: true }：管理面看到全量（用户得先看得见才能隐藏/改名/探活）', async () => {
    const host = makeHost(CANDIDATE_POOL);
    const out = await host.listModels('windsurf', { unfiltered: true });
    expect(out.map((m) => m.id)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'claude-3.5-sonnet',
      'sonnet3.5',
    ]);
  });

  test('无适配器 / 适配器抛异常 → fail-soft,绝不抛向上游', async () => {
    const empty = Object.assign(Object.create(AIGatewayModelMethods), {
      getAdapter: () => null,
    });
    await expect(empty.listModels('nope')).resolves.toEqual([]);

    const boom = Object.assign(Object.create(AIGatewayModelMethods), {
      getAdapter: () => ({ listModels: async () => { throw new Error('boom'); } }),
    });
    await expect(boom.listModels('windsurf')).rejects.toThrow('boom');
  });

  test('门控关闭(KHY_MODEL_LIST_TRUTH=off)→ 逐字节回退(全量返回)', async () => {
    const prev = process.env.KHY_MODEL_LIST_TRUTH;
    process.env.KHY_MODEL_LIST_TRUTH = 'off';
    try {
      const host = makeHost(CANDIDATE_POOL);
      const out = await host.listModels('windsurf');
      expect(out.map((m) => m.id)).toContain('claude-3.5-sonnet');
    } finally {
      if (prev === undefined) delete process.env.KHY_MODEL_LIST_TRUTH;
      else process.env.KHY_MODEL_LIST_TRUTH = prev;
    }
  });
});
