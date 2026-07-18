'use strict';

const { inferProtocolFromModel } = require('./adapters/_protocolRegistry');

const DEFAULT_PREFIX_TO_ADAPTER = Object.freeze({
  kiro: 'kiro',
  cursor: 'cursor',
  antigravity: 'trae',
  anti_gravity: 'trae',
  'anti-gravity': 'trae',
  nirvana: 'trae',
  claude: 'claude',
  codex: 'codex',
  trae: 'trae',
  warp: 'warp',
  windsurf: 'windsurf',
  vscode: 'vscode',
  local: 'localLLM',
  localllm: 'localLLM',
  local_llm: 'localLLM',
  ollama: 'ollama',
  cursor2api: 'cursor2api',
  c2a: 'cursor2api',
  relay_api: 'relay_api',
  relayapi: 'relay_api',
  relay: 'relay_api',
  api: 'api',
  cloud: 'api',
});

const DEFAULT_ADAPTER_TO_PREFIX = Object.freeze({
  kiro: 'kiro',
  cursor: 'cursor',
  claude: 'claude',
  codex: 'codex',
  trae: 'trae',
  warp: 'warp',
  windsurf: 'windsurf',
  vscode: 'vscode',
  localLLM: 'local',
  ollama: 'ollama',
  cursor2api: 'cursor2api',
  relay_api: 'relay_api',
  api: 'api',
});

const parseBoolean = require('../../utils/parseBoolean');

function normalizeAdapterKey(raw, prefixToAdapter = DEFAULT_PREFIX_TO_ADAPTER) {
  const normalized = String(raw || '').trim();
  if (!normalized) return null;
  const lowered = normalized.toLowerCase();
  if (lowered === 'localllm') return 'localLLM';
  return prefixToAdapter[lowered] || normalized;
}

function parseAdapterScopedModel(model, prefixToAdapter = DEFAULT_PREFIX_TO_ADAPTER) {
  const input = String(model || '').trim();
  if (!input) {
    return {
      adapterKey: null,
      modelId: null,
      explicitAdapter: false,
      syntax: 'none',
    };
  }

  const slash = input.indexOf('/');
  if (slash > 0) {
    const adapterKey = normalizeAdapterKey(input.slice(0, slash), prefixToAdapter);
    if (adapterKey) {
      const modelId = input.slice(slash + 1).trim();
      return {
        adapterKey,
        modelId: modelId || null,
        explicitAdapter: true,
        syntax: 'slash',
      };
    }
  }

  const colon = input.indexOf(':');
  if (colon > 0) {
    const adapterKey = normalizeAdapterKey(input.slice(0, colon), prefixToAdapter);
    if (adapterKey) {
      const modelId = input.slice(colon + 1).trim();
      return {
        adapterKey,
        modelId: modelId || null,
        explicitAdapter: true,
        syntax: 'colon',
      };
    }
  }

  return {
    adapterKey: null,
    modelId: input,
    explicitAdapter: false,
    syntax: 'plain',
  };
}

function parseRouteMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;

  const input = String(raw || '').trim();
  if (!input) return {};

  if ((input.startsWith('{') && input.endsWith('}')) || (input.startsWith('[') && input.endsWith(']'))) {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        const mapped = {};
        for (const row of parsed) {
          if (!row || typeof row !== 'object') continue;
          const pattern = String(row.pattern || row.match || '').trim();
          const target = row.target || row.route || row.to;
          if (!pattern || !target) continue;
          mapped[pattern] = target;
        }
        return mapped;
      }
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return {};
    }
    return {};
  }

  const mapped = {};
  const parts = input.split(/\r?\n|,/g).map(s => s.trim()).filter(Boolean);
  for (const line of parts) {
    const sep = line.includes('=>') ? '=>' : '=';
    const idx = line.indexOf(sep);
    if (idx <= 0) continue;
    const pattern = line.slice(0, idx).trim();
    const target = line.slice(idx + sep.length).trim();
    if (!pattern || !target) continue;
    mapped[pattern] = target;
  }
  return mapped;
}

