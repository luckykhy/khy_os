'use strict';

/**
 * PerRequestAdaptationPipeline —— 每请求适配的可渐进编排层。
 *
 * 默认关闭时返回原 request 引用,不读取模型画像、不改 prompt、不触碰路由。
 * 开启后按固定顺序执行七个可替换阶段:
 *   ModelFeatureFetcher → TaskAnalyzer → StyleMatcher → PromptAssembler
 *   → AdaptiveScaffoldInjector → GatewayRouter → ResponseOptimizer
 *
 * 每个阶段都是同步函数,失败时保留上一阶段结果并记录 degradedStages;因此它适合
 * 现有同步 promptAssemblyService 热路径,也支持逐阶段替换为真实宿主实现。
 */

const responseOptimizers = require('../utils/responseOptimizers');
const styles = require('../utils/styleMatchers');

const assembler = require('./dynamicPromptAssembler');
const modelFeatureRegistry = require('./modelFeatureRegistry');

const FLAG = 'KHY_MODEL_ADAPT_PIPELINE';

function isEnabled(env = process.env) {
  try {
    return require('./flagRegistry').isFlagEnabled('KHY_MODEL_ADAPT', env || process.env) &&
      require('./flagRegistry').isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

function asObject(value) {
  return styles.isPlainObject(value) ? value : {};
}

function safeRun(name, fn, input, errors) {
  try {
    const output = fn(input);
    return output === undefined ? input : output;
  } catch (error) {
    errors.push({ stage: name, error: error && error.message ? error.message : String(error) });
    return input;
  }
}

function defaultFeatureFetcher(ctx) {
  const registry = ctx.registry && typeof ctx.registry.get === 'function'
    ? ctx.registry
    : modelFeatureRegistry.getModelFeatureRegistry();
  return Object.assign({}, ctx, {
    registry,
    features: registry.get(ctx.modelId, {
      taskType: ctx.taskType,
      tierOpts: Number.isFinite(ctx.contextWindow) ? { contextWindow: ctx.contextWindow } : undefined,
      harnessOpts: Number.isFinite(ctx.contextWindow) ? { contextWindow: ctx.contextWindow } : undefined,
    }),
  });
}

function defaultTaskAnalyzer(ctx) {
  const templates = ctx.templates || assembler.loadTemplates(ctx.env || process.env);
  const task = assembler.analyzeTask(ctx, templates);
  return Object.assign({}, ctx, {
    taskType: task.taskType,
    taskAnalysis: task,
    templates,
  });
}

function defaultStyleMatcher(ctx) {
  const profile = ctx.features || {};
  const prefs = {
    promptPreference: ctx.userPreference,
    responseStyle: ctx.responseStyle,
    toolUsageTendency: ctx.toolUsageTendency,
    scaffoldingNeed: ctx.scaffoldingNeed,
  };

  return Object.assign({}, ctx, {
    styleProfile: profile.style_profile || {},
    styleDistance: styles.styleDistance(profile, prefs),
  });
}

function defaultPromptAssembler(ctx) {
  const assembled = assembler.assemblePromptForModel(ctx);
  return Object.assign({}, ctx, { adaptation: assembled, appendix: assembled.appendix });
}

function defaultScaffoldInjector(ctx) {
  return Object.assign({}, ctx, {
    scaffolding: ctx.adaptation ? {
      level: ctx.adaptation.scaffoldingLevel,
      nudges: ctx.adaptation.tailoredNudges,
      sections: ctx.adaptation.sections,
    } : null,
  });
}

function defaultGatewayRouter(ctx) {
  return Object.assign({}, ctx, { route: ctx.route || null });
}

function defaultResponseOptimizer(ctx) {
  const optimized = responseOptimizers.optimizeResponse(
    ctx.response,
    ctx.features,
    ctx,
    { applyText: ctx.applyResponseTextPolicy === true }
  );

  return Object.assign({}, ctx, {
    response: optimized.response,
    responsePolicy: optimized.policy,
    optimized: optimized.optimized,
  });
}

function adaptRequest(request = {}, opts = {}) {
  const original = request;
  const env = asObject(opts.env || request.env || process.env);

  if (!isEnabled(env)) {
    return original;
  }

  if (!styles.isPlainObject(request)) {
    return original;
  }

  const deps = asObject(opts);
  const errors = [];
  let current = Object.assign({}, request, {
    env,
    registry: request.registry || deps.registry,
  });
  const stages = [
    ['ModelFeatureFetcher', deps.modelFeatureFetcher || defaultFeatureFetcher],
    ['TaskAnalyzer', deps.taskAnalyzer || defaultTaskAnalyzer],
    ['StyleMatcher', deps.styleMatcher || defaultStyleMatcher],
    ['PromptAssembler', deps.promptAssembler || defaultPromptAssembler],
    ['AdaptiveScaffoldInjector', deps.adaptiveScaffoldInjector || defaultScaffoldInjector],
    ['GatewayRouter', deps.gatewayRouter || defaultGatewayRouter],
    ['ResponseOptimizer', deps.responseOptimizer || defaultResponseOptimizer],
  ];

  for (const [name, fn] of stages) {
    current = safeRun(name, fn, current, errors);
  }

  return Object.assign(current, {
    originalRequest: original,
    adaptationMeta: {
      enabled: true,
      stages: stages.map(([name]) => name),
      degradedStages: errors,
    },
  });
}

function createPerRequestAdaptationPipeline(deps = {}) {
  return {
    adaptRequest: (request, opts) => adaptRequest(request, Object.assign({}, deps, opts)),
    isEnabled,
    describe: describePipeline,
  };
}

function describePipeline() {
  return {
    gate: FLAG,
    parentGate: 'KHY_MODEL_ADAPT',
    synchronous: true,
    stages: [
      'ModelFeatureFetcher', 'TaskAnalyzer', 'StyleMatcher', 'PromptAssembler',
      'AdaptiveScaffoldInjector', 'GatewayRouter', 'ResponseOptimizer',
    ],
    flagOffBehavior: 'return original request reference',
  };
}

module.exports = {
  FLAG,
  adaptRequest,
  createPerRequestAdaptationPipeline,
  defaultFeatureFetcher,
  defaultGatewayRouter,
  defaultPromptAssembler,
  defaultResponseOptimizer,
  defaultScaffoldInjector,
  defaultStyleMatcher,
  defaultTaskAnalyzer,
  describePipeline,
  isEnabled,
};
