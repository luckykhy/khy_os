'use strict';

/**
 * 模型画像的纯函数工具集(纯叶子模块)。
 *
 * 契约(与 scripts/ci/check-leaf-contract.js 一致):
 *   - 零 IO:不 require fs/path/net,不读 env,不写日志。
 *   - 确定性:同输入恒同输出,不依赖时间/随机。
 *   - 绝不抛错:任何非法输入都退化为安全值('' / [] / null / false / 原样)。
 *
 * 所有归一化都"宽进严出":配置是人手写的纯文本,写错一个字段不应该让请求失败,
 * 只应该让那个字段回退到默认值。
 */

/** 能力矩阵的 11 个维度,取值 0-5 整数。 */
const CAPABILITY_DIMS = Object.freeze([
  'text',
  'code',
  'reasoning',
  'tool_use',
  'vision',
  'long_context',
  'instruction_following',
  'structured_output',
  'multilingual',
  'speed',
  'cost_efficiency',
]);

const PROMPT_PREFERENCES = Object.freeze(['concise', 'detailed', 'structured']);
const RESPONSE_STYLES = Object.freeze(['direct', 'elaborated', 'explainer']);
const TOOL_TENDENCIES = Object.freeze(['aggressive', 'conservative', 'balanced']);
const CONFIDENCE_LEVELS = Object.freeze(['prior', 'low', 'measured']);

/**
 * section_boost_rules 里 boost/suppress 引用的已知段落 id。
 * 仅供文档与测试参考:**不做校验**,未知 id 被下游忽略而非报错,这样扩展新段落
 * 不需要同步改这里(避免"只有预设段落能用"的写死陷阱)。
 */
const KNOWN_SECTION_IDS = Object.freeze([
  'system_overview',
  'coding_standards',
  'tool_protocol',
  'task_decomposition',
  'self_check',
  'output_format',
  'examples',
  'long_context_navigation',
  'safety_reminders',
  'memory_context',
  'skills_catalog',
]);

/** 合并时取并集去重的数组字段(层层叠加语义)。 */
const UNION_ARRAY_KEYS = new Set([
  'strengths',
  'weaknesses',
  'always_prefer_for',
  'default_choice_for',
]);

/** 合并时追加、按 id 去重(后者覆盖同 id)的数组字段。 */
const ADDITIVE_ARRAY_KEYS = new Set(['section_boost_rules', 'nudge_preferences']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 取整并 clamp 到 [min,max];非法值返回 fallback。
 *
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  const r = Math.round(n);

  if (r < min) {
    return min;
  }

  if (r > max) {
    return max;
  }

  return r;
}

/**
 * 从枚举表里挑值;不在表内(含大小写/空格差异无法修正的情况)返回 fallback。
 *
 * @param {*} value
 * @param {ReadonlyArray<string>} allowed
 * @param {string|null} fallback
 * @returns {string|null}
 */
function pickEnum(value, allowed, fallback) {
  try {
    const v = String(value ?? '')
      .trim()
      .toLowerCase();

    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 归一化能力矩阵:补齐 11 维、clamp 到 0-5、丢弃未知维度。
 *
 * @param {*} raw
 * @param {object} [base] 缺失维度的取值来源
 * @returns {Record<string, number>}
 */
function normalizeCapabilityMatrix(raw, base) {
  const out = {};
  const src = isPlainObject(raw) ? raw : {};
  const fb = isPlainObject(base) ? base : {};

  for (const dim of CAPABILITY_DIMS) {
    const fallback = clampInt(fb[dim], 0, 5, 3);

    out[dim] = dim in src ? clampInt(src[dim], 0, 5, fallback) : fallback;
  }

  return out;
}

/**
 * 归一化风格画像。scaffolding_comfort_level 语义:1-10,**越高表示越需要/越能承受
 * 脚手架**(前沿模型低、弱模型高),与 modelTier.harnessProfile 的方向一致。
 *
 * @param {*} raw
 * @param {object} [base]
 * @returns {{prompt_preference:string,response_style:string,tool_usage_tendency:string,scaffolding_comfort_level:number}}
 */
function normalizeStyleProfile(raw, base) {
  const src = isPlainObject(raw) ? raw : {};
  const fb = isPlainObject(base) ? base : {};

  return {
    prompt_preference: pickEnum(
      src.prompt_preference,
      PROMPT_PREFERENCES,
      pickEnum(fb.prompt_preference, PROMPT_PREFERENCES, 'structured')
    ),
    response_style: pickEnum(
      src.response_style,
      RESPONSE_STYLES,
      pickEnum(fb.response_style, RESPONSE_STYLES, 'direct')
    ),
    tool_usage_tendency: pickEnum(
      src.tool_usage_tendency,
      TOOL_TENDENCIES,
      pickEnum(fb.tool_usage_tendency, TOOL_TENDENCIES, 'balanced')
    ),
    scaffolding_comfort_level: clampInt(
      src.scaffolding_comfort_level,
      1,
      10,
      clampInt(fb.scaffolding_comfort_level, 1, 10, 5)
    ),
  };
}

function normalizeStringList(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set();
  const out = [];

  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }

    const v = item.trim().toLowerCase();

    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }

  return out;
}