function normalizeRouteRules(routeMap) {
  const rules = [];
  if (!routeMap || typeof routeMap !== 'object') return rules;

  for (const [rawPattern, value] of Object.entries(routeMap)) {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) continue;

    let target = value;
    let strict = null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target = value.target || value.route || value.to || '';
      if (value.strict !== undefined) strict = !!value.strict;
    }

    const targetText = String(target || '').trim();
    if (!targetText) continue;

    const loweredPattern = pattern.toLowerCase();
    const isPrefix = loweredPattern.endsWith('*');
    rules.push({
      pattern,
      patternLower: loweredPattern,
      matchValue: isPrefix ? loweredPattern.slice(0, -1) : loweredPattern,
      isPrefix,
      target: targetText,
      strict,
    });
  }

  return rules.sort((a, b) => {
    if (a.isPrefix !== b.isPrefix) return a.isPrefix ? 1 : -1;
    return b.matchValue.length - a.matchValue.length;
  });
}

function findRouteRule(model, routeRules) {
  const modelLower = String(model || '').trim().toLowerCase();
  if (!modelLower) return null;

  for (const rule of routeRules) {
    if (!rule) continue;
    if (!rule.isPrefix && rule.matchValue === modelLower) return rule;
    if (rule.isPrefix && rule.matchValue && modelLower.startsWith(rule.matchValue)) return rule;
  }
  return null;
}

// 内置模型路由（pip 安装后无 .env 也能路由到正确 provider）
const BUILTIN_MODEL_ROUTE_MAP = Object.freeze({
  'sensenova-6.7-flash-lite': { target: 'api:sensenova:sensenova-6.7-flash-lite', strict: true },
  'sensenova-u1-fast': { target: 'api:sensenova:sensenova-u1-fast', strict: true },
  'deepseek-v4-flash': { target: 'api:sensenova:deepseek-v4-flash', strict: true },
});

function inferBuiltinFamilyRoute(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower.includes('codex')) return null;
  if (!/^(gpt-|o1-|o3-|o4-)/.test(lower)) return null;
  return {
    pattern: '__openai_gpt_family__',
    target: `api/openai:${normalized}`,
    strict: false,
  };
}

