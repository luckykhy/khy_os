'use strict';

// ═══════════════════════════════════════════════════════════════════
// localBrainProviderConfig — 模型供应商配置 / 外部软件模型配置 / 反向导入 三簇确定性技能叶子
// ───────────────────────────────────────────────────────────────────
// 从 localBrainService.js 抽出(降上帝文件·DESIGN-ARCH-051 lineage,范式同 localBrainCalc/
// localBrainTextOps/localBrainExternalApi):把「用自然语言增/删/列 khy 自身及 6 个外部软件的
// API Key·endpoint·URL·模型」以及「把外部软件已配置模型反向导入 khy 池」三簇 Tier-1 处理器
// 打包为一个内聚叶子,localBrainService 以**同名别名 re-export** 接回三张注册表,契约字节不变。
//
// 本叶子刻意 **NOT 声明为纯零 IO 叶子**:解析面(nlProviderResolver 等)是零 IO 纯叶子,但本薄壳
// 的执行器会经 apiKeyPool / customProviderRegistrar / externalApps 适配器**落盘写入配置**(增删
// key/provider)。所有落地均走既有 SSOT,全程 fail-soft,任何人面输出一律脱敏(maskToken)。
//
// 依赖(与抽出前 localBrainService 顶部同款 require·同目录相对路径不变·可选者 try/catch 降级):
//   · nlProviderResolver            — 供应商配置意图解析(零 IO 纯叶子·门控 KHY_NL_PROVIDER)
//   · keyUpdateFlow                 — 裸 key 识别 + 厂商推断(零 IO·门控 KHY_KEY_UPDATE_FLOW)
//   · nlExternalAppResolver         — 外部软件配置意图解析(零 IO·门控 KHY_NL_EXTERNAL_APP·可缺)
//   · nlExternalAppImportResolver   — 反向导入意图解析(零 IO·门控 KHY_NL_EXTERNAL_APP_IMPORT·可缺)
//   · appModelImporter              — 反向发现/导入落地(门控 KHY_EXTERNAL_APP_IMPORT·可缺)
//   · localFormat                   — 人面排版(可缺 → 降级纯文本)
// ═══════════════════════════════════════════════════════════════════

// 模型供应商配置「意图解析」纯叶子（零 IO）：把「用 NL 增/删/列 API Key·endpoint·URL·模型」
// 解析成结构化意图；真正落地由本服务薄壳经 customProviderRegistrar/Registry/apiKeyPool SSOT 执行。
const nlProviderResolver = require('./config/nlProviderResolver');
// API Key 失效→无模型也能更新的纯叶子(裸 key 识别 + 厂商推断 + 邀请文案)；写入仍走 _execProviderAdd。
const keyUpdateFlow = require('./keyUpdateFlow');
// 外部软件模型配置「意图解析」纯叶子(零 IO):把「给 opencode/openclaw/reasonix/deepseek-tui/
// coze/claude-code 增删改查模型」解析成结构化意图;真正读写各 app 配置文件由本服务薄壳经
// externalApps/*Adapter 落地(fail-soft·merge-write·原子写·删除带确认闸门)。lazy-require 接线。
let nlExternalAppResolver = null;
try { nlExternalAppResolver = require('./config/nlExternalAppResolver'); } catch { /* leaf absent → degrade */ }
// 反向:把 6 个外部软件里已配置的可用模型**读出来并注册进 khy 自己的 provider 池**(消费侧)。
// 解析面为纯叶子 nlExternalAppImportResolver(零 IO·门控 KHY_NL_EXTERNAL_APP_IMPORT);落地经
// externalApps/appModelImporter(discover/importApp/unimport,fail-soft,输出全脱敏)。lazy-require。
let nlExternalAppImportResolver = null;
try { nlExternalAppImportResolver = require('./config/nlExternalAppImportResolver'); } catch { /* leaf absent → degrade */ }
let _appModelImporter = null;
try { _appModelImporter = require('./externalApps/appModelImporter'); } catch { /* importer absent → degrade */ }
let _fmt = null;
try { _fmt = require('./localFormat'); } catch { /* degrade to plain text */ }

