'use strict';

/**
 * 模型差异化画像注册表(Goal 1)。
 *
 * 设计目标(按优先级):
 *   1. 零构建 —— 纯 CommonJS + JSON.parse,无编译、无打包、无新增生产依赖。
 *      (仓库未安装 yaml / zod / yup;ajv 只是 devDep,运行时不可用,所以配置用 JSON
 *       并手写校验,依赖增量为 0,同时满足"小体积"红线。)
 *   2. 实时可修改 —— 编辑配置文件保存后,**下一次 get() 即生效**,不需要重启。
 *      默认 TTL=0:每次解析先 statSync 比对 mtime+size,变了才重读重解析。
 *      两次 statSync 约数十微秒,相对一次 LLM 网络往返可忽略;高 QPS 场景可把
 *      KHY_MODEL_FEATURES_TTL_MS 调大以缓存。
 *   3. 不依赖静态预设 —— get() 对任意 modelId 都返回**完整画像**,永不返回 null、
 *      永不抛错。未登记的模型走 modelTier.resolveTier + harnessProfile 推断兜底。
 *
 * 分层解析(高 → 低,逐层深合并):
 *   1. env KHY_MODEL_FEATURES_JSON        内联 JSON
 *   2. saveTemporarily() 内存运行时覆盖    A/B 探测草稿 / 人工标注
 *   3. <appHome>/model_features.json       运维覆盖(升级不丢)
 *   4. config/models/features.json 的 models[<id>]
 *   5. 同文件 patterns[](按声明顺序,**所有**命中的规则依次合并)
 *   6. 同文件 tierDefaults[tier]
 *   7. modelTier.resolveTier + harnessProfile 推断的兜底(未登记模型也拿到完整画像)
 *   8. 同文件 defaults
 * 第 7 层排在 tierDefaults 之下:人写在配置里的永远压过代码推断出来的。
 *
 * 本模块**不**自行判断功能开关:isEnabled() 导出给调用方,由调用方在关门时逐字节
 * 回退到原有行为。注册表本身只是一次只读查表,加载它没有副作用。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const styles = require('../utils/styleMatchers');

const MASTER_FLAG = 'KHY_MODEL_ADAPT';
const TTL_FLAG = 'KHY_MODEL_FEATURES_TTL_MS';
const DEFAULT_TTL_MS = 0;
const MAX_TTL_MS = 3600000;
const INLINE_ENV = 'KHY_MODEL_FEATURES_JSON';
const FILE_ENV = 'KHY_MODEL_FEATURES_FILE';
const HOME_FILE_ENV = 'KHY_MODEL_FEATURES_HOME_FILE';
const HOME_FILE_NAME = 'model_features.json';

/**
 * mtime 信任阈值(ms)。
 *
 * `mtime + size` 闸门有一个真实漏洞:两次编辑若**长度相同**且落在同一个文件系统
 * 时间戳刻度里,闸门会判定"没变"而沿用过期配置 —— 实测(tests/modelFeatureRegistry
 * .test.js 的 TTL 用例)确实能触发。对一个以"实时生效"为第一优先的功能,这不能靠
 * "现实中编辑器保存间隔够长"糊过去。
 *
 * 因此:文件 mtime 距今 < 本阈值 → 认为它可能正在被编辑,**不信任闸门**,重读原文
 * 逐字节比对。稳定态(配置几分钟没动)才走纯 stat 快路径。
 * 代价:编辑后的 2 秒内每次解析多一次 readFileSync(约 10KB,数十微秒)。
 */
const MTIME_TRUST_MS = 2000;

/** __dirname = services/backend/src/services → 上两级即 services/backend。 */
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(BACKEND_ROOT, 'config', 'models', 'features.json');

const _FALSY = new Set(['0', 'false', 'no', 'off']);
const _TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * 总闸是否打开。优先问 flagRegistry(它是开关的真源,并施加父子链);
 * 拿不到就退回本地解析。**默认关**(opt-in) —— 与 flagRegistry 里的登记一致。
 *
 * 注意:flagRegistry.isFlagEnabled 对**未登记**的 flag 返回 true(保守放行),
 * 所以 KHY_MODEL_ADAPT 必须登记为 { mode:'opt-in', default:false },否则"默认关"
 * 会变成"默认开"。本函数不依赖那个行为,但调用方仍应确认登记存在。
 *
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('./flagRegistry').isFlagEnabled(MASTER_FLAG, env || process.env);
  } catch {
    /* flagRegistry 不可用时退回本地解析 */
  }

  try {
    const raw = (env || process.env)[MASTER_FLAG];
    const v = String(raw ?? '')
      .trim()
      .toLowerCase();

    return _TRUTHY.has(v);
  } catch {
    return false;
  }
}