function resolveModelRoute(input = {}) {
  const prefixToAdapter = {
    ...DEFAULT_PREFIX_TO_ADAPTER,
    ...(input.prefixMap || {}),
  };
  const routeMapRaw = input.routeMap !== undefined
    ? input.routeMap
    : (process.env.GATEWAY_MODEL_ROUTE_MAP || process.env.PROXY_MODEL_ROUTE_MAP || '');
  const userRouteMap = parseRouteMap(routeMapRaw);
  // 内置路由兜底，用户配置优先
  const mergedRouteMap = { ...BUILTIN_MODEL_ROUTE_MAP, ...userRouteMap };
  const routeRules = normalizeRouteRules(mergedRouteMap);

  const requestedModel = String(input.model || '').trim();
  const direct = parseAdapterScopedModel(requestedModel, prefixToAdapter);
  let routed = { ...direct };
  let source = direct.explicitAdapter ? 'explicit' : 'direct';
  let matchedRule = null;
  let strictFromRule = null;

  if (!direct.explicitAdapter && direct.modelId) {
    const matched = findRouteRule(direct.modelId, routeRules);
    if (matched) {
      const parsedTarget = parseAdapterScopedModel(matched.target, prefixToAdapter);
      const targetModelId = parsedTarget.modelId || direct.modelId;
      routed = {
        adapterKey: parsedTarget.adapterKey || null,
        modelId: targetModelId || null,
        explicitAdapter: !!parsedTarget.adapterKey,
        syntax: parsedTarget.syntax,
      };
      source = 'route-map';
      matchedRule = matched.pattern;
      strictFromRule = matched.strict;
    } else {
      const builtinFamilyRoute = inferBuiltinFamilyRoute(direct.modelId);
      if (builtinFamilyRoute) {
        const parsedTarget = parseAdapterScopedModel(builtinFamilyRoute.target, prefixToAdapter);
        const targetModelId = parsedTarget.modelId || direct.modelId;
        routed = {
          adapterKey: parsedTarget.adapterKey || null,
          modelId: targetModelId || null,
          explicitAdapter: !!parsedTarget.adapterKey,
          syntax: parsedTarget.syntax,
        };
        source = 'builtin-family';
        matchedRule = builtinFamilyRoute.pattern;
        strictFromRule = builtinFamilyRoute.strict;
      }
    }
  }

  const defaultPreferredAdapterRaw = input.defaultPreferredAdapter !== undefined
    ? input.defaultPreferredAdapter
    : (process.env.PROXY_PRIMARY_ADAPTER || 'localLLM');
  const defaultPreferredAdapter = normalizeAdapterKey(defaultPreferredAdapterRaw, prefixToAdapter);

  let preferredAdapter = null;
  let preferredModel = null;
  let strictPreferred = false;

  if (routed.adapterKey) {
    preferredAdapter = routed.adapterKey;
    preferredModel = routed.modelId || null;
    if (input.strictPreferred !== undefined) {
      strictPreferred = !!input.strictPreferred;
    } else if (strictFromRule !== null) {
      strictPreferred = !!strictFromRule;
    } else if (direct.explicitAdapter) {
      strictPreferred = true;
    } else {
      strictPreferred = parseBoolean(process.env.GATEWAY_MODEL_ROUTE_STRICT, false);
    }
  } else if (defaultPreferredAdapter && defaultPreferredAdapter !== 'auto') {
    preferredAdapter = defaultPreferredAdapter;
    preferredModel = routed.modelId || null;
    strictPreferred = input.strictPreferred !== undefined
      ? !!input.strictPreferred
      : parseBoolean(process.env.PROXY_PRIMARY_STRICT, false);
  }

  // 用户是否「显式钉选」了这个渠道——区别于 env 默认 strict 与 auto 模式。
  // 显式钉选意味着：连续失败后绝不允许擅自级联到用户未选择的其它渠道（如 trae），
  // 只在所选渠道内重试，失败则明确报「该渠道不可用」。这一信号是“不可放宽”的依据，
  // 与 env 默认 strict（仍保留自动放宽/兜底弹性）严格区分。三种显式来源：
  //   1) 模型串写明 `adapter/model` 或 `adapter:model`（direct.explicitAdapter）
  //   2) 命中一条显式 strict 的路由规则（strictFromRule === true）
  //   3) 调用方直接传入 strictPreferred === true 且确实路由到了某个适配器
  const userPinned = !!(
    preferredAdapter &&
    preferredAdapter !== 'auto' &&
    (
      direct.explicitAdapter ||
      (routed.adapterKey && strictFromRule === true) ||
      (routed.adapterKey && input.strictPreferred === true)
    )
  );

  return {
    adapterKey: routed.adapterKey || null,
    modelId: routed.modelId || null,
    preferredAdapter: preferredAdapter || null,
    preferredModel: preferredModel || null,
    strictPreferred: !!strictPreferred,
    userPinned,
    protocolHint: inferProtocolFromModel(routed.modelId || requestedModel) || null,
    metadata: {
      source,
      explicitAdapter: !!direct.explicitAdapter,
      userPinned,
      syntax: routed.syntax || direct.syntax || 'none',
      requestedModel: requestedModel || null,
      matchedRule,
    },
  };
}

module.exports = {
  DEFAULT_PREFIX_TO_ADAPTER,
  DEFAULT_ADAPTER_TO_PREFIX,
  normalizeAdapterKey,
  parseAdapterScopedModel,
  parseRouteMap,
  resolveModelRoute,
};
