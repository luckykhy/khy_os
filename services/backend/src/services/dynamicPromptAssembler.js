'use strict';

/**
 * dynamicPromptAssembler —— 每请求按「当前模型画像 + 本次任务特征」现场拼提示词。
 *
 * 与既有 promptAssemblyService 的关系(重要):
 *   promptAssemblyService 把系统提示切成「稳定前缀(跨轮字节相同 → 命中 provider 缓存)」
 *   和「动态上下文(每轮必变)」两段。本模块产出的内容**只**接到**动态上下文**那一段,
 *   绝不写进稳定前缀 —— 因为它随模型和任务变化,塞进前缀会让每次换模型/换任务都击穿
 *   provider 的 prompt cache,省下的 token 远抵不上多付的钱。动态段本来就是必然 miss 的,
 *   在那里追加是零缓存代价的。
 *
 * 六步(与任务书 Goal 2 的步骤一一对应,meta.steps 里能看到每步的产出):
 *   1. fetchFeatures        —— 从 modelFeatureRegistry 取当前模型的完整画像(每请求实时读)
 *   2. analyzeTask          —— 归一任务类型/上下文长度/是否带工具;没传 taskType 时按关键词推断
 *   3. selectSections       —— 按 when 条件从段落目录里挑候选
 *   4. applyBoostRules      —— 应用画像里的 section_boost_rules(boost 强制留 / suppress 砍掉)
 *   5. generateTailoredNudges —— 按 nudge_preferences + 工具倾向生成本轮的即时提醒
 *   6. calibrateScaffolding —— 算出脚手架强度,据此裁剪段落数量、选定文案变体、调工具并发
 *
 * 契约:
 *   - 门控 KHY_DYNAMIC_PROMPT(父门 KHY_MODEL_ADAPT,默认关)。关闭时返回 inert 结果
 *     (sections=[] / appendix='') → 调用方拼出的提示词与改动前**逐字节相同**。
 *   - 绝不抛:任何异常都降级成 inert 结果并在 meta.degraded 里说明原因。
 *   - 同步:promptAssemblyService 整条链路是同步的,这里也必须同步,否则没法接进热路径。
 */

const fs = require('fs');
const path = require('path');

const styles = require('../utils/styleMatchers');

const modelFeatureRegistry = require('./modelFeatureRegistry');
const modelTier = require('./modelTier');

const FLAG = 'KHY_DYNAMIC_PROMPT';
const TEMPLATES_ENV = 'KHY_STYLE_TEMPLATES_FILE';
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TEMPLATES_PATH = path.join(BACKEND_ROOT, 'config', 'models', 'style_templates.js');

/** 与 modelFeatureRegistry 同一套理由:mtime 太新说明文件可能正在被编辑,别信 stat 闸门。 */
const MTIME_TRUST_MS = 2000;

/** 脚手架等级 → 最多注入几段。等级低的模型给少量、等级高的给全套。 */
const SECTION_BUDGET = [3, 3, 3, 4, 5, 5, 6, 7, 8, 8, 8];

/** 本轮 nudge 条数上限(每条都要花钱)。 */
const MAX_NUDGES = 4;