function resolveTtlMs(env = process.env) {
  try {
    const reg = require('./flagRegistry');

    if (reg && typeof reg.resolveNumeric === 'function') {
      const n = reg.resolveNumeric(TTL_FLAG, env || process.env);

      if (Number.isFinite(n)) {
        return Math.min(MAX_TTL_MS, Math.max(0, n));
      }
    }
  } catch {
    /* 未登记或 registry 不可用 → 本地解析 */
  }

  return styles.clampInt((env || process.env)[TTL_FLAG], 0, MAX_TTL_MS, DEFAULT_TTL_MS);
}

function resolveAppHomeFile(env = process.env) {
  const explicit = (env || process.env)[HOME_FILE_ENV];

  if (explicit && String(explicit).trim()) {
    return path.resolve(String(explicit).trim());
  }

  try {
    const { getAppHome } = require('../utils/dataHome');

    return path.join(getAppHome(), HOME_FILE_NAME);
  } catch {
    return path.join(os.homedir(), '.khyquant', HOME_FILE_NAME);
  }
}

/** 一个文件层的加载状态。 */
function emptySlot(filePath) {
  return {
    filePath,
    data: null,
    raw: null,
    exists: false,
    mtimeMs: -1,
    size: -1,
    checkedAt: -1,
    stamp: 'init',
    loads: 0,
    reads: 0,
    error: null,
  };
}

class ModelFeatureRegistry {
  /**
   * @param {object} [deps]
   * @param {object} [deps.env]
   * @param {string} [deps.filePath]      仓库配置路径(测试可注入)
   * @param {string} [deps.homeFilePath]  用户覆盖路径(测试可注入)
   * @param {function} [deps.now]         时钟(测试可注入)
   */
  constructor(deps = {}) {
    this.env = deps.env || process.env;
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now();

    const fromEnv = this.env[FILE_ENV];

    this.repo = emptySlot(
      deps.filePath
        ? path.resolve(deps.filePath)
        : fromEnv && String(fromEnv).trim()
          ? path.resolve(String(fromEnv).trim())
          : DEFAULT_CONFIG_PATH
    );
    this.home = emptySlot(
      deps.homeFilePath ? path.resolve(deps.homeFilePath) : resolveAppHomeFile(this.env)
    );

    this._inlineRaw = null;
    this._inlineData = null;
    this._runtime = new Map();
    this._resolved = new Map();
    this._generation = 0;
    this._stats = { gets: 0, cacheHits: 0, reloads: 0, statCalls: 0, fileReads: 0, parseErrors: 0 };
  }

  // ── 文件层 ────────────────────────────────────────────────────────────

  /**
   * mtime+size 闸门:未过 TTL → 直接复用;过了 TTL → statSync 比对,只有变了才读盘。
   * 例外:mtime 太新(< MTIME_TRUST_MS)时不信任闸门,重读原文逐字节比对,避免
   * "同长度 + 同时间戳刻度"的编辑被漏掉。
   * 解析失败时**保留上一份可用数据**并记录 error(降级而非崩溃)。
   *
   * @param {object} slot
   * @param {number} ttlMs
   * @returns {boolean} 本次是否发生了内容变化
   */
  _refreshSlot(slot, ttlMs) {
    const t = this.now();

    if (slot.checkedAt >= 0 && ttlMs > 0 && t - slot.checkedAt < ttlMs) {
      return false;
    }

    slot.checkedAt = t;

    let st = null;

    try {
      this._stats.statCalls += 1;
      st = fs.statSync(slot.filePath);
    } catch {
      // 文件不存在是**正常状态**(用户覆盖文件通常没有),不是错误。
      if (!slot.exists && slot.stamp === 'missing') {
        return false;
      }

      slot.exists = false;
      slot.data = null;
      slot.raw = null;
      slot.mtimeMs = -1;
      slot.size = -1;
      slot.stamp = 'missing';

      return true;
    }

    // 稳定态快路径:戳没变 **且** 文件已经"放凉"了 → 确定没变,不读盘。
    if (
      slot.exists &&
      st.mtimeMs === slot.mtimeMs &&
      st.size === slot.size &&
      t - st.mtimeMs > MTIME_TRUST_MS
    ) {
      return false;
    }

    let raw = null;

    try {
      this._stats.fileReads += 1;
      slot.reads += 1;
      raw = fs.readFileSync(slot.filePath, 'utf8');
    } catch (e) {
      slot.error = String((e && e.message) || e);

      return false;
    }

    slot.mtimeMs = st.mtimeMs;
    slot.size = st.size;
    slot.stamp = `${st.mtimeMs}:${st.size}`;

    // 原文逐字节相同 → 真的没变(哪怕 mtime 被 touch 过)。
    if (slot.exists && raw === slot.raw) {
      return false;
    }

    try {
      const parsed = JSON.parse(raw);

      if (!styles.isPlainObject(parsed)) {
        throw new Error('root is not an object');
      }

      slot.data = parsed;
      slot.raw = raw;
      slot.exists = true;
      slot.error = null;
      slot.loads += 1;

      return true;
    } catch (e) {
      // 配置写坏了:沿用上一份好数据,只记录错误。绝不因此让请求失败。
      // 不更新 slot.raw —— 这样改回合法 JSON 后能立刻被认成"变了"。
      this._stats.parseErrors += 1;
      slot.error = String((e && e.message) || e);

      return false;
    }
  }