/** 规则/nudge 的稳定去重键:优先 id,否则用结构序列化。 */
function ruleKey(item, index) {
  try {
    if (isPlainObject(item) && typeof item.id === 'string' && item.id.trim()) {
      return `id:${item.id.trim()}`;
    }

    return `json:${JSON.stringify(item)}`;
  } catch {
    return `idx:${index}`;
  }
}

function mergeAdditive(baseArr, patchArr) {
  const map = new Map();
  const all = (Array.isArray(baseArr) ? baseArr : []).concat(
    Array.isArray(patchArr) ? patchArr : []
  );

  all.forEach((item, i) => {
    // Map 保留首次插入的位置、更新其值 → base 的顺序 + patch 的内容覆盖。
    map.set(ruleKey(item, i), item);
  });

  return Array.from(map.values());
}

/**
 * 深合并两层画像。patch 为高优先层。
 *
 * 数组语义(见 config/models/features.json 的 _readme):
 *   UNION_ARRAY_KEYS    → 并集去重(strengths/weaknesses/always_prefer_for/default_choice_for)
 *   ADDITIVE_ARRAY_KEYS → 追加并按 id 去重(section_boost_rules/nudge_preferences)
 *   其余数组            → patch 整体替换
 * `undefined` 视为"未指定"跳过;显式 `null` 会写入(用于清空 avoid_when_budget_is)。
 *
 * @param {object} base
 * @param {object} patch
 * @returns {object} 新对象,不修改入参
 */
function mergeProfiles(base, patch) {
  try {
    if (!isPlainObject(patch)) {
      return isPlainObject(base) ? base : {};
    }

    if (!isPlainObject(base)) {
      return JSON.parse(JSON.stringify(patch));
    }

    const out = Object.assign({}, base);

    for (const key of Object.keys(patch)) {
      const pv = patch[key];

      if (pv === undefined || key.startsWith('_')) {
        continue;
      }

      if (Array.isArray(pv)) {
        if (UNION_ARRAY_KEYS.has(key)) {
          out[key] = normalizeStringList(
            (Array.isArray(base[key]) ? base[key] : []).concat(pv)
          );
        } else if (ADDITIVE_ARRAY_KEYS.has(key)) {
          out[key] = mergeAdditive(base[key], pv);
        } else {
          out[key] = pv.slice();
        }
      } else if (isPlainObject(pv)) {
        out[key] = mergeProfiles(base[key], pv);
      } else {
        out[key] = pv;
      }
    }

    return out;
  } catch {
    return isPlainObject(base) ? base : {};
  }
}

/**
 * 专长匹配度:0.2 基线,命中 strengths +0.5,命中 weaknesses -0.3,clamp[0,1]。
 * 未知任务类型 → 只拿基线 0.2,既不奖励也不惩罚(未知模型/未知任务都不会被误杀)。
 *
 * @param {object} profile 已归一化或未归一化的画像
 * @param {string} taskType
 * @returns {number} 0..1
 */
