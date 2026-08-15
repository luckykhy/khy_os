'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeModelFeatureRegistry } = require('../src/services/modelFeatureRegistry');
const pipeline = require('../src/services/perRequestAdaptationPipeline');
const optimizers = require('../src/utils/responseOptimizers');

const ON = { KHY_MODEL_ADAPT: '1' };
let tmpDir = '';
let featuresFile = '';

function registry() {
  return makeModelFeatureRegistry({
    env: {},
    filePath: featuresFile,
    homeFilePath: path.join(tmpDir, 'none.json'),
  });
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prap-'));
  featuresFile = path.join(tmpDir, 'features.json');
  fs.writeFileSync(
    featuresFile,
    JSON.stringify({
      $schemaVersion: 1,
      models: {
        'pipeline-model': {
          style_profile: {
            prompt_preference: 'structured',
            response_style: 'elaborated',
            scaffolding_comfort_level: 6,
          },
          specialty_areas: { strengths: ['code'] },
        },
      },
    }),
    'utf8'
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('门控与阶段契约', () => {
  it('门控关闭 → 原 request 引用与内容逐字不变', () => {
    const request = { modelId: 'pipeline-model', userText: '写代码', env: {} };

    expect(pipeline.adaptRequest(request)).toBe(request);
  });

  it('门控开启 → 按固定顺序执行,并产出 adaptation sidecar', () => {
    const seen = [];
    const names = [
      'modelFeatureFetcher',
      'taskAnalyzer',
      'styleMatcher',
      'promptAssembler',
      'adaptiveScaffoldInjector',
      'gatewayRouter',
      'responseOptimizer',
    ];
    const deps = {};

    for (const name of names) {
      deps[name] = (ctx) => {
        seen.push(name);
        return Object.assign({}, ctx, { [`${name}Ran`]: true });
      };
    }

    const out = pipeline.adaptRequest(
      { modelId: 'pipeline-model', userText: '实现函数', env: ON },
      deps
    );

    expect(seen).toEqual(names);
    expect(out.adaptationMeta.stages).toEqual([
      'ModelFeatureFetcher',
      'TaskAnalyzer',
      'StyleMatcher',
      'PromptAssembler',
      'AdaptiveScaffoldInjector',
      'GatewayRouter',
      'ResponseOptimizer',
    ]);
    expect(out.originalRequest.modelId).toBe('pipeline-model');
  });

  it('单阶段抛错 → 记录 degradedStages,后续阶段仍执行', () => {
    const seen = [];
    const out = pipeline.adaptRequest(
      { modelId: 'pipeline-model', env: ON },
      {
        modelFeatureFetcher: () => {
          throw new Error('fixture failure');
        },
        taskAnalyzer: (ctx) => {
          seen.push('taskAnalyzer');
          return ctx;
        },
      }
    );

    expect(seen).toEqual(['taskAnalyzer']);
    expect(out.adaptationMeta.degradedStages[0]).toMatchObject({
      stage: 'ModelFeatureFetcher',
      error: 'fixture failure',
    });
  });
});

describe('默认阶段', () => {
  it('实时画像参与当前请求,并生成 prompt/scaffold/policy', () => {
    const reg = registry();
    const out = pipeline.adaptRequest(
      {
        modelId: 'pipeline-model',
        taskType: 'code',
        userText: '实现一个函数',
        env: ON,
        registry: reg,
      },
      { registry: reg }
    );

    expect(out.features._meta.known).toBe(true);
    expect(out.adaptation.taskType).toBe('code');
    expect(out.scaffolding.level).toEqual(out.adaptation.scaffoldingLevel);
    expect(out.responsePolicy.responseStyle).toBe('elaborated');
    expect(out.adaptationMeta.degradedStages).toEqual([]);
  });

  it('response optimizer 默认只产 sidecar,显式 applyResponseTextPolicy 才改纯文本', () => {
    const response = { content: '  hello\r\n' };
    const base = pipeline.adaptRequest(
      { modelId: 'pipeline-model', env: ON, response, registry: registry() },
      { registry: registry() }
    );

    expect(base.response).toEqual(response);
    expect(base.optimized).toBe(false);

    const applied = pipeline.adaptRequest(
      {
        modelId: 'pipeline-model',
        env: ON,
        response,
        registry: registry(),
        applyResponseTextPolicy: true,
      },
      { registry: registry() }
    );

    expect(applied.response.content).toBe('hello');
    expect(applied.optimized).toBe(true);
  });
});

describe('responseOptimizers 纯函数', () => {
  it('工具/非文本响应保持原样', () => {
    const tool = { tool_calls: [{ id: 'x' }], content: [{ type: 'tool_use' }] };
    const out = optimizers.optimizeResponse(tool, {}, {}, { applyText: true });

    expect(out.response).toBe(tool);
    expect(out.optimized).toBe(false);
  });

  it('超长文本按显式上限截断,保留 sidecar', () => {
    const out = optimizers.optimizeResponse(
      { text: 'x'.repeat(400) },
      {},
      { maxResponseChars: 10 },
      { applyText: true }
    );

    expect(out.response.text).toContain('[response truncated]');
    expect(out.policy.maxChars).toBe(256); // clamp 下限保护,不接受破坏性极小上限
  });
});
