'use strict';

/**
 * toolClusterActivation.js — 纯叶子:按用户输入信号预激活「延迟工具簇」(工具发现层的
 * **前摄收敛机制**)。
 *
 * 背景(khyos 自审报告 #4「工具发现成本高」):30 个工具标 shouldDefer(默认不进定义,
 * 靠 ToolSearch 关键词现搜现揭示)。真痛点在 **AgentContext 作用域路径**
 * (getDefinitionsForContext + _filterDeferredForContext):子代理起手拿到的是过滤掉延迟工具的
 * 精简定义,要用某个能力必须先 ToolSearch 命中——而 toolSearch 关键词召回不稳(报告原话
 * 「返回的大多是被 defer 的工具」),于是「明明该用浏览器/编译器却发现不了」。方向(报告):
 * **按任务类型自动预激活工具簇**(如「图片路径 → image_detect/imageOcr」)。
 *
 * 本叶子把「信号 → 工具名簇」的映射变成**确定式纯函数**:给定一段用户文本 + env,返回一组
 * **该被提前揭示的延迟工具名**(仅名字,零 registry 访问、零 IO)。调用侧(coordinator 的
 * 起手接缝)据此对每个名字调 ensureToolForContext(name, agentCtx) 预揭示——幂等、可字节回退。
 *
 * 设计取舍:
 *   - **只揭示、不隐藏**:预激活是加法(把延迟工具提前放进上下文),绝不移除任何已有工具,
 *     故门控关或误判时最坏是「少揭示一个」,回退到今日「靠 ToSearch 现搜」行为,零破坏。
 *   - **低假阳优先**:每簇的触发词是**能力专有词**(浏览器/编译/密钥配置…),不用通用动词
 *     (做/跑/看)避免无差别揭示 30 个工具反而稀释上下文——那等于没 defer。
 *   - **返回 registry 里真实存在的延迟工具名**:名字写死在此表,守卫测试用真实 registry
 *     锁死「每个簇里的名字都确实是可延迟工具」,防漂移(工具改名/去 defer 而此表不更新)。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛。门控 KHY_TOOL_CLUSTER_ACTIVATION(默认开,仅
 * 0/false/off/no 关;关 → 返 [] 让调用方字节回退到不预激活)。异常输入 → 返 [],绝不抛。
 *
 * @module services/toolClusterActivation
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 激活门控。优先 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isActivationEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_TOOL_CLUSTER_ACTIVATION', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_TOOL_CLUSTER_ACTIVATION;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 工具簇声明式表(SSOT)。每簇:
 *   - id:簇名(稳定,守卫/日志用)
 *   - tools:该簇要预激活的**延迟工具真实名**(守卫锁死其确为 shouldDefer 工具)
 *   - patterns:触发正则(能力专有词,中英双语,大小写不敏感由 RegExp i 标志保证)
 *
 * 只覆盖「有独立触发信号、且延迟」的能力;纯内部/agentic 工具(Artifact/Brief/Snip/Sleep/
 * TodoWrite/VerifyPlanExecution/ReviewArtifact/SendUserFile/TaskOutput/KillShell/
 * SyntheticOutput/createTool)不在此列——它们没有用户可辨的自然语言触发词,强行映射只会假阳。
 */