// ── 2c. 模型供应商配置 (provider_config：增/删/列 API Key·endpoint·URL·模型) ─────────
//
// goal「自然语言要能驱动一切 —— 无网络无模型(Tier A)也应可以」的**配置**闭环,且专治
// bootstrap 死锁:配置**第一把**密钥+模型恰恰是「还没有模型」的场景(用模型配模型是死锁)。
// 解析面是零 IO 纯叶子 nlProviderResolver;本薄壳只负责把意图经既有 SSOT 落地:
//   · 增  → builtinProviderConfig.applyBuiltinProviderKey(内置厂商) / customProviderRegistrar
//           .registerCustomProvider(自定义/中转,需 endpoint+model,缺则返回「待补齐」预览,不执行);
//   · 删  → **破坏性** → 默认仅**预览**(只读),须同句带「确认」字样才 unregisterCustomProvider;
//           **默认仅摘 provider 元数据+路由、保留密钥**(最可恢复),唯「连密钥一起删」才 removeKeys;
//           内置 provider 不可删(registrar 抛错,转述);
//   · 列  → 只读 customProviderRegistry.listProviders()+apiKeyPool.getPoolStatus(keyPreview 已脱敏)。
// cooperative:true 且置于所有写/删(file_delete)之后 → 仅无模型(Tier A)介入,有模型让路给
// configureModelProvider 工具+权限层。门控 KHY_NL_PROVIDER(叶子内)默认开,关 → resolve 恒
// null → match 恒 false → 字节回退兜底菜单。**安全铁律**:任何人面输出一律 maskToken,绝不回显完整 key。

