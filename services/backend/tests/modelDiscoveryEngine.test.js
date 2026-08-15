'use strict';

const discovery = require('../src/services/modelDiscoveryEngine');

const ON = { KHY_MODEL_ADAPT: '1', KHY_MODEL_DISCOVERY: '1' };

describe('modelDiscoveryEngine', () => {
  it('门控关闭或模型 id 非法 → 不执行 probe,不写 runtime', async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { pass: true };
    };

    await expect(discovery.discoverModel('new-model', { env: {}, probeRunner: runner })).resolves.toMatchObject({
      enabled: false,
      saved: false,
    });
    await expect(discovery.discoverModel('', { env: ON, probeRunner: runner })).resolves.toMatchObject({
      enabled: false,
      saved: false,
    });
    expect(calls).toBe(0);
  });

  it('按 probe suite 顺序执行,推断能力并只保存临时层', async () => {
    const calls = [];
    const saved = [];
    const registry = {
      saveTemporarily(modelId, features, meta) {
        saved.push({ modelId, features, meta });
        return true;
      },
    };
    const result = await discovery.discoverModel('new-model', {
      env: ON,
      registry,
      probeRunner: async ({ probe }) => {
        calls.push(probe.id);
        return { pass: probe.id !== 'reasoning' };
      },
    });

    expect(calls).toEqual(discovery.DEFAULT_PROBES.map((probe) => probe.id));
    expect(result.enabled).toBe(true);
    expect(result.saved).toBe(true);
    expect(result.persisted).toBe(false);
    expect(saved[0].meta).toMatchObject({ confidence: 'low', source: 'discovery_probe' });
    expect(saved[0].features.confidence).toBe('low');
    expect(saved[0].features.capability_matrix.instruction_following).toBe(5);
    expect(saved[0].features.capability_matrix.reasoning).toBe(0);
    expect(saved[0].features.specialty_areas.strengths).toContain('instruction_following');
    expect(saved[0].features.specialty_areas.weaknesses).toContain('reasoning');
  });

  it('runner 抛错只影响该 probe,整体仍返回并保存', async () => {
    const result = await discovery.discoverModel('new-model', {
      env: ON,
      registry: { saveTemporarily: () => true },
      probes: [{ id: 'code', prompt: 'x' }, { id: 'vision', prompt: 'y' }],
      probeRunner: async ({ probe }) => {
        if (probe.id === 'code') {
          throw new Error('probe failed');
        }
        return { score: 0.9 };
      },
    });

    expect(result.saved).toBe(true);
    expect(result.results[0].error).toBe('probe failed');
    expect(result.features.capability_matrix.code).toBe(0);
    expect(result.features.capability_matrix.vision).toBe(5);
  });

  it('inferFeaturesFromResults 对垃圾输入不抛并保持低置信度', () => {
    expect(() => discovery.inferFeaturesFromResults([null, {}, 'x'])).not.toThrow();
    expect(discovery.inferFeaturesFromResults(null)).toMatchObject({
      confidence: 'low',
      source: 'discovery_probe',
      discovery: { passed: 0, total: 0 },
    });
  });

  it('自描述明确声明运行时临时 persistence', () => {
    expect(discovery.describeDiscovery()).toMatchObject({
      gate: 'KHY_MODEL_DISCOVERY',
      defaultOn: false,
      persistence: 'runtime-only',
      confidence: 'low',
    });
  });
});