const TOOL_CLUSTERS = [
  {
    id: 'web-browse',
    tools: ['WebBrowser', 'webSearch'],
    patterns: [
      /浏览器/, /打开网页/, /访问网站/, /网页/, /上网/,
      /\bbrowser\b/i, /\bnavigate\b/i, /open\s+(the\s+)?url/i, /web\s*page/i,
    ],
  },
  {
    id: 'web-search',
    tools: ['webSearch'],
    patterns: [
      /联网搜/, /网上查/, /搜一下/, /搜索一下/, /查一下.*最新/, /上网查/,
      /search\s+(the\s+)?web/i, /\bweb\s*search\b/i, /latest\s+news/i, /google\s+it/i,
    ],
  },
  {
    id: 'compile',
    tools: ['compile_file'],
    patterns: [
      /编译/, /构建.*(文件|代码|程序)/,
      /\bcompile\b/i, /\bgcc\b/i, /\bg\+\+/i, /\brustc\b/i, /\bjavac\b/i, /\btsc\b/i,
    ],
  },
  {
    id: 'model-config',
    tools: ['configureModelProvider'],
    patterns: [
      /配置.*(模型|供应商|厂商|网关)/, /(添加|新增|设置|更换).*(模型|密钥|api\s*key)/i,
      /api\s*key/i, /密钥/, /配置\s*provider/i,
      /configure\s+(the\s+)?(model|provider)/i, /add\s+(a\s+)?model/i,
    ],
  },
  {
    id: 'package-search',
    tools: ['registrySearch'],
    patterns: [
      /查.*(npm|pypi|包|依赖库)/i, /搜.*(npm|pypi|package|依赖)/i, /有没有.*(库|package|包)/i,
      /\bnpm\b/i, /\bpypi\b/i, /package\s+registry/i, /open\s*source.*(library|package)/i,
    ],
  },
  {
    id: 'desktop-control',
    tools: ['DesktopControl', 'TerminalCapture'],
    patterns: [
      /桌面.*(操作|控制|截图)/, /截屏/, /屏幕截图/, /模拟(鼠标|键盘|点击)/, /自动(点击|填表)/,
      /\bscreenshot\b/i, /\bdesktop\s+control/i, /mouse\s+click/i, /keyboard\s+type/i, /fill\s+(the\s+)?form/i,
    ],
  },
  {
    id: 'workflow',
    tools: ['Workflow'],
    patterns: [
      /工作流/, /流水线/, /编排.*(任务|流程|代理)/,
      /\bworkflow\b/i, /\bpipeline\b/i, /automation\s+sequence/i,
    ],
  },
  {
    id: 'remote-trigger',
    tools: ['RemoteTrigger'],
    patterns: [
      /远程触发/, /webhook/i, /回调地址/, /触发信号/,
      /remote\s+trigger/i, /\bwebhook\b/i,
    ],
  },
  {
    id: 'repl-eval',
    tools: ['REPL'],
    patterns: [
      /执行.*(js|javascript|node)\s*代码/i, /跑一段\s*(js|javascript|node)/i, /求值/,
      /\brepl\b/i, /evaluate\s+(some\s+)?(js|javascript|node)/i, /run\s+.*\bnode\b\s+code/i,
    ],
  },
  {
    id: 'team',
    tools: ['TeamCreate', 'TeamDelete'],
    patterns: [
      /(创建|新建|组建).*(团队|队友|协作代理)/, /并行代理/, /多代理协作/,
      /\bteammate\b/i, /parallel\s+agent/i, /create\s+(a\s+)?team\b/i,
    ],
  },
  {
    id: 'self-update',
    tools: ['khyUpdate'],
    patterns: [
      /(更新|升级)\s*khy/i, /khy.*(更新|升级|新版本)/i, /检查.*(khy).*版本/i,
      /update\s+khy/i, /upgrade\s+khy/i,
    ],
  },
  {
    id: 'lsp',
    tools: ['LSP'],
    patterns: [
      /跳转.*(定义|引用)/, /查找.*(符号|引用|定义)/, /重命名符号/,
      /language\s+server/i, /\blsp\b/i, /go\s+to\s+definition/i, /find\s+references/i, /rename\s+symbol/i,
    ],
  },
  {
    id: 'monitor',
    tools: ['Monitor', 'BashOutput'],
    patterns: [
      /监控.*(进程|命令|后台)/, /盯着.*(输出|进程)/, /持续观察/,
      /monitor\s+(the\s+)?(process|command)/i, /watch\s+process/i,
    ],
  },
  {
    id: 'powershell',
    tools: ['PowerShell'],
    patterns: [
      /powershell/i, /pwsh/i, /ps1\s*脚本/i,
    ],
  },
];

/** 稳定字符串化输入文本(非字符串 → '')。 */
function _text(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try { return String(v); } catch { return ''; }
}

/**
 * 判断单簇是否被文本命中(任一 pattern 命中即算)。
 * @param {{patterns: RegExp[]}} cluster
 * @param {string} text
 * @returns {boolean}
 */
function _clusterMatches(cluster, text) {
  if (!cluster || !Array.isArray(cluster.patterns)) return false;
  for (const re of cluster.patterns) {
    try {
      if (re instanceof RegExp && re.test(text)) return true;
    } catch { /* 单个正则异常不影响其余 */ }
  }
  return false;
}

/**
 * 依据用户输入选出应预激活的延迟工具名(去重、确定式排序)。
 *
 * @param {string} text  用户输入(或本轮 prompt 文本)
 * @param {object} [opts]
 * @param {object} [opts.env]  环境(测试注入);缺省 process.env
 * @returns {string[]}  应 ensureToolForContext 的工具名(门控关/无命中/异常 → [])
 */
function selectToolsToActivate(text, opts = {}) {
  try {
    const env = (opts && opts.env) || process.env;
    if (!isActivationEnabled(env)) return [];
    const s = _text(text);
    if (!s) return [];
    const picked = new Set();
    for (const cluster of TOOL_CLUSTERS) {
      if (_clusterMatches(cluster, s)) {
        for (const name of cluster.tools) picked.add(name);
      }
    }
    return Array.from(picked).sort();
  } catch { return []; }
}

/**
 * 诊断版:返回命中的簇及其工具(供守卫/调试;不受门控影响,纯映射)。
 * @param {string} text
 * @returns {Array<{id:string, tools:string[]}>}
 */
function matchClusters(text) {
  try {
    const s = _text(text);
    if (!s) return [];
    const out = [];
    for (const cluster of TOOL_CLUSTERS) {
      if (_clusterMatches(cluster, s)) out.push({ id: cluster.id, tools: cluster.tools.slice() });
    }
    return out;
  } catch { return []; }
}

/** 全部声明的延迟工具名(去重),供守卫用真实 registry 核对。 */
function declaredClusterTools() {
  const set = new Set();
  for (const cluster of TOOL_CLUSTERS) {
    for (const name of cluster.tools) set.add(name);
  }
  return Array.from(set).sort();
}

module.exports = {
  isActivationEnabled,
  selectToolsToActivate,
  matchClusters,
  declaredClusterTools,
  TOOL_CLUSTERS,
};