  _refreshInline() {
    const raw = this.env[INLINE_ENV];
    const norm = raw === undefined || raw === null ? null : String(raw);

    if (norm === this._inlineRaw) {
      return false;
    }

    this._inlineRaw = norm;
    this._inlineData = null;

    if (norm && norm.trim()) {
      try {
        const parsed = JSON.parse(norm);

        if (styles.isPlainObject(parsed)) {
          this._inlineData = parsed;
        }
      } catch {
        this._stats.parseErrors += 1;
      }
    }

    return true;
  }

  /** 刷新所有层;任一层变化则递增 generation 并清掉已解析缓存。 */
  _refreshAll() {
    const ttl = resolveTtlMs(this.env);
    let changed = false;

    if (this._refreshSlot(this.repo, ttl)) {
      changed = true;
    }

    if (this._refreshSlot(this.home, ttl)) {
      changed = true;
    }

    if (this._refreshInline()) {
      changed = true;
    }

    if (changed) {
      this._generation += 1;
      this._resolved.clear();
    }

    return changed;
  }

  // ── 解析 ──────────────────────────────────────────────────────────────

  _repoDoc() {
    return styles.isPlainObject(this.repo.data) ? this.repo.data : {};
  }

  /** 从一份文档里取某模型的精确条目(大小写不敏感)。 */
  _exactEntry(doc, modelId) {
    const models = styles.isPlainObject(doc.models) ? doc.models : {};

    if (styles.isPlainObject(models[modelId])) {
      return models[modelId];
    }

    const lower = modelId.toLowerCase();

    for (const key of Object.keys(models)) {
      if (key.startsWith('_')) {
        continue;
      }

      if (key.toLowerCase() === lower && styles.isPlainObject(models[key])) {
        return models[key];
      }
    }

    return null;
  }

  /** 依声明顺序合并**所有**命中的家族正则规则(可叠加:家族规则 + 变体规则)。 */
  _patternLayers(doc, modelId) {
    const out = [];
    const list = Array.isArray(doc.patterns) ? doc.patterns : [];
    const lower = modelId.toLowerCase();

    for (const rule of list) {
      if (!styles.isPlainObject(rule) || typeof rule.match !== 'string') {
        continue;
      }

      let re = null;

      try {
        re = new RegExp(rule.match, 'i');
      } catch {
        // 正则写坏了 → 跳过这条规则,不影响其余规则与整体解析。
        continue;
      }

      if (re.test(lower) && styles.isPlainObject(rule.features)) {
        out.push({ id: typeof rule.id === 'string' ? rule.id : rule.match, patch: rule.features });
      }
    }

    return out;
  }

