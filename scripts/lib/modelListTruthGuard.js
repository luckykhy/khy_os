'use strict';

/**
 * modelListTruthGuard.js — 「模型列表真值接线」的机器强制守卫(零 IO / 确定性 / 绝不抛)。
 *
 * 背景([DESIGN-ARCH-100])：
 *   适配器的 listModels() 只是**候选池**——上游 remote 记录与静态目录(builtin)、本机扫描
 *   (local)、env 逗号串(hint) 混在一个数组里。真值收敛发生在 `aiGateway.listModels()`
 *   这一个咽喉点上(modelListTruth)。凡是绕开它、直接调适配器 listModels() 的入口,都会把
 *   猜测条目当可调用模型展示给用户 —— 选中即 model_not_found。这类越权接线在代码评审里
 *   极难发现（读起来完全合理：「我就是要这个 IDE 的模型」），所以必须由机器在提交时点名。
 *
 * 两条规则（零误报是底线,故只取高价值不变量）：
 *   1. direct-adapter-listmodels（error）：业务代码 `require` 了某个 gateway 适配器，又自己
 *      调 `.listModels(` —— 必须改走 `aiGateway.listModels(key)`（经 curation + 真值律）。
 *      适配器自身目录、aiGateway / modelCuration / modelListTruth 与测试文件不参评。
 *   2. static-catalog-unlabeled（warning）：适配器里存在静态模型目录常量
 *      （KNOWN_MODELS / FALLBACK_MODELS / BASELINE_MODELS / STATIC_MODELS / DEFAULT_MODELS），
 *      但该文件既没有打 `discoverySource` 标记、也没有经 `buildModelList(` 统一打标 ——
 *      那这份目录会按「无标记 = 可信」被真值律放过，从而绕过上游权威覆盖律。
 *
 * 用法见 scripts/ci/check-model-list-truth.js。本守卫自身零 IO、不触碰文件系统。
 */

// ── 门控（默认开,仅 0/false/off/no 关）─────────────────────────────────
const OFF = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_MODEL_LIST_TRUTH_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

// ── 参评范围 ────────────────────────────────────────────────────────────
const LEAF_RULE_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.vue']);

// 允许直连适配器 listModels 的实现层（它们**就是**咽喉点本身或咽喉点的组成）。
const ALLOWED_PATH_FRAGMENTS = [
  'services/gateway/adapters/',
  'services/gateway/aiGateway',
  'services/gateway/modelCuration',
  'services/gateway/modelListTruth',
  // modelCatalogGraph 是「多枢轴目录视图」的读层:它需要 apiAdapter 的**原始行**
  // (含 `api:<poolKey>:<model>` 复合 id)才能按 provider 分桶,curation / 真值律
  // 对它无意义(它是超集视图,不是选择面)。登记在册,避免每次误报。
  'services/gateway/modelCatalogGraph',
];

// 静态模型目录常量的命名形态。
const STATIC_CATALOG_RE = /\b(?:KNOWN|FALLBACK|BASELINE|STATIC|DEFAULT)_MODELS\b/;