/** slug 化显示名为 poolKey(与 configureModelProvider 工具同款规则)。 */
function _slugifyPoolKey(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 把用户输入的供应商引用(显示名/poolKey)解析成已注册的真实 poolKey(找不到则回退 slug)。 */
function _resolveProviderPoolKey(target) {
  const raw = String(target || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  try {
    const customRegistry = require('./customProviderRegistry');
    for (const p of customRegistry.listProviders()) {
      if (!p) continue;
      if (String(p.poolKey || '').toLowerCase() === lower) return p.poolKey;
      if (String(p.name || '').toLowerCase() === lower) return p.poolKey;
    }
  } catch { /* registry unreadable → fall through to slug */ }
  return _slugifyPoolKey(raw) || lower;
}

function _isProviderCfgIntent(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 500) return false;
  // 叶子内门控 KHY_NL_PROVIDER + 零假阳性闸门;关或不命中 → null → 不接管(字节回退)。
  return nlProviderResolver.resolve(text, process.env) != null;
}

function _detectProviderCfg(text) {
  const intent = nlProviderResolver.resolve(text, process.env);
  if (!intent) return null;
  let label = '供应商配置';
  if (intent.action === 'list') label = '列出供应商';
  else if (intent.needsProvider) label = '替换密钥(待指定供应商)';
  else if (intent.action === 'add') label = `配置 ${intent.provider}`;
  else if (intent.action === 'remove') label = `${intent.confirmed ? '删除' : '预览删除'} ${intent.target}`;
  return { type: 'provider_config', category: '供应商配置', label, intent };
}

function _maskKeyText(key) {
  try {
    const { maskToken } = require('./accountPool/credentialHelpers');
    return maskToken(key);
  } catch {
    return '***';
  }
}

function _execProviderList() {
  let providers = [];
  try {
    const customRegistry = require('./customProviderRegistry');
    const pool = require('./apiKeyPool');
    try { pool.init(); } catch { /* already initialised */ }
    providers = (customRegistry.listProviders() || []).map((p) => {
      let keyCount = 0;
      let keyHeads = [];
      try {
        const status = pool.getPoolStatus(p.poolKey) || [];
        keyCount = status.length;
        keyHeads = status.map((e) => e.keyPreview).filter(Boolean); // keyPreview 已脱敏
      } catch { /* best effort */ }
      return {
        provider: p.name || p.poolKey,
        poolKey: p.poolKey,
        endpoint: p.endpoint || '',
        defaultModel: p.defaultModel || '',
        models: Array.isArray(p.models) ? p.models : [],
        keyCount,
        keyHeads,
      };
    });
  } catch (e) {
    return { type: 'provider_config', action: 'list', success: false, error: e && e.message ? e.message : String(e) };
  }
  return { type: 'provider_config', action: 'list', success: true, providers };
}

function _execProviderAskWhich(intent) {
  // 替换密钥却没指明供应商 → 反问让用户选(不猜)。汇总当前**已配置**(有密钥)的供应商,全程脱敏。
  const configured = [];
  try {
    const pool = require('./apiKeyPool');
    try { pool.init(); } catch { /* already initialised */ }
    const _keyCount = (poolKey) => {
      try { return (pool.getPoolStatus(poolKey) || []).length; } catch { return 0; }
    };
    // 内置厂商:仅列出已有密钥者。
    try {
      const { listBuiltinProviders } = require('./gateway/builtinProviderConfig');
      for (const p of listBuiltinProviders() || []) {
        if (!p.poolKey) continue;
        const keyCount = _keyCount(p.poolKey);
        if (keyCount > 0) configured.push({ provider: p.name || p.poolKey, poolKey: p.poolKey, keyCount });
      }
    } catch { /* best effort */ }
    // 自定义 / 中转 provider。
    try {
      const customRegistry = require('./customProviderRegistry');
      for (const p of customRegistry.listProviders() || []) {
        configured.push({ provider: p.name || p.poolKey, poolKey: p.poolKey, keyCount: _keyCount(p.poolKey) });
      }
    } catch { /* best effort */ }
  } catch { /* best effort */ }
  const shapeGuess = String((intent && intent.shapeGuess) || '').trim();
  return { type: 'provider_config', action: 'add', success: true, needsProvider: true, configured, shapeGuess };
}

function _execProviderAdd(intent) {
  if (intent && intent.needsProvider) return _execProviderAskWhich(intent);
  const provider = String(intent.provider || '').trim();
  const apiKey = intent.apiKey;
  if (!provider) return { type: 'provider_config', action: 'add', success: false, error: '未识别到供应商名称' };
  if (!apiKey) return { type: 'provider_config', action: 'add', success: false, error: '未识别到 API Key' };
  const keyRedacted = _maskKeyText(apiKey);
  try {
    const { findBuiltinProvider, applyBuiltinProviderKey } = require('./gateway/builtinProviderConfig');
    const builtin = findBuiltinProvider(provider);
    if (builtin) {
      const result = applyBuiltinProviderKey({
        provider: builtin,
        keyInput: apiKey,
        endpoint: intent.endpoint || undefined,
        model: intent.model || '',
      });
      return {
        type: 'provider_config', action: 'add', success: true, kind: 'builtin',
        provider: builtin.name, poolKey: result.poolKey, model: result.model || '',
        endpoint: result.endpoint || '', keyRedacted, added: result.added, duplicate: result.duplicate,
        models: result.models,
      };
    }
    // 自定义 / 中转:需 endpoint + model,缺则返回「待补齐」预览(不执行写入)。
    const endpoint = String(intent.endpoint || '').trim();
    const model = String(intent.model || '').trim();
    const missing = [];
    if (!endpoint) missing.push('接口地址(endpoint/base-url)');
    if (!model) missing.push('默认模型 ID');
    if (missing.length) {
      return {
        type: 'provider_config', action: 'add', success: true, needsMore: true,
        provider, keyRedacted, missing,
      };
    }
    const poolKey = _slugifyPoolKey(intent.poolKey || provider);
    if (!poolKey) return { type: 'provider_config', action: 'add', success: false, error: '无法从供应商名推导出有效 poolKey' };
    const { registerCustomProvider } = require('./customProviderRegistrar');
    const result = registerCustomProvider({
      displayName: provider, poolKey, endpoint, keyInput: apiKey,
      defaultModel: model, extraModels: intent.extraModels, tier: intent.tier, ensureInit: true,
    });
    return {
      type: 'provider_config', action: 'add', success: true, kind: 'custom',
      provider: result.displayName, poolKey: result.poolKey, model: result.defaultModel,
      endpoint: result.endpoint, keyRedacted, keyCount: result.keyCount, tier: result.tier,
      models: result.models,
    };
  } catch (e) {
    return { type: 'provider_config', action: 'add', success: false, error: e && e.message ? e.message : String(e) };
  }
}

// ── key_update:无模型路径下「用户直接粘一把裸 key」→ 确定性写入 ──────────────────────
// nlProviderResolver 的「域名+动词」零误报闸门刻意不认裸 key(如单独一段 sk-...),故 provider_config
// 抓不到。本处理器只在**无模型**(cooperative:true)介入,把 keyUpdateFlow 识别出的裸 key + 厂商推断
// 交由既有 _execProviderAdd 写入(全程无需模型)。厂商无法确定时反问(_execProviderAskWhich),绝不猜。

function _isKeyUpdateIntent(text) {
  try { return keyUpdateFlow.looksLikeBareKey(text, process.env).isKey === true; }
  catch { return false; }
}

function _detectKeyUpdate(text) {
  try {
    const d = keyUpdateFlow.looksLikeBareKey(text, process.env);
    if (!d || !d.isKey || !d.key) return null;
    const hint = keyUpdateFlow.extractProviderHint(text, process.env);
    return { type: 'key_update', category: '更新密钥', label: '更新 API Key', apiKey: d.key, providerHint: hint };
  } catch { return null; }
}

/** 汇总当前**已配置**(有密钥)的 poolKey(内置有密钥者 + 全部自定义),用于「唯一厂商」自动推断。 */
function _listConfiguredPoolKeys() {
  const keys = [];
  try {
    const pool = require('./apiKeyPool');
    try { pool.init(); } catch { /* already initialised */ }
    const _hasKey = (poolKey) => {
      try { return (pool.getPoolStatus(poolKey) || []).length > 0; } catch { return false; }
    };
    try {
      const { listBuiltinProviders } = require('./gateway/builtinProviderConfig');
      for (const p of listBuiltinProviders() || []) {
        if (p && p.poolKey && _hasKey(p.poolKey)) keys.push(p.poolKey);
      }
    } catch { /* best effort */ }
    try {
      const customRegistry = require('./customProviderRegistry');
      for (const p of customRegistry.listProviders() || []) {
        if (p && p.poolKey && !keys.includes(p.poolKey)) keys.push(p.poolKey);
      }
    } catch { /* best effort */ }
  } catch { /* best effort */ }
  return keys;
}

function _execKeyUpdate(plan) {
  try {
    const apiKey = plan && plan.apiKey;
    if (!apiKey) return { type: 'provider_config', action: 'add', success: false, error: '未识别到 API Key' };
    const decision = keyUpdateFlow.decideProvider(
      { hint: plan.providerHint, key: apiKey, configuredPoolKeys: _listConfiguredPoolKeys() },
      process.env
    );
    if (decision && decision.needsProvider) {
      // 形态推断出厂商(如 hex32.secret→glm)→ 带猜测反问确认,不静默拍板归属。
      return _execProviderAskWhich({ needsProvider: true, shapeGuess: decision.shapeGuess || '' });
    }
    // 复用既有确定性写入链(findBuiltinProvider → applyBuiltinProviderKey → apiKeyPool.addKey)。
    return _execProviderAdd({ action: 'add', provider: decision.provider, apiKey });
  } catch (e) {
    return { type: 'provider_config', action: 'add', success: false, error: e && e.message ? e.message : String(e) };
  }
}

function _execProviderRemove(intent) {
  const poolKey = _resolveProviderPoolKey(intent.target);
  if (!poolKey) return { type: 'provider_config', action: 'remove', success: false, error: '未识别到要删除的供应商' };
  // 内置 provider 不可删 — 提前转述(无论预览或确认)。
  try {
    const customRegistry = require('./customProviderRegistry');
    if (customRegistry.isBuiltinPoolKey && customRegistry.isBuiltinPoolKey(poolKey)) {
      return { type: 'provider_config', action: 'remove', success: false, error: `"${poolKey}" 是内置 provider，不能删除` };
    }
    const provider = customRegistry.getProvider(poolKey);
    if (!provider) {
      return { type: 'provider_config', action: 'remove', success: false, error: `未找到供应商「${intent.target}」(poolKey=${poolKey})` };
    }
    // 预览(默认):只读列出将被移除的元数据/路由/密钥数,绝不执行。
    if (!intent.confirmed) {
      let keyCount = 0;
      try {
        const pool = require('./apiKeyPool');
        try { pool.init(); } catch { /* already initialised */ }
        keyCount = (pool.getPoolStatus(poolKey) || []).length;
      } catch { /* best effort */ }
      return {
        type: 'provider_config', action: 'remove', success: true, preview: true,
        poolKey, provider: provider.name || poolKey,
        models: Array.isArray(provider.models) ? provider.models : [],
        keyCount, removeKeys: !!intent.removeKeys,
      };
    }
    // 已确认 → 真正注销(默认保留密钥,唯 removeKeys 才一并清除)。
    const { unregisterCustomProvider } = require('./customProviderRegistrar');
    const res = unregisterCustomProvider(poolKey, { removeKeys: !!intent.removeKeys });
    return {
      type: 'provider_config', action: 'remove', success: true, preview: false,
      poolKey: res.poolKey, removed: res.removed, keptKeys: res.keptKeys,
      provider: provider.name || poolKey,
    };
  } catch (e) {
    return { type: 'provider_config', action: 'remove', success: false, error: e && e.message ? e.message : String(e) };
  }
}

function _executeProviderCfg(plan) {
  const intent = plan && plan.intent;
  if (!intent) return { type: 'provider_config', success: false, error: '无效的供应商配置意图' };
  if (intent.action === 'list') return _execProviderList();
  if (intent.action === 'add') return _execProviderAdd(intent);
  if (intent.action === 'remove') return _execProviderRemove(intent);
  return { type: 'provider_config', success: false, error: `未知供应商配置动作: ${intent.action}` };
}

function _formatProviderCfg(result) {
  if (!result || !result.success) return `供应商配置失败: ${(result && result.error) || '未知错误'}`;

  if (result.action === 'list') {
    const ps = result.providers || [];
    if (ps.length === 0) {
      return _fmt && _fmt.isEnabled()
        ? _fmt.compose({ title: '已配置的模型供应商', sections: [{ lines: ['（暂无自定义供应商）'] }], meta: ['供应商配置', '只读'] })
        : '已配置的模型供应商：（暂无自定义供应商）';
    }
    const lines = ps.map((p) => {
      const keyInfo = p.keyCount > 0 ? `${p.keyCount} 把密钥 ${p.keyHeads.join(' ')}`.trim() : '无密钥';
      return `${p.provider} (${p.poolKey})  模型: ${p.defaultModel || (p.models[0] || '—')}  ${keyInfo}`;
    });
    return _fmt && _fmt.isEnabled()
      ? _fmt.compose({ title: '已配置的模型供应商', sections: [{ lines }], meta: ['供应商配置', '只读', '密钥已脱敏'] })
      : `已配置的模型供应商：\n  ${lines.join('\n  ')}`;
  }

  if (result.action === 'add') {
    if (result.needsProvider) {
      const cfg = Array.isArray(result.configured) ? result.configured : [];
      const listed = cfg.length
        ? cfg.map((p) => `${p.provider} (${p.poolKey})  ${p.keyCount > 0 ? `${p.keyCount} 把密钥` : '无密钥'}`)
        : ['（暂无已配置供应商）'];
      // 形态推断出厂商 → 呈现「带猜测的确认」而非泛化反问(不静默拍板)。
      const shapeGuess = String(result.shapeGuess || '').trim();
      if (shapeGuess) {
        let invite = '';
        try { invite = keyUpdateFlow.buildShapeConfirmInvite({ shapeGuess }, process.env) || ''; } catch { invite = ''; }
        const hint = invite
          || `这把 key 的形态看起来像 ${shapeGuess} 的 key。确认要归属到 ${shapeGuess} 吗？是就回「确认 ${shapeGuess}」，若其实是别家就回「换成 <厂商名>」。`;
        const title = `确认供应商：这看起来像 ${shapeGuess} 的 key`;
        return _fmt && _fmt.isEnabled()
          ? _fmt.compose({ title, sections: [{ lines: listed }], meta: ['供应商配置', '待确认供应商'], footer: hint })
          : `${hint}\n当前已配置：\n  ${listed.join('\n  ')}`;
      }
      const hint = '检测到你要替换密钥，但没说是哪个供应商。请指明，例如「把 deepseek 的 key 换成 <你的key>」。';
      return _fmt && _fmt.isEnabled()
        ? _fmt.compose({ title: '替换哪个供应商的密钥？', sections: [{ lines: listed }], meta: ['供应商配置', '待指定供应商'], footer: hint })
        : `${hint}\n当前已配置：\n  ${listed.join('\n  ')}`;
    }
    if (result.needsMore) {
      const tip = `还需补齐：${result.missing.join('、')}。例如：添加供应商 ${result.provider} 接口 https://api.example.com/v1 密钥 <你的key> 模型 <模型ID>`;
      return _fmt && _fmt.isEnabled()
        ? _fmt.compose({ title: '需要更多信息才能配置自定义供应商', sections: [{ lines: [tip] }], meta: ['供应商配置', '待补齐'] })
        : tip;
    }
    const head = result.duplicate ? '密钥已存在（未重复添加）' : '已配置供应商';
    const body = [
      `供应商: ${result.provider} (${result.poolKey})`,
      `默认模型: ${result.model || '—'}`,
      result.endpoint ? `接口: ${result.endpoint}` : null,
      `密钥: ${result.keyRedacted}`,
    ].filter(Boolean);
    return _fmt && _fmt.isEnabled()
      ? _fmt.compose({ title: head, sections: [{ lines: body }], meta: ['供应商配置', result.kind === 'builtin' ? '内置厂商' : '自定义/中转', '密钥已脱敏'] })
      : `${head}：\n  ${body.join('\n  ')}`;
  }

  if (result.action === 'remove') {
    if (result.preview) {
      const keysNote = result.removeKeys ? '将连同密钥一并删除' : `将保留 ${result.keyCount} 把密钥（可复用）`;
      const tip = `删除预览（未执行）\n  供应商: ${result.provider} (${result.poolKey})\n  将移除: provider 元数据 + 模型路由（${(result.models || []).length} 个模型）\n  密钥处理: ${keysNote}\n未删除任何东西。确认请重发并带上「确认」，如：确认删除供应商 ${result.poolKey}${result.removeKeys ? ' 连密钥一起删' : ''}`;
      return _fmt && _fmt.isEnabled()
        ? _fmt.compose({ title: '删除预览（未执行）', sections: [{ lines: [`供应商: ${result.provider} (${result.poolKey})`, `将移除: provider 元数据 + 模型路由（${(result.models || []).length} 个模型）`, `密钥处理: ${keysNote}`] }], meta: ['供应商配置', '仅预览'], footer: `未删除任何东西。确认请重发并带上「确认」，如：确认删除供应商 ${result.poolKey}${result.removeKeys ? ' 连密钥一起删' : ''}` })
        : tip;
    }
    const keysNote = result.keptKeys ? '密钥已保留（可复用）' : '密钥已一并删除';
    return _fmt && _fmt.isEnabled()
      ? _fmt.compose({ title: '已删除供应商', sections: [{ lines: [`供应商: ${result.provider} (${result.poolKey})`, keysNote] }], meta: ['供应商配置', '已执行'] })
      : `已删除供应商: ${result.provider} (${result.poolKey})\n  ${keysNote}`;
  }

  return '供应商配置完成';
}

// ── 2b. 外部软件模型配置(opencode/openclaw/reasonix/deepseek-tui/coze/claude-code)──
// 解析面为纯叶子 nlExternalAppResolver(零 IO·门控 KHY_NL_EXTERNAL_APP);落地经
// externalApps/*Adapter(fail-soft·merge-write·原子写·删除确认闸门·密钥复用 khy 已存)。
// cooperative:true → 仅无模型(Tier A)介入;有模型让路给 configureExternalApp 工具。

const _EXTERNAL_APP_ADAPTERS = {
  reasonix: './externalApps/reasonixAdapter',
  'deepseek-tui': './externalApps/deepseekTuiAdapter',
  opencode: './externalApps/opencodeAdapter',
  openclaw: './externalApps/openclawAdapter',
  coze: './externalApps/cozeAdapter',
  'claude-code': './externalApps/claudeCodeAdapter',
};

function _externalAppAdapter(app) {
  const mod = _EXTERNAL_APP_ADAPTERS[app];
  if (!mod) return null;
  try { return require(mod); } catch { return null; }
}

function _isExternalAppIntent(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 500) return false;
  if (!nlExternalAppResolver) return false;
  // 叶子内门控 + 零假阳性闸门(app 名 + 动作词 + 领域引用三命中);关或不命中 → null → 不接管。
  return nlExternalAppResolver.resolve(text, process.env) != null;
}