  /**
   * 兜底层:完全未登记的模型也要拿到方向正确的画像。
   * 用 modelTier.resolveTier 定档,再用 harnessProfile 的旋钮推 style/params。
   *
   * @param {string} modelId
   * @param {object} opts
   * @returns {{tier:string, patch:object, harness:object|null}}
   */
  _tierLayer(modelId, opts) {
    let tier = 'T2';
    let harness = null;

    try {
      const mt = require('./modelTier');

      tier = mt.resolveTier(modelId, opts && opts.tierOpts ? opts.tierOpts : {});
      harness = mt.harnessProfile(tier, opts && opts.harnessOpts ? opts.harnessOpts : {});
    } catch {
      /* modelTier 不可用 → 停留在 T2 中庸档 */
    }

    const patch = {};

    if (styles.isPlainObject(harness)) {
      const style = {};

      if (harness.promptVerbosity === 'lean') {
        style.prompt_preference = 'concise';
      } else if (harness.promptVerbosity === 'full') {
        style.prompt_preference = 'detailed';
      }

      if (harness.decompose === true) {
        style.tool_usage_tendency = 'conservative';
        style.response_style = 'explainer';
      }

      if (Object.keys(style).length > 0) {
        patch.style_profile = style;
      }

      if (harness.shortContext === true) {
        patch.capability_matrix = { long_context: 1 };
      }
    }

    return { tier, patch, harness };
  }

  /**
   * 取某模型的完整画像。**同步**(现有 promptAssemblyService 全同步,热路径需要它同步);
   * 调用方写 `await registry.get(id)` 也成立。
   *
   * @param {string} modelIdRaw
   * @param {object} [opts] {taskType, tierOpts, harnessOpts, refresh}
   * @returns {object} 完整画像,含 _meta。永不为 null,永不抛错。
   */
  get(modelIdRaw, opts = {}) {
    this._stats.gets += 1;

    let modelId = '';

    try {
      modelId = String(modelIdRaw ?? '').trim();
    } catch {
      modelId = '';
    }

    try {
      if (opts && opts.refresh) {
        this.reload({ reason: 'explicit-refresh' });
      } else {
        this._refreshAll();
      }

      const cacheKey = `${this._generation}|${modelId}|${
        opts && opts.tierOpts ? JSON.stringify(opts.tierOpts) : ''
      }`;
      const hit = this._resolved.get(cacheKey);

      if (hit) {
        this._stats.cacheHits += 1;

        return hit;
      }

      const built = this._build(modelId, opts || {});

      this._resolved.set(cacheKey, built);

      return built;
    } catch (e) {
      // 任何意外都退化为"纯默认画像",绝不让一次查表打断请求。
      const safe = styles.normalizeProfile(null);

      safe._meta = {
        modelId,
        tier: 'T2',
        layers: ['fallback-error'],
        confidence: 'prior',
        error: String((e && e.message) || e),
        generation: this._generation,
      };

      return safe;
    }
  }