function calculateSpecialtyMatch(profile, taskType) {
  try {
    const t = String(taskType ?? '')
      .trim()
      .toLowerCase();

    let score = 0.2;

    if (!t) {
      return score;
    }

    const areas = isPlainObject(profile) ? profile.specialty_areas : null;
    const strengths = normalizeStringList(isPlainObject(areas) ? areas.strengths : []);
    const weaknesses = normalizeStringList(isPlainObject(areas) ? areas.weaknesses : []);

    if (strengths.includes(t)) {
      score += 0.5;
    }

    if (weaknesses.includes(t)) {
      score -= 0.3;
    }

    return Math.min(1, Math.max(0, score));
  } catch {
    return 0.2;
  }
}

/**
 * 判断一条规则的 `when` 是否命中当前请求上下文。空 `when`(或缺失)恒命中。
 *
 * 支持的条件键:
 *   task_type          string|string[]  任务类型属于其一
 *   tier               string|string[]  T0..T3 属于其一
 *   context_tokens_gt  number           上下文 token 数 >  阈值
 *   context_tokens_lt  number           上下文 token 数 <  阈值
 *   user_preference    string|string[]  用户偏好属于其一
 *   has_tools          boolean          本轮是否带工具
 *   min_capability     {dim:number}     每个维度 >= 阈值
 *   max_capability     {dim:number}     每个维度 <= 阈值
 * 未识别的键被忽略(向前兼容:配置里写了新条件,老代码不会因此把规则误判为命中)。
 *
 * @param {object} when
 * @param {object} ctx
 * @returns {boolean}
 */
function matchWhen(when, ctx) {
  try {
    if (!isPlainObject(when) || Object.keys(when).length === 0) {
      return true;
    }

    const c = isPlainObject(ctx) ? ctx : {};
    const inList = (raw, value) => {
      const list = Array.isArray(raw) ? raw : [raw];
      const v = String(value ?? '')
        .trim()
        .toLowerCase();

      return list.some((x) => String(x ?? '').trim().toLowerCase() === v);
    };

    if (when.task_type !== undefined && !inList(when.task_type, c.taskType)) {
      return false;
    }

    if (when.tier !== undefined && !inList(when.tier, c.tier)) {
      return false;
    }

    if (when.user_preference !== undefined && !inList(when.user_preference, c.userPreference)) {
      return false;
    }

    if (typeof when.has_tools === 'boolean' && Boolean(c.hasTools) !== when.has_tools) {
      return false;
    }

    const tokens = Number.isFinite(c.contextTokens) ? c.contextTokens : 0;

    if (Number.isFinite(when.context_tokens_gt) && !(tokens > when.context_tokens_gt)) {
      return false;
    }

    if (Number.isFinite(when.context_tokens_lt) && !(tokens < when.context_tokens_lt)) {
      return false;
    }

    const caps = isPlainObject(c.capabilities) ? c.capabilities : {};

    if (isPlainObject(when.min_capability)) {
      for (const dim of Object.keys(when.min_capability)) {
        if (clampInt(caps[dim], 0, 5, 0) < clampInt(when.min_capability[dim], 0, 5, 0)) {
          return false;
        }
      }
    }

    if (isPlainObject(when.max_capability)) {
      for (const dim of Object.keys(when.max_capability)) {
        if (clampInt(caps[dim], 0, 5, 5) > clampInt(when.max_capability[dim], 0, 5, 5)) {
          return false;
        }
      }
    }

    return true;
  } catch {
    // 规则解析不了就当不命中:宁可少加一段 prompt,也不要因为配置写错而改变行为。
    return false;
  }
}

/**
 * 风格距离:模型画像与请求侧偏好的不匹配程度,0(完全一致)到 1(完全不合)。
 * 供 Goal 4 的 StyleMatcher 与 Goal 3 的排序做次级判据。
 *
 * @param {object} profile
 * @param {object} prefs {promptPreference,responseStyle,toolUsageTendency,scaffoldingNeed}
 * @returns {number} 0..1
 */