function _detectExternalApp(text) {
  if (!nlExternalAppResolver) return null;
  const intent = nlExternalAppResolver.resolve(text, process.env);
  if (!intent) return null;
  const A = { list: '列出', add: '配置', remove: intent.confirmed ? '删除' : '预览删除', get: '查询' };
  const label = `${A[intent.action] || intent.action} ${intent.app}${intent.provider ? ` · ${intent.provider}` : (intent.target ? ` · ${intent.target}` : '')}`;
  return { type: 'external_app_config', category: '外部软件模型配置', label, intent };
}

function _executeExternalApp(plan) {
  const intent = plan && plan.intent;
  if (!intent) return { type: 'external_app_config', success: false, error: '无效的外部软件配置意图' };
  const adapter = _externalAppAdapter(intent.app);
  if (!adapter) return { type: 'external_app_config', success: false, app: intent.app, error: `不支持的外部软件: ${intent.app}` };
  let res;
  if (intent.action === 'list') res = adapter.list(process.env);
  else if (intent.action === 'get') res = adapter.get(intent.target, process.env);
  else if (intent.action === 'add') {
    res = adapter.add({ provider: intent.provider, model: intent.model, apiKey: intent.apiKey, endpoint: intent.endpoint }, process.env);
  } else if (intent.action === 'remove') {
    res = adapter.remove({ target: intent.target, confirmed: intent.confirmed, removeKeys: intent.removeKeys }, process.env);
  } else {
    return { type: 'external_app_config', success: false, error: `未知外部软件配置动作: ${intent.action}` };
  }
  return { type: 'external_app_config', action: intent.action, ...res };
}