  _build(modelId, opts) {
    const doc = this._repoDoc();
    const homeDoc = styles.isPlainObject(this.home.data) ? this.home.data : {};
    const inlineDoc = styles.isPlainObject(this._inlineData) ? this._inlineData : {};
    const repoPatterns = this._patternLayers(doc, modelId);
    const homePatterns = this._patternLayers(homeDoc, modelId);
    const inlinePatterns = this._patternLayers(inlineDoc, modelId);
    const exact = modelId ? this._exactEntry(doc, modelId) : null;
    const homeExact = modelId ? this._exactEntry(homeDoc, modelId) : null;
    const inlineExact = modelId ? this._exactEntry(inlineDoc, modelId) : null;
    const runtime = modelId ? this._runtime.get(modelId.toLowerCase()) : null;
    const validTier = (value) => {
      const tier = typeof value === 'string' ? value.trim().toUpperCase() : '';

      return ['T0', 'T1', 'T2', 'T3'].includes(tier) ? tier : '';
    };
    let configuredTier = '';

    // tier 与画像使用相同的低→高优先级。先定档,再选择 harness/tierDefaults,
    // 避免 `_meta.tier=T0` 却实际合入 `tierDefaults:T2` 的伪一致。
    for (const layer of [
      ...repoPatterns.map((p) => p.patch),
      exact,
      ...homePatterns.map((p) => p.patch),
      homeExact,
      runtime && runtime.patch,
      ...inlinePatterns.map((p) => p.patch),
      inlineExact,
    ]) {
      const tier = styles.isPlainObject(layer) ? validTier(layer.tier) : '';

      if (tier) {
        configuredTier = tier;
      }
    }

    const tierOpts = Object.assign({}, opts && opts.tierOpts);

    if (!validTier(tierOpts.forceTier) && configuredTier) {
      tierOpts.forceTier = configuredTier;
    }

    const tierInfo = this._tierLayer(modelId, Object.assign({}, opts, { tierOpts }));
    const layers = [];

    // 7 → 1,由低到高逐层合并。
    // 注意 harnessProfile 排在 tierDefaults **之前**:它是从模型名推断出来的兜底,
    // 优先级必须低于人写在配置里的 tierDefaults,否则配置里的 tier 级设置会被
    // 推断值静默覆盖(实测踩过:sonnet 配了 structured,却总是拿到 detailed)。
    let acc = styles.isPlainObject(doc.defaults) ? doc.defaults : {};

    if (Object.keys(acc).length > 0) {
      layers.push('defaults');
    }

    if (Object.keys(tierInfo.patch).length > 0) {
      acc = styles.mergeProfiles(acc, tierInfo.patch);
      layers.push('harnessProfile');
    }

    const tierDefaults = styles.isPlainObject(doc.tierDefaults) ? doc.tierDefaults : {};

    if (styles.isPlainObject(tierDefaults[tierInfo.tier])) {
      acc = styles.mergeProfiles(acc, tierDefaults[tierInfo.tier]);
      layers.push(`tierDefaults:${tierInfo.tier}`);
    }

    for (const p of repoPatterns) {
      acc = styles.mergeProfiles(acc, p.patch);
      layers.push(`pattern:${p.id}`);
    }

    if (exact) {
      acc = styles.mergeProfiles(acc, exact);
      layers.push('models');
    }

    // 用户覆盖文件同样支持 patterns + models(格式与仓库配置完全一致)。
    for (const p of homePatterns) {
      acc = styles.mergeProfiles(acc, p.patch);
      layers.push(`home:pattern:${p.id}`);
    }

    if (homeExact) {
      acc = styles.mergeProfiles(acc, homeExact);
      layers.push('home:models');
    }

    if (runtime && styles.isPlainObject(runtime.patch)) {
      acc = styles.mergeProfiles(acc, runtime.patch);
      layers.push('runtime');
    }

    for (const p of inlinePatterns) {
      acc = styles.mergeProfiles(acc, p.patch);
      layers.push(`inline:pattern:${p.id}`);
    }

    if (inlineExact) {
      acc = styles.mergeProfiles(acc, inlineExact);
      layers.push('inline:models');
    }

    const profile = styles.normalizeProfile(acc);

    profile._meta = {
      modelId,
      tier: tierInfo.tier,
      layers,
      // 只要有精确/运行时条目就用它声明的置信度;否则全是先验推断。
      confidence: profile.confidence,
      known: Boolean(exact || homeExact || runtime),
      generation: this._generation,
      configPath: this.repo.exists ? this.repo.filePath : null,
      configError: this.repo.error || null,
      homePath: this.home.exists ? this.home.filePath : null,
      homeError: this.home.error || null,
    };

    return profile;
  }

  // ── 运行时覆盖(Goal 5 的落点)──────────────────────────────────────

  /**
   * 把一份画像补丁存进**内存**(不写盘、进程退出即失效)。
   * modelDiscoveryEngine 首轮探测的结论以 confidence:'low' 存在这里,人工复核后
   * 才由运维誊写进 <appHome>/model_features.json 提升为 measured。
   *
   * @param {string} modelIdRaw
   * @param {object} patch
   * @param {object} [meta] {confidence, source, note}
   * @returns {boolean} 是否写入成功
   */
  saveTemporarily(modelIdRaw, patch, meta = {}) {
    try {
      const modelId = String(modelIdRaw ?? '').trim();

      if (!modelId || !styles.isPlainObject(patch)) {
        return false;
      }

      const merged = Object.assign({}, patch, {
        confidence: styles.pickEnum(
          meta.confidence || patch.confidence,
          styles.CONFIDENCE_LEVELS,
          'low'
        ),
        source: typeof meta.source === 'string' && meta.source.trim() ? meta.source.trim() : 'runtime',
      });

      this._runtime.set(modelId.toLowerCase(), {
        modelId,
        patch: merged,
        note: typeof meta.note === 'string' ? meta.note : '',
        savedAt: this.now(),
      });
      this._generation += 1;
      this._resolved.clear();

      return true;
    } catch {
      return false;
    }
  }

  clearTemporary(modelIdRaw) {
    try {
      if (modelIdRaw === undefined) {
        const had = this._runtime.size > 0;

        this._runtime.clear();
        this._generation += 1;
        this._resolved.clear();

        return had;
      }

      const key = String(modelIdRaw ?? '')
        .trim()
        .toLowerCase();
      const had = this._runtime.delete(key);

      if (had) {
        this._generation += 1;
        this._resolved.clear();
      }

      return had;
    } catch {
      return false;
    }
  }