// 绕过咽喉点的**具名适配器直连**形态:`windsurfAdapter.listModels()` / `apiAdapter.listModels()`。
// 刻意**不**匹配 `gw.listModels()` / `aiGateway.listModels()` —— 那是我们要求的正确接线,
// 误报它只会让人把守卫关掉,而「守卫被关」等于规则不存在。
const NAMED_ADAPTER_LIST_MODELS_RE = /[A-Za-z_$][\w$]*[Aa]dapter\s*\.\s*listModels\s*\(/;
// 已正确接线/已打标的信号。
const DISCOVERY_SOURCE_RE = /discoverySource/;
const BUILD_MODEL_LIST_RE = /buildModelList\s*\(/;

function fileExt(relPath) {
  const base = String(relPath || '');
  const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  const name = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function normalizePath(relPath) {
  return String(relPath || '').replace(/\\/g, '/');
}

function isTestFile(relPath) {
  const p = normalizePath(relPath);
  return /(?:^|\/)tests?\//.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p) || /\.spec\.[cm]?[jt]sx?$/.test(p);
}

function isImplementationFile(relPath) {
  const p = normalizePath(relPath);
  return ALLOWED_PATH_FRAGMENTS.some((frag) => p.includes(frag));
}

/** 剥除注释后的代码文本（简单状态机,保守：宁可多留代码也不误删）。 */
function codeOnly(source) {
  const lines = String(source || '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    let code = '';
    let j = 0;
    while (j < raw.length) {
      if (inBlock) {
        const close = raw.indexOf('*/', j);
        if (close < 0) {
          j = raw.length;
          break;
        }
        j = close + 2;
        inBlock = false;
        continue;
      }
      const lineComment = raw.indexOf('//', j);
      const blockOpen = raw.indexOf('/*', j);
      if (lineComment >= 0 && (blockOpen < 0 || lineComment < blockOpen)) {
        code += raw.slice(j, lineComment);
        j = raw.length;
        break;
      }
      if (blockOpen >= 0) {
        code += raw.slice(j, blockOpen);
        inBlock = true;
        j = blockOpen + 2;
        continue;
      }
      code += raw.slice(j);
      j = raw.length;
    }
    out.push(code);
  }
  return out.join('\n');
}

/**
 * 评估单个文件。纯函数:零 IO、绝不抛。
 * @param {object} args
 * @param {string} args.relPath
 * @param {string} args.source
 * @param {object} [args.env]
 * @returns {{findings: Array<{severity:string, rule:string, line:number, message:string, snippet:string}>}}
 */
function assessFile({ relPath = '', source = '', env } = {}) {
  const findings = [];
  try {
    if (!isEnabled(env)) {
      return { findings };
    }
    const text = String(source || '');
    if (!text) {
      return { findings };
    }
    if (!LEAF_RULE_EXTS.has(fileExt(relPath))) {
      return { findings };
    }
    if (isTestFile(relPath)) {
      return { findings };
    }
    const lines = text.split(/\r?\n/);
    const codeLines = codeOnly(text).split(/\r?\n/);

    // ── 规则 1：绕开 aiGateway.listModels 的直连（error）────────────────
    if (!isImplementationFile(relPath)) {
      // 只盯**具名适配器**的直连(`windsurfAdapter.listModels()` / `apiAdapter.listModels()`),
      // 不盯 `gw.listModels()` / `aiGateway.listModels()` —— 后者正是我们要求的正确接线,
      // 把两者都算违规会产生 100% 误报从而让守卫被关掉(守卫被关 = 规则等于不存在)。
      const codeText = codeLines.join('\n');
      if (NAMED_ADAPTER_LIST_MODELS_RE.test(codeText)) {
        // 行号按**剥注释后**的行定位(codeOnly 与原文逐行 1:1),否则会指到注释里的同名词。
        const hit = codeLines.findIndex((l) => NAMED_ADAPTER_LIST_MODELS_RE.test(l));
        findings.push({
          severity: 'error',
          rule: 'direct-adapter-listmodels',
          line: hit >= 0 ? hit + 1 : 1,
          message:
            '这里 require 了 gateway 适配器并直接调 .listModels(),绕开了真值咽喉点 aiGateway.listModels(key) —— ' +
            '拿到的只是「候选池」(含静态目录 / 本机扫描的猜测条目),展示给用户就是「选了就 404」。' +
            '改用 aiGateway.listModels(key),或显式套一层 modelCuration.applyOverrides + modelListTruth.filterByUpstreamAuthority。' +
            '([DESIGN-ARCH-100] §四)',
          snippet: (lines[hit >= 0 ? hit : 0] || '').trim().slice(0, 100),
        });
      }
    }

    // ── 规则 2：静态目录未打标（warning）───────────────────────────────
    if (normalizePath(relPath).includes('services/gateway/adapters/')) {
      const codeText = codeLines.join('\n');
      if (STATIC_CATALOG_RE.test(codeText) && !DISCOVERY_SOURCE_RE.test(codeText) && !BUILD_MODEL_LIST_RE.test(codeText)) {
        const hit = lines.findIndex((l) => STATIC_CATALOG_RE.test(l));
        findings.push({
          severity: 'warning',
          rule: 'static-catalog-unlabeled',
          line: hit >= 0 ? hit + 1 : 1,
          message:
            '本文件有硬编码的静态模型目录,但既没有打 discoverySource 标记、也没有经 buildModelList() 统一打标 —— ' +
            '真值律会按「无标记 = 可信」放过它,从而绕过上游权威覆盖律。请给这些条目打上 discoverySource: \'builtin\'。' +
            '([DESIGN-ARCH-100] §3.1)',
          snippet: (lines[hit >= 0 ? hit : 0] || '').trim().slice(0, 100),
        });
      }
    }

    return { findings };
  } catch {
    return { findings };
  }
}

module.exports = {
  isEnabled,
  LEAF_RULE_EXTS,
  fileExt,
  normalizePath,
  isTestFile,
  isImplementationFile,
  codeOnly,
  assessFile,
};