function _formatExternalApp(result) {
  if (!result || !result.success) return `外部软件配置失败: ${(result && result.error) || '未知错误'}`;
  const app = result.app || '外部软件';

  if (result.action === 'list') {
    const ps = result.providers || [];
    const lines = ps.length
      ? ps.map((p) => `${p.id}  模型: ${(p.models || [])[0] || '—'}  ${p.endpoint || ''}  ${p.hasKey ? '有密钥' : '无密钥'}`.trim())
      : [`（${app} 暂无已配置模型）${result.note ? ` — ${result.note}` : ''}`];
    return _fmt && _fmt.isEnabled()
      ? _fmt.compose({ title: `${app} 已配置的模型`, sections: [{ lines }], meta: ['外部软件配置', '只读'] })
      : `${app} 已配置的模型：\n  ${lines.join('\n  ')}`;
  }

  if (result.action === 'get') {
    const p = result.provider || {};
    const body = [`软件: ${app}`, `provider: ${p.id}`, `模型: ${(p.models || []).join('、') || '—'}`, p.endpoint ? `接口: ${p.endpoint}` : null, p.hasKey ? '密钥: 已配置' : '密钥: 无'].filter(Boolean);
    return _fmt && _fmt.isEnabled()
      ? _fmt.compose({ title: `${app} · ${p.id} 详情`, sections: [{ lines: body }], meta: ['外部软件配置', '只读'] })
      : `${app} · ${p.id}：\n  ${body.join('\n  ')}`;
  }

  if (result.action === 'add') {
    if (result.degraded) {
      const tip = `${result.note}\n\n${result.suggestedFile ? `建议文件名: ${result.suggestedFile}\n` : ''}${result.yaml || ''}`;
      return _fmt && _fmt.isEnabled()
        ? _fmt.compose({ title: `${app} 配置(需手动放置)`, sections: [{ lines: [result.note] }, { lines: [result.yaml || ''] }], meta: ['外部软件配置', '降级回传'] })
        : tip;
    }
    const body = [
      `软件: ${app}`,
      `provider: ${result.provider}`,
      `模型: ${result.model || '—'}`,
      result.endpoint ? `接口: ${result.endpoint}` : null,
      `密钥: ${result.keyMasked || '—'}（来源: ${result.keySource === 'nl' ? '本次提供' : result.keySource === 'pool' ? '复用 khy 已存' : '无'}）`,
      result.file ? `写入: ${result.file}` : null,
    ].filter(Boolean);
    return _fmt && _fmt.isEnabled()
      ? _fmt.compose({ title: `已给 ${app} 配置模型`, sections: [{ lines: body }], meta: ['外部软件配置', '已执行', '密钥已脱敏'] })
      : `已给 ${app} 配置模型：\n  ${body.join('\n  ')}`;
  }

  if (result.action === 'remove') {
    if (result.preview) {
      const tip = `删除预览(未执行)\n  软件: ${app}\n  provider: ${result.target}\n  ${result.message || ''}`;
      return _fmt && _fmt.isEnabled()
        ? _fmt.compose({ title: '删除预览(未执行)', sections: [{ lines: [`软件: ${app}`, `provider: ${result.target}`] }], meta: ['外部软件配置', '仅预览'], footer: result.message || '' })
        : tip;
    }
    const note = result.keyRemoved ? '密钥已一并删除' : '密钥已保留（可复用）';
    return _fmt && _fmt.isEnabled()
      ? _fmt.compose({ title: `已从 ${app} 删除模型`, sections: [{ lines: [`provider: ${result.target}`, note] }], meta: ['外部软件配置', '已执行'] })
      : `已从 ${app} 删除 provider: ${result.target}\n  ${note}`;
  }

  return '外部软件配置完成';
}