function isEnabled(env = process.env) {
  try {
    return require('./flagRegistry').isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

// ── 模板热加载 ───────────────────────────────────────────────────────────────
// style_templates.js 是普通 CommonJS 模块。这里**不**用 require 加载它,而是自己读文本 +
// 在一个受限的 CommonJS 壳里求值。原因有两个,都是实测出来的:
//   1. require 会进模块缓存,要热更新就得 delete require.cache[...] —— 而 Jest 用的是它
//      自己的模块注册表,那个 delete 是空操作,于是"存盘即生效"在测试里根本测不出来
//      (也就意味着谁也不知道它在生产里到底还灵不灵)。自己读文本则两边行为完全一致。
//   2. 顺带能做**逐字节比对**:同长度编辑落在同一时间戳刻度里也不会漏(与
//      modelFeatureRegistry 用的是同一套判据)。
// 求值时传进去的 require 是会抛错的假货 —— 配置文件按文档约定只允许写字面量。
// 信任边界与 require 无异:这个文件本来就是仓库内、运维自己写的配置。

let _builtinTemplates = {
  SECTION_CATALOG: [],
  DEFAULT_NUDGES: {},
  HIGH_SCAFFOLD_NUDGES: [],
  TASK_KEYWORDS: {},
};

try {
  _builtinTemplates = require('../../config/models/style_templates');
} catch {
  /* 目录被裁掉也能跑:段落目录为空 → 只出 nudge,不出 section */
}

const _slot = {
  filePath: '',
  mtimeMs: -1,
  size: -1,
  raw: '',
  mod: null,
  error: null,
  loads: 0,
  statCalls: 0,
  reads: 0,
};

function _templatesPath(env) {
  const e = env && typeof env === 'object' ? env : process.env;
  const raw = e && typeof e[TEMPLATES_ENV] === 'string' ? e[TEMPLATES_ENV].trim() : '';

  return raw || DEFAULT_TEMPLATES_PATH;
}

/**
 * 在受限 CommonJS 壳里求值模板源码。
 *
 * @param {string} src
 * @param {string} filePath
 * @returns {object}
 */
function _evalTemplates(src, filePath) {
   const shim = { exports: {} };
   const forbidden = () => {
     throw new Error('style_templates 里不允许 require:只写字面量');
   };
   
   // 安全修复：使用 vm 模块替代 new Function()，防止代码注入
   // 创建隔离的上下文，禁止访问 Node.js 内置模块
   const vm = require('vm');
   const context = vm.createContext({
     module: shim,
     exports: shim.exports,
     require: forbidden,
     __filename: filePath,
     console: console, // 允许 console 用于调试
     // 禁止访问其他全局对象
   });
   
   vm.runInContext(src, context, { filename: filePath });

   return shim.exports;
 }

/**
 * 取当前生效的模板模块。文件变了就重新求值;读坏了沿用上一份好数据。
 *
 * @param {object} [env]
 * @param {() => number} [now]
 * @returns {{SECTION_CATALOG:Array, DEFAULT_NUDGES:object, HIGH_SCAFFOLD_NUDGES:Array, TASK_KEYWORDS:object}}
 */
function loadTemplates(env, now) {
  const filePath = _templatesPath(env);
  const clock = typeof now === 'function' ? now : Date.now;

  try {
    if (_slot.filePath !== filePath) {
      _slot.filePath = filePath;
      _slot.mtimeMs = -1;
      _slot.size = -1;
      _slot.raw = '';
      _slot.mod = null;
      _slot.error = null;
    }

    _slot.statCalls += 1;

    const st = fs.statSync(filePath);
    const cooled = clock() - st.mtimeMs > MTIME_TRUST_MS;

    // 稳定态快路径:戳没变 **且** 文件已经放凉了 → 确定没变,不读盘。
    if (_slot.mod && st.mtimeMs === _slot.mtimeMs && st.size === _slot.size && cooled) {
      return _slot.mod;
    }

    _slot.reads += 1;

    const src = fs.readFileSync(filePath, 'utf8');

    _slot.mtimeMs = st.mtimeMs;
    _slot.size = st.size;

    // 原文逐字节相同 → 真的没变(哪怕 mtime 被 touch 过)。
    if (_slot.mod && src === _slot.raw) {
      return _slot.mod;
    }

    const mod = _evalTemplates(src, filePath);

    if (!styles.isPlainObject(mod) || !Array.isArray(mod.SECTION_CATALOG)) {
      throw new Error('style_templates 缺少 SECTION_CATALOG 数组');
    }

    _slot.mod = mod;
    _slot.raw = src;
    _slot.error = null;
    _slot.loads += 1;

    return mod;
  } catch (e) {
    // 不更新 _slot.raw —— 这样改回合法源码后能立刻被认成"变了"。
    _slot.error = String((e && e.message) || e);

    return _slot.mod || _builtinTemplates;
  }
}

// ── 步骤 2:任务分析 ─────────────────────────────────────────────────────────

/**
 * 从用户文本推断任务类型(仅在调用方没显式传 taskType 时使用)。
 * 关键词表在 config/models/style_templates.js 的 TASK_KEYWORDS 里,加类型不用改代码。
 *
 * @param {string} text
 * @param {object} keywords
 * @returns {string} 推断不出来时返回 ''
 */
function inferTaskType(text, keywords) {
  try {
    const s = String(text || '')
      .toLowerCase()
      .slice(0, 4000);

    if (!s) {
      return '';
    }

    const table = styles.isPlainObject(keywords) ? keywords : {};
    let best = '';
    let bestScore = 0;

    for (const type of Object.keys(table)) {
      const words = Array.isArray(table[type]) ? table[type] : [];
      let score = 0;

      for (const w of words) {
        if (typeof w === 'string' && w && s.includes(w.toLowerCase())) {
          score += 1;
        }
      }

      if (score > bestScore) {
        best = type;
        bestScore = score;
      }
    }

    return bestScore > 0 ? best : '';
  } catch {
    return '';
  }
}

/**
 * 归一本次请求的任务特征。
 *
 * @param {object} requestContext
 * @param {object} templates
 * @returns {{taskType:string, inferredTaskType:boolean, contextTokens:number, hasTools:boolean,
 *   userPreference:string, longContext:boolean}}
 */
function analyzeTask(requestContext, templates) {
  const rc = styles.isPlainObject(requestContext) ? requestContext : {};
  const explicit = String(rc.taskType || '')
    .trim()
    .toLowerCase();
  const inferred = explicit ? '' : inferTaskType(rc.userText, templates && templates.TASK_KEYWORDS);
  const tokens = Number.isFinite(rc.contextTokens) ? Math.max(0, Math.round(rc.contextTokens)) : 0;

  return {
    taskType: explicit || inferred || 'conversation',
    inferredTaskType: !explicit && Boolean(inferred),
    contextTokens: tokens,
    hasTools: rc.hasTools === undefined ? true : Boolean(rc.hasTools),
    userPreference: styles.pickEnum(rc.userPreference, styles.PROMPT_PREFERENCES, ''),
    longContext: tokens > 16000,
  };
}

// ── 步骤 3:候选段落 ─────────────────────────────────────────────────────────

/**
 * 按 when 条件挑候选段落。稳定前缀已经提供过的段落默认跳过(避免重复烧 token)。
 *
 * @param {Array} catalog
 * @param {object} matchCtx
 * @returns {Array<object>} 候选(浅拷贝,带 forced/dropped/reason 三个可变标记)
 */
function selectSections(catalog, matchCtx) {
  const out = [];
  const list = Array.isArray(catalog) ? catalog : [];

  for (const def of list) {
    if (!styles.isPlainObject(def) || typeof def.id !== 'string' || !def.id.trim()) {
      continue;
    }

    if (!styles.matchWhen(def.when, matchCtx)) {
      continue;
    }

    out.push({
      id: def.id.trim(),
      title: typeof def.title === 'string' ? def.title : def.id,
      priority: styles.clampInt(def.priority, 0, 1000, 50),
      minScaffolding: styles.clampInt(def.minScaffolding, 0, 10, 0),
      variants: styles.isPlainObject(def.variants) ? def.variants : {},
      forced: false,
      dropped: Boolean(def.providedByStablePrefix),
      reason: def.providedByStablePrefix ? 'in-stable-prefix' : 'when-matched',
    });
  }

  return out;
}

// ── 步骤 4:boost / suppress ────────────────────────────────────────────────

/**
 * 应用画像里的 section_boost_rules。规则形状:
 *   { id?, when?, boost?: ['tool_protocol'], suppress?: ['examples'], priority_delta?: 10 }
 * boost 会强制保留(无视 minScaffolding),suppress 直接砍掉。boost 与 suppress 同时命中
 * 同一段落时 **suppress 胜** —— 明确要求关掉的意图优先于"加强"。
 *
 * @param {Array} candidates 会被就地修改
 * @param {object} profile
 * @param {object} matchCtx
 * @returns {{boosted:string[], suppressed:string[], rulesApplied:number}}
 */
function applyBoostRules(candidates, profile, matchCtx) {
  const boosted = [];
  const suppressed = [];
  let rulesApplied = 0;

  try {
    const templates = styles.isPlainObject(profile) ? profile.prompt_templates : null;
    const rules = styles.isPlainObject(templates) && Array.isArray(templates.section_boost_rules)
      ? templates.section_boost_rules
      : [];
    const byId = new Map(candidates.map((c) => [c.id, c]));

    for (const rule of rules) {
      if (!styles.isPlainObject(rule) || !styles.matchWhen(rule.when, matchCtx)) {
        continue;
      }

      rulesApplied += 1;

      const delta = styles.clampInt(rule.priority_delta, -1000, 1000, 0);

      for (const id of styles.normalizeStringList(rule.boost)) {
        const c = byId.get(id);

        if (c) {
          c.forced = true;
          c.dropped = false;
          c.reason = `boost:${rule.id || 'rule'}`;
          c.priority = styles.clampInt(c.priority + (delta || 5), 0, 1000, c.priority);
          boosted.push(id);
        }
      }

      for (const id of styles.normalizeStringList(rule.suppress)) {
        const c = byId.get(id);

        if (c) {
          c.forced = false;
          c.dropped = true;
          c.reason = `suppress:${rule.id || 'rule'}`;
          suppressed.push(id);
        }
      }
    }
  } catch {
    /* 规则写坏就当没写:段落集合退回 when 过滤后的原样 */
  }

  return {
    boosted: Array.from(new Set(boosted)),
    suppressed: Array.from(new Set(suppressed)),
    rulesApplied,
  };
}

// ── 步骤 5:即时提醒 ─────────────────────────────────────────────────────────

/**
 * 生成本轮 nudge。画像里的 nudge_preferences 优先(支持 {id,text,when} 或裸字符串),
 * 一条都没命中时按 tool_usage_tendency 落到默认表。脚手架等级 >= 8 追加验证提醒。
 *
 * @param {object} profile
 * @param {object} matchCtx
 * @param {number} scaffoldingLevel
 * @param {object} templates
 * @returns {string[]} 最多 MAX_NUDGES 条,去重
 */
function generateTailoredNudges(profile, matchCtx, scaffoldingLevel, templates) {
  const out = [];
  const push = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';

    if (s && !out.includes(s)) {
      out.push(s);
    }
  };

  try {
    const tpl = styles.isPlainObject(profile) ? profile.prompt_templates : null;
    const prefs = styles.isPlainObject(tpl) && Array.isArray(tpl.nudge_preferences)
      ? tpl.nudge_preferences
      : [];

    for (const item of prefs) {
      if (typeof item === 'string') {
        push(item);
      } else if (styles.isPlainObject(item) && styles.matchWhen(item.when, matchCtx)) {
        push(item.text);
      }
    }

    const t = styles.isPlainObject(templates) ? templates : {};

    if (out.length === 0) {
      const tendency = styles.isPlainObject(profile) && styles.isPlainObject(profile.style_profile)
        ? profile.style_profile.tool_usage_tendency
        : 'balanced';
      const table = styles.isPlainObject(t.DEFAULT_NUDGES) ? t.DEFAULT_NUDGES : {};
      const list = Array.isArray(table[tendency]) ? table[tendency] : [];

      list.forEach(push);
    }

    if (scaffoldingLevel >= 8 && Array.isArray(t.HIGH_SCAFFOLD_NUDGES)) {
      t.HIGH_SCAFFOLD_NUDGES.forEach(push);
    }
  } catch {
    /* 降级为空数组:不加提醒总比加错提醒安全 */
  }

  return out.slice(0, MAX_NUDGES);
}

// ── 步骤 6:脚手架标定 ───────────────────────────────────────────────────────

/**
 * 算出本次请求的脚手架强度(0-10,越高越啰嗦越手把手)。
 *
 * 基线是画像里的 scaffolding_comfort_level,再按本轮实际情况调:
 *   promptVerbosity=lean(T0)  −3   前沿模型自己会规划,给多了反而添乱
 *   shortContext(窗口 ≤32k)   −2   静态提示必须瘦身,否则 8k 窗口被吃光
 *   长上下文(>16k tokens)     +1   需要导航帮助
 *   任务命中模型强项           −1   它擅长,少啰嗦
 *   任务命中模型弱项           +2   它不擅长,多兜着
 *   用户偏好 concise           −2   / detailed +1(用户意图压过默认)
 *
 * @param {object} profile
 * @param {object} task
 * @param {object} harness
 * @returns {{level:number, adjustments:Array<{by:string,delta:number}>}}
 */
function calibrateScaffolding(profile, task, harness) {
  const adjustments = [];
  const sp = styles.isPlainObject(profile) ? profile.style_profile : null;
  let level = styles.clampInt(sp && sp.scaffolding_comfort_level, 0, 10, 5);
  const bump = (by, delta) => {
    if (delta) {
      level += delta;
      adjustments.push({ by, delta });
    }
  };

  const h = styles.isPlainObject(harness) ? harness : {};

  bump('promptVerbosity:lean', h.promptVerbosity === 'lean' ? -3 : 0);
  bump('shortContext', h.shortContext ? -2 : 0);
  bump('longContext', task && task.longContext ? 1 : 0);

  const areas = styles.isPlainObject(profile) ? profile.specialty_areas : null;
  const strengths = styles.normalizeStringList(areas && areas.strengths);
  const weaknesses = styles.normalizeStringList(areas && areas.weaknesses);
  const t = task && task.taskType ? task.taskType : '';

  bump('taskInStrengths', strengths.includes(t) ? -1 : 0);
  bump('taskInWeaknesses', weaknesses.includes(t) ? 2 : 0);
  bump('userPreference:concise', task && task.userPreference === 'concise' ? -2 : 0);
  bump('userPreference:detailed', task && task.userPreference === 'detailed' ? 1 : 0);

  return { level: Math.min(10, Math.max(0, level)), adjustments };
}

// ── 变体选择与渲染 ──────────────────────────────────────────────────────────

function _pickVariant(section, preference, profile) {
  const variants = styles.isPlainObject(section.variants) ? section.variants : {};

  // system_overview 允许模型画像直接提供成品文案(任务书 Goal 1 的 prompt_templates)。
  if (section.id === 'system_overview') {
    const tpl = styles.isPlainObject(profile) ? profile.prompt_templates : null;
    const ov = styles.isPlainObject(tpl) && styles.isPlainObject(tpl.system_overview)
      ? tpl.system_overview
      : {};
    const custom = preference === 'concise' ? ov.concise_version : ov.detailed_version;

    if (typeof custom === 'string' && custom.trim()) {
      return custom.trim();
    }
  }

  const order = preference === 'concise'
    ? ['concise', 'structured', 'detailed']
    : preference === 'detailed'
      ? ['detailed', 'structured', 'concise']
      : ['structured', 'detailed', 'concise'];

  for (const key of order) {
    if (typeof variants[key] === 'string' && variants[key].trim()) {
      return variants[key].trim();
    }
  }

  return '';
}

/**
 * 把装配结果渲染成一段可直接追加到**动态上下文**里的纯文本。
 * 没有任何段落和提醒时返回 ''(调用方拼接后与改动前逐字节相同)。
 *
 * @param {object} result assemblePromptForModel 的返回值
 * @returns {string}
 */
function renderAppendix(result) {
  try {
    const r = styles.isPlainObject(result) ? result : {};
    const sections = Array.isArray(r.sections) ? r.sections : [];
    const nudges = Array.isArray(r.tailoredNudges) ? r.tailoredNudges : [];
    const parts = [];

    for (const s of sections) {
      if (s && typeof s.body === 'string' && s.body.trim()) {
        parts.push(`## ${s.title || s.id}\n${s.body.trim()}`);
      }
    }

    if (nudges.length > 0) {
      parts.push(`## 本轮提醒\n${nudges.map((n) => `- ${n}`).join('\n')}`);
    }

    if (parts.length === 0) {
      return '';
    }

    return `# 模型适配提示\n${parts.join('\n\n')}`;
  } catch {
    return '';
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

function _inert(reason, modelId) {
  return {
    modelId: typeof modelId === 'string' ? modelId : '',
    tier: '',
    taskType: '',
    sections: [],
    scaffoldingLevel: null,
    tailoredNudges: [],
    dynamicParams: null,
    appendix: '',
    meta: { enabled: false, degraded: reason, steps: [] },
  };
}

/**
 * 每请求装配一次。
 *
 * @param {{modelId?:string, taskType?:string, userText?:string, contextTokens?:number,
 *   contextWindow?:number, hasTools?:boolean, userPreference?:string, env?:object,
 *   registry?:object, now?:Function}} requestContext
 * @returns {{modelId:string, tier:string, taskType:string,
 *   sections:Array<{id:string,title:string,body:string,priority:number,reason:string}>,
 *   scaffoldingLevel:(number|null), tailoredNudges:string[],
 *   dynamicParams:(object|null), appendix:string, meta:object}}
 */
function assemblePromptForModel(requestContext = {}) {
  const rc = styles.isPlainObject(requestContext) ? requestContext : {};
  const env = styles.isPlainObject(rc.env) ? rc.env : process.env;
  const modelId = typeof rc.modelId === 'string' ? rc.modelId : '';

  if (!isEnabled(env)) {
    return _inert('flag-off', modelId);
  }

  try {
    const steps = [];

    // 1. 取画像(每请求实时读配置文件,存盘即生效)
    // 单例读进程 env;要注入自定义 env 就把 registry 一起传进来(测试与多租户场景)。
    const registry = rc.registry && typeof rc.registry.get === 'function'
      ? rc.registry
      : modelFeatureRegistry.getModelFeatureRegistry();
    const profile = registry.get(modelId, {
      taskType: typeof rc.taskType === 'string' ? rc.taskType : '',
      // contextWindow 同时传给 tierOpts 和 harnessOpts:harnessOpts 是它真正的消费方
      // (shortContext 推断),tierOpts 则是 registry 解析缓存 key 的组成部分 —— 不带上它,
      // 换了上下文窗口会错误命中上一份缓存。resolveTier 忽略不认识的键,传了无害。
      tierOpts: Number.isFinite(rc.contextWindow) ? { contextWindow: rc.contextWindow } : undefined,
      harnessOpts: Number.isFinite(rc.contextWindow)
        ? { contextWindow: rc.contextWindow }
        : undefined,
    });

    steps.push({ step: 'fetchFeatures', layers: (profile._meta && profile._meta.layers) || [] });

    const templates = loadTemplates(env, rc.now);

    // 2. 分析任务
    const task = analyzeTask(rc, templates);

    steps.push({ step: 'analyzeTask', taskType: task.taskType, inferred: task.inferredTaskType });

    const tier = (profile._meta && profile._meta.tier) || 'T2';
    let harness = {};

    try {
      harness = modelTier.harnessProfile(tier, { contextWindow: rc.contextWindow });
    } catch {
      harness = {};
    }

    const matchCtx = {
      taskType: task.taskType,
      tier,
      contextTokens: task.contextTokens,
      userPreference: task.userPreference,
      hasTools: task.hasTools,
      capabilities: profile.capability_matrix,
    };

    // 3. 挑候选段落
    const candidates = selectSections(templates.SECTION_CATALOG, matchCtx);

    steps.push({ step: 'selectSections', candidates: candidates.length });

    // 4. boost / suppress
    const ruleOutcome = applyBoostRules(candidates, profile, matchCtx);

    steps.push(Object.assign({ step: 'applyBoostRules' }, ruleOutcome));

    // 6'. 先算强度(第 5、6 步都要用),再按强度裁剪
    const calibration = calibrateScaffolding(profile, task, harness);
    const level = calibration.level;

    // 5. 即时提醒
    const tailoredNudges = harness.nudges === false
      ? []
      : generateTailoredNudges(profile, matchCtx, level, templates);

    steps.push({ step: 'generateTailoredNudges', count: tailoredNudges.length });

    const preference = task.userPreference
      || (profile.style_profile && profile.style_profile.prompt_preference)
      || 'structured';
    const budget = SECTION_BUDGET[level] || 5;
    const kept = candidates
      .filter((c) => !c.dropped && (c.forced || c.minScaffolding <= level))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const sections = [];

    for (const c of kept) {
      if (sections.length >= budget && !c.forced) {
        continue;
      }

      const body = _pickVariant(c, preference, profile);

      if (!body) {
        continue;
      }

      sections.push({
        id: c.id,
        title: c.title,
        body,
        priority: c.priority,
        reason: c.reason,
      });
    }

    steps.push({
      step: 'calibrateScaffolding',
      level,
      budget,
      kept: sections.length,
      adjustments: calibration.adjustments,
    });

    // 工具调用频率:长上下文时收紧并发(工具结果本身也占窗口);保守倾向恒为 1。
    const base = profile.dynamic_params;
    const tendency = (profile.style_profile && profile.style_profile.tool_usage_tendency) || 'balanced';
    let parallel = base.parallel_tool_allowance;

    if (tendency === 'conservative') {
      parallel = 1;
    } else if (task.longContext) {
      parallel = Math.max(1, Math.min(parallel, 2));
    }

    const result = {
      modelId: (profile._meta && profile._meta.modelId) || modelId,
      tier,
      taskType: task.taskType,
      sections,
      scaffoldingLevel: level,
      tailoredNudges,
      dynamicParams: {
        preferred_timeout_ms: base.preferred_timeout_ms,
        max_tools_per_turn: base.max_tools_per_turn,
        parallel_tool_allowance: parallel,
      },
      appendix: '',
      meta: {
        enabled: true,
        degraded: null,
        promptPreference: preference,
        responseStyle: profile.style_profile.response_style,
        toolUsageTendency: tendency,
        confidence: profile.confidence,
        known: Boolean(profile._meta && profile._meta.known),
        generation: (profile._meta && profile._meta.generation) || 0,
        templatesPath: _slot.filePath,
        templatesError: _slot.error,
        steps,
      },
    };

    result.appendix = renderAppendix(result);

    return result;
  } catch (e) {
    return _inert(`error:${String((e && e.message) || e)}`, modelId);
  }
}

/** 人可读摘要,给 CLI / 监控 / 排障用。绝不抛。 */
function describeAssembly(requestContext = {}) {
  try {
    const r = assemblePromptForModel(requestContext);

    if (!r.meta.enabled) {
      return `dynamicPromptAssembler: 未启用 (${r.meta.degraded})`;
    }

    return [
      `model=${r.modelId || '(unknown)'}`,
      `tier=${r.tier}`,
      `task=${r.taskType}`,
      `style=${r.meta.promptPreference}`,
      `scaffold=${r.scaffoldingLevel}`,
      `sections=${r.sections.map((s) => s.id).join(',') || '(none)'}`,
      `nudges=${r.tailoredNudges.length}`,
      `tools<=${r.dynamicParams.max_tools_per_turn}/par=${r.dynamicParams.parallel_tool_allowance}`,
      `chars=${r.appendix.length}`,
    ].join(' ');
  } catch {
    return '';
  }
}

/** 模板加载状态(监控用)。 */
function getTemplatesStatus() {
  return {
    filePath: _slot.filePath || DEFAULT_TEMPLATES_PATH,
    loads: _slot.loads,
    reads: _slot.reads,
    statCalls: _slot.statCalls,
    error: _slot.error,
    sections: (_slot.mod && Array.isArray(_slot.mod.SECTION_CATALOG)
      ? _slot.mod.SECTION_CATALOG.length
      : 0),
  };
}

module.exports = {
  DEFAULT_TEMPLATES_PATH,
  FLAG,
  MAX_NUDGES,
  SECTION_BUDGET,
  analyzeTask,
  applyBoostRules,
  assemblePromptForModel,
  calibrateScaffolding,
  describeAssembly,
  generateTailoredNudges,
  getTemplatesStatus,
  inferTaskType,
  isEnabled,
  loadTemplates,
  renderAppendix,
  selectSections,
};