  listTemporary() {
    try {
      return Array.from(this._runtime.values()).map((v) => ({
        modelId: v.modelId,
        confidence: v.patch && v.patch.confidence,
        source: v.patch && v.patch.source,
        note: v.note,
        savedAt: v.savedAt,
      }));
    } catch {
      return [];
    }
  }

  // ── 运维接口 ──────────────────────────────────────────────────────────

  /**
   * 强制重读所有层(供 Phase 3 的 HTTP 热重载端点调用)。
   * 与"等 TTL 自然过期"等价,只是立刻发生。
   *
   * @param {object} [opts] {reason}
   * @returns {object} getStatus() 的结果
   */
  reload(opts = {}) {
    this._stats.reloads += 1;
    this.repo.checkedAt = -1;
    this.repo.mtimeMs = -1;
    this.repo.size = -1;
    this.repo.raw = null;
    this.home.checkedAt = -1;
    this.home.mtimeMs = -1;
    this.home.size = -1;
    this.home.raw = null;
    this._inlineRaw = undefined;
    this._refreshAll();
    this._lastReload = { at: this.now(), reason: String((opts && opts.reason) || 'manual') };

    return this.getStatus();
  }

  /** 监控用状态快照。字段含义见 docs 使用说明。 */
  getStatus() {
    const slot = (s) => ({
      path: s.filePath,
      exists: s.exists,
      loads: s.loads,
      reads: s.reads,
      mtimeMs: s.mtimeMs,
      size: s.size,
      error: s.error,
    });

    return {
      enabled: isEnabled(this.env),
      ttlMs: resolveTtlMs(this.env),
      generation: this._generation,
      schemaVersion: this._repoDoc().$schemaVersion || null,
      repo: slot(this.repo),
      home: slot(this.home),
      inline: { present: Boolean(this._inlineData), raw: this._inlineRaw ? 'set' : 'unset' },
      runtimeOverrides: this._runtime.size,
      resolvedCacheSize: this._resolved.size,
      counters: Object.assign({}, this._stats),
      lastReload: this._lastReload || null,
    };
  }

  /**
   * 人类可读摘要,给 /status 端点与排障用。绝不抛错。
   *
   * @param {string} modelId
   * @returns {string}
   */
  describeModelFeatures(modelId) {
    try {
      const p = this.get(modelId);
      const sp = p.style_profile;
      const caps = styles.CAPABILITY_DIMS.filter((d) => p.capability_matrix[d] >= 4).join(', ');

      return [
        `model=${p._meta.modelId || '(empty)'} tier=${p._meta.tier} known=${p._meta.known} confidence=${p.confidence}`,
        `style=${sp.prompt_preference}/${sp.response_style}/${sp.tool_usage_tendency} scaffolding=${sp.scaffolding_comfort_level}/10`,
        `strong_dims=${caps || '(none>=4)'}`,
        `strengths=${p.specialty_areas.strengths.join(',') || '-'} weaknesses=${p.specialty_areas.weaknesses.join(',') || '-'}`,
        `tools<=${p.dynamic_params.max_tools_per_turn} parallel<=${p.dynamic_params.parallel_tool_allowance} timeout=${p.dynamic_params.preferred_timeout_ms}ms`,
        `layers=${p._meta.layers.join(' > ')}`,
      ].join('\n');
    } catch {
      return '';
    }
  }
}

let _singleton = null;

/**
 * 进程级单例。
 *
 * @returns {ModelFeatureRegistry}
 */
function getModelFeatureRegistry() {
  if (!_singleton) {
    _singleton = new ModelFeatureRegistry();
  }

  return _singleton;
}

/**
 * 依赖注入工厂(测试用)。
 *
 * @param {object} [deps]
 * @returns {ModelFeatureRegistry}
 */
function makeModelFeatureRegistry(deps) {
  return new ModelFeatureRegistry(deps || {});
}

/** 测试钩子:丢掉单例。 */
function _resetModelFeatureRegistry() {
  _singleton = null;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  MASTER_FLAG,
  ModelFeatureRegistry,
  TTL_FLAG,
  _resetModelFeatureRegistry,
  getModelFeatureRegistry,
  isEnabled,
  makeModelFeatureRegistry,
  resolveTtlMs,
};