// ── 2b-reverse. 反向使用外部软件里的模型(discover/import → 注册进 khy 消费侧)──────────
// 解析面为纯叶子 nlExternalAppImportResolver(零 IO·门控 KHY_NL_EXTERNAL_APP_IMPORT);发现+注册
// 经 appModelImporter(门控 KHY_EXTERNAL_APP_IMPORT,registrar 可注入,输出全脱敏)。
// cooperative:true → 仅无模型(Tier A)介入;有模型让路给 ImportExternalAppModels 工具。
// **置于 external_app_config 之后、provider_config 之前**:反向闸门更严(app 名 + 反向动词 + 模型域
// 三命中),与正向动词(配置/添加/删除)不重叠,故两 handler 互不接管。

function _isExternalAppImportIntent(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 500) return false;
  if (!nlExternalAppImportResolver) return false;
  return nlExternalAppImportResolver.resolve(text, process.env) != null;
}

function _detectExternalAppImport(text) {
  if (!nlExternalAppImportResolver) return null;
  const intent = nlExternalAppImportResolver.resolve(text, process.env);
  if (!intent) return null;
  const A = { discover: '发现可用模型', import: '导入模型' };
  const scope = intent.all ? '所有外部软件' : (intent.app || '');
  const label = `${A[intent.action] || intent.action}${scope ? ` · ${scope}` : ''}`;
  return { type: 'external_app_import', category: '反向使用外部软件模型', label, intent };
}