function styleDistance(profile, prefs) {
  try {
    const sp = normalizeStyleProfile(isPlainObject(profile) ? profile.style_profile : null, null);
    const p = isPlainObject(prefs) ? prefs : {};
    let penalty = 0;
    let weight = 0;

    const cmp = (want, got, w) => {
      if (want === undefined || want === null || want === '') {
        return;
      }

      weight += w;

      if (String(want).trim().toLowerCase() !== got) {
        penalty += w;
      }
    };

    cmp(p.promptPreference, sp.prompt_preference, 1);
    cmp(p.responseStyle, sp.response_style, 1);
    cmp(p.toolUsageTendency, sp.tool_usage_tendency, 1);

    if (Number.isFinite(p.scaffoldingNeed)) {
      const need = clampInt(p.scaffoldingNeed, 1, 10, 5);

      weight += 2;
      penalty += (2 * Math.abs(need - sp.scaffolding_comfort_level)) / 9;
    }

    if (weight <= 0) {
      return 0;
    }

    return Math.min(1, Math.max(0, penalty / weight));
  } catch {
    return 0;
  }
}

/**
 * 把任意来源的画像补齐成完整结构。缺什么补什么,永不返回 null。
 *
 * @param {*} raw
 * @returns {object}
 */
function normalizeProfile(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const areas = isPlainObject(src.specialty_areas) ? src.specialty_areas : {};
  const routing = isPlainObject(src.routing_priority) ? src.routing_priority : {};
  const templates = isPlainObject(src.prompt_templates) ? src.prompt_templates : {};
  const overview = isPlainObject(templates.system_overview) ? templates.system_overview : {};
  const params = isPlainObject(src.dynamic_params) ? src.dynamic_params : {};
  const asText = (v) => (typeof v === 'string' ? v : '');

  return {
    confidence: pickEnum(src.confidence, CONFIDENCE_LEVELS, 'prior'),
    source: typeof src.source === 'string' && src.source.trim() ? src.source.trim() : 'default',
    capability_matrix: normalizeCapabilityMatrix(src.capability_matrix, null),
    style_profile: normalizeStyleProfile(src.style_profile, null),
    specialty_areas: {
      strengths: normalizeStringList(areas.strengths),
      weaknesses: normalizeStringList(areas.weaknesses),
    },
    routing_priority: {
      always_prefer_for: normalizeStringList(routing.always_prefer_for),
      default_choice_for: normalizeStringList(routing.default_choice_for),
      avoid_when_budget_is: pickEnum(routing.avoid_when_budget_is, ['low', 'medium', 'high'], null),
    },
    prompt_templates: {
      system_overview: {
        concise_version: asText(overview.concise_version),
        detailed_version: asText(overview.detailed_version),
      },
      section_boost_rules: Array.isArray(templates.section_boost_rules)
        ? templates.section_boost_rules.filter(isPlainObject)
        : [],
      nudge_preferences: Array.isArray(templates.nudge_preferences)
        ? templates.nudge_preferences.filter((n) => isPlainObject(n) || typeof n === 'string')
        : [],
    },
    dynamic_params: {
      preferred_timeout_ms: clampInt(params.preferred_timeout_ms, 1000, 3600000, 120000),
      max_tools_per_turn: clampInt(params.max_tools_per_turn, 1, 64, 6),
      parallel_tool_allowance: clampInt(params.parallel_tool_allowance, 1, 16, 2),
    },
  };
}

module.exports = {
  ADDITIVE_ARRAY_KEYS,
  CAPABILITY_DIMS,
  CONFIDENCE_LEVELS,
  KNOWN_SECTION_IDS,
  PROMPT_PREFERENCES,
  RESPONSE_STYLES,
  TOOL_TENDENCIES,
  UNION_ARRAY_KEYS,
  calculateSpecialtyMatch,
  clampInt,
  isPlainObject,
  matchWhen,
  mergeProfiles,
  normalizeCapabilityMatrix,
  normalizeProfile,
  normalizeStringList,
  normalizeStyleProfile,
  pickEnum,
  styleDistance,
};