function _executeExternalAppImport(plan) {
  const intent = plan && plan.intent;
  if (!intent) return { type: 'external_app_import', success: false, error: '无效的反向导入意图' };
  if (!_appModelImporter) return { type: 'external_app_import', success: false, error: 'appModelImporter 不可用' };
  let res;
  try {
    if (intent.action === 'discover') {
      res = _appModelImporter.discover(intent.app, process.env);
    } else if (intent.action === 'import') {
      res = intent.all
        ? _appModelImporter.importAll({}, process.env)
        : _appModelImporter.importApp({ app: intent.app }, process.env);
    } else {
      return { type: 'external_app_import', success: false, error: `未知反向导入动作: ${intent.action}` };
    }
  } catch (e) {
    return { type: 'external_app_import', success: false, error: String((e && e.message) || e) };
  }
  return { type: 'external_app_import', action: intent.action, all: intent.all === true, ...res };
}

function _formatExternalAppImport(result) {
  if (!result || !result.success) return `反向导入失败: ${(result && result.error) || '未知错误'}`;

  if (result.action === 'discover') {
    const app = result.app || '外部软件';
    const ps = result.providers || [];
    const lines = ps.length
      ? ps.map((p) => `${p.id}  模型: ${(p.models || []).join('、') || '—'}  ${p.endpoint || ''}  ${p.hasKey ? `密钥: ${p.keyMasked}` : '无密钥'}`.trim())
      : [`（${app} 暂无可用模型）`];
    return _fmt && _fmt.isEnabled()
      ? _fmt.compose({ title: `${app} 可反向使用的模型`, sections: [{ lines }], meta: ['反向导入', '只读', '密钥已脱敏'] })
      : `${app} 可反向使用的模型：\n  ${lines.join('\n  ')}`;
  }

  // import / importAll
  const imported = result.imported || [];
  const skipped = result.skipped || [];
  const impLines = imported.length
    ? imported.map((r) => `${r.poolKey}  模型: ${(r.models || [r.defaultModel]).join('、')}  密钥: ${r.keyMasked}（来源: ${r.keySource === 'app' ? '外部软件' : r.keySource === 'pool' ? '复用 khy 已存' : r.keySource}）${r.dryRun ? '  [dryRun]' : ''}`)
    : ['（无可导入的模型）'];
  const skipLines = skipped.map((s) => `${s.app}:${s.provider} — ${s.reason}`);
  const tail = imported.length ? '现在可像使用 codex / claude-code 的模型一样,在 khy 里直接选用这些模型(api:<poolKey>:<model>)。' : '';
  if (_fmt && _fmt.isEnabled()) {
    const sections = [{ lines: impLines }];
    if (skipLines.length) sections.push({ lines: skipLines });
    return _fmt.compose({ title: '已把外部软件模型导入 khy', sections, meta: ['反向导入', '已注册', '密钥已脱敏'], footer: tail });
  }
  const parts = [`已导入 ${imported.length} 个模型：`, `  ${impLines.join('\n  ')}`];
  if (skipLines.length) parts.push(`跳过 ${skipLines.length} 个：\n  ${skipLines.join('\n  ')}`);
  if (tail) parts.push(tail);
  return parts.join('\n');
}

module.exports = {
  // ── 三张注册表消费的处理器(localBrainService 以同名别名 re-export 接回,契约字节不变) ──
  // provider_config
  _isProviderCfgIntent,
  _detectProviderCfg,
  _executeProviderCfg,
  _formatProviderCfg,
  // key_update(alwaysDeterministic:true·复用 _execProviderAdd 写入链)
  _isKeyUpdateIntent,
  _detectKeyUpdate,
  _execKeyUpdate,
  // external_app_config
  _isExternalAppIntent,
  _detectExternalApp,
  _executeExternalApp,
  _formatExternalApp,
  // external_app_import(反向导入)
  _isExternalAppImportIntent,
  _detectExternalAppImport,
  _executeExternalAppImport,
  _formatExternalAppImport,
  // ── 内部实现细节(供叶子级单测 + 既有链复用引用) ──
  _slugifyPoolKey,
  _resolveProviderPoolKey,
  _maskKeyText,
  _execProviderList,
  _execProviderAskWhich,
  _execProviderAdd,
  _listConfiguredPoolKeys,
  _execProviderRemove,
  _externalAppAdapter,
};
