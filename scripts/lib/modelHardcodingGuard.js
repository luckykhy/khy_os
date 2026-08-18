'use strict';

/**
 * modelHardcodingGuard.js — 「模型名称单一真源」的机器强制守卫(goal 2026-06-26
 * 续句「…如果有其他类似模型名称这样,以后可能会修改硬编码,改一处,处处该改的需要修复」)。
 *
 * 背景:模型名称已收归唯一真源 `services/backend/src/constants/models.js`(按角色/档位
 * 建具名数组,首项=当前生效首选);调用点引用数组名 / `PRIMARY.<role>` 而非裸模型 id
 * 字符串,换模型只改 models.js 一处。但「单一真源」一旦只靠人自觉就会熵增:弱模型
 * 「修个 bug / 加个分支」时顺手把 `claude-opus-4-8` 这样的字面量又敲回业务逻辑里,
 * 于是再次出现「改一处、处处漏」的退化。本守卫把这条纪律变成确定性机器检查 ——
 * 谁在**非数据文件**里写下受监视的模型名字面量,提交时(pre-commit →
 * check:small-model:safety)立刻被点名挡回。这就是「差距代码化」:单一真源不再只活
 * 在强模型脑子里,而是被门禁固化。
 *
 * 与既有守卫正交互补(同一「弱模型维护防退化」族):
 *   - leafContractGuard.js  看「自声明纯叶子是否仍守住零 IO / 门控 / fail-soft」;
 *   - check-agent-rules.js  看通用反模式(硬编码端点 / 模糊状态 / 硬超时 kill);
 *   - 本守卫                 看「受监视的模型名是否又被硬编码进逻辑」。
 *
 * 监视名单(watch-set):**直接从 SSOT 派生** —— 把 constants/models.js 各导出数组里的
 * 全部字符串收成集合。新增/换模型只改 models.js,监视名单自动跟随,无需改本守卫。
 *
 * 零误报判据(底线,经现存全树验证):一处字面量被判违规,当且仅当
 *   1) 它是**独立量化字面量** `(['"`])\s*<受监视名>\s*\1`(引号内只含该名,允许两侧空白)
 *      —— 句子里**提到**模型名(如帮助串 `RELAY_API_MODEL=claude-...`)不是独立字面量,不报;
 *   2) 它出现在**非注释代码**里(注释 / docstring 里的模型名不报);
 *   3) 它所在文件不在数据白名单 DATA_FILES 内 —— 网关 catalog / pricing / alias-map /
 *      capability-list 等**描述性数据**(三桶判据的 A 桶)合法地以字面量罗列多模型属性,
 *      不是「Khy 自己选哪个模型」的逻辑,故整文件豁免。SSOT 自身亦在白名单(它就是真源)。
 * 这样在大多数**业务逻辑文件**里,任何受监视模型名字面量都会被精确拦下,而数据文件零误报。
 *
 * 纯叶子:零 IO、确定性、绝不抛、可单测。watch-set 由调用方读入后以参数传入(loadWatchedNames
 * 帮助函数在 CLI 侧做 require,本评估函数不碰 IO)。env 门控 KHY_MODEL_HARDCODING_GUARD
 * (默认开,仅显式 0/false/off/no 关闭;关闭后 assessFile 返回空 findings)。
 */

// ── env 门控(默认开,仅 0/false/off/no 关)─────────────────────────────
const OFF = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_MODEL_HARDCODING_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

// ── 数据白名单(A 桶:catalog / pricing / alias-map / capability-list / SSOT)──
// 以 `src/` 之后的相对后缀匹配,故无论从仓库根还是 backend 根扫描都成立。整文件豁免:
// 这些文件以字面量罗列多模型的属性(价格 / 能力 / 别名 / 推荐),是描述性数据而非
// 「Khy 选用哪个模型」的逻辑。新增同类数据文件时把后缀加到这里(并在 PR 说明它是数据)。
const DATA_FILE_SUFFIXES = [
  // 单一真源本身
  'src/constants/models.js',
  // 评分 / 能力映射(键=模型 id,描述各模型属性)
  'src/cli/ai.js',
  // 网关别名表 + 各 pool 默认模型数据映射
  'src/services/gateway/aiGateway.js',
  'src/services/gateway/adapters/apiAdapter.js',
  // 各 IDE / 云厂商适配器的模型 catalog(id/name/tier/isDefault 条目)
  'src/services/gateway/adapters/claudeAdapter.js',
  'src/services/gateway/adapters/codexAdapter.js',
  'src/services/gateway/adapters/cursorAdapter.js',
  'src/services/gateway/adapters/kiroAdapter.js',
  'src/services/gateway/adapters/ollamaAdapter.js',
  'src/services/gateway/adapters/traeAdapter.js',
  'src/services/gateway/adapters/vscodeAdapter.js',
  'src/services/gateway/adapters/windsurfAdapter.js',
  // 内置 provider → 广告模型清单
  'src/services/gateway/builtinProviderConfig.js',
  // 代理广告的默认模型清单 / 视觉能力模型子串清单
  'src/services/gateway/proxyServer.js',
  'src/services/gateway/visionCapability.js',
  // 硬件 / Ollama 推荐 catalog
  'src/services/hardwareProfileService.js',
  'src/services/ollamaModelManager.js',
  // 免费层 provider 的 availableModels catalog（backend 与 khyquant 应用镜像）
  'src/services/multiFreeService.js',
  'software/khyquant/services/multiFreeService.js',
  // 计费价格表(键=模型 id)
  'src/services/usageFormatter.js',
  'src/services/usageTracker.js',
];

/** 路径是否属于数据白名单(后缀匹配,正反斜杠归一)。 */
function isDataFile(relPath, suffixes = DATA_FILE_SUFFIXES) {
  const p = String(relPath || '').replace(/\\/g, '/');
  return suffixes.some((s) => p === s || p.endsWith('/' + s) || p.endsWith(s));
}

/**
 * 从 models.js 导出对象派生受监视名单:收集每个数组导出里的全部非空字符串。
 * fail-soft:传入坏值或 require 失败时返回空数组(本函数本身不做 require,IO 留 CLI)。
 * @param {object} modelsModule  require('.../constants/models') 的结果
 * @returns {string[]}  去重后的受监视模型名
 */
function deriveWatchedNames(modelsModule) {
  const out = new Set();
  if (!modelsModule || typeof modelsModule !== 'object') return [];
  for (const value of Object.values(modelsModule)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) out.add(entry);
    }
  }
  return [...out];
}

/** 正则转义。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 由受监视名单编译「独立量化字面量」匹配器。长名优先以免短名抢匹配(虽然闭合引号
 * 已保证整段匹配,排序仍稳妥)。返回带 g 标志的 RegExp,或 null(空名单)。
 * @param {string[]} names
 */
function buildLiteralMatcher(names) {
  const list = (names || []).filter((n) => typeof n === 'string' && n.trim());
  if (list.length === 0) return null;
  const alt = list.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  // 引号(单/双/反引号)+ 可选空白 + 受监视名 + 可选空白 + 同种引号(反向引用)。
  return new RegExp('([\'"`])\\s*(' + alt + ')\\s*\\1', 'g');
}

/**
 * 逐行剥注释:返回每行 { no, text, code }。code 为剥除行注释与块注释后的
 * 代码片段(用于只在「非注释代码」中检索字面量,避免注释 / docstring 里的模型名误判)。
 * 简单状态机跟踪块注释开合;不做字符串感知(对本守卫用途足够且偏保守)。
 * @param {string} source
 */
function classifyLines(source) {
  const lines = String(source || '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let code = '';
    let j = 0;
    while (j < raw.length) {
      if (inBlock) {
        const close = raw.indexOf('*/', j);
        if (close < 0) { j = raw.length; break; }
        j = close + 2;
        inBlock = false;
        continue;
      }
      const lineComment = raw.indexOf('//', j);
      const blockOpen = raw.indexOf('/*', j);
      let next = -1;
      let isLine = false;
      if (lineComment >= 0 && (blockOpen < 0 || lineComment < blockOpen)) { next = lineComment; isLine = true; }
      else if (blockOpen >= 0) { next = blockOpen; isLine = false; }
      if (next < 0) { code += raw.slice(j); j = raw.length; break; }
      code += raw.slice(j, next);
      if (isLine) { j = raw.length; break; }
      inBlock = true;
      j = next + 2;
    }
    out.push({ no: i + 1, text: raw, code });
  }
  return out;
}

/**
 * 评估单个文件,返回模型名硬编码 findings。纯函数:零 IO、绝不抛。
 * @param {object} args
 * @param {string} args.relPath        仓库相对路径(用于白名单匹配与 finding 展示)
 * @param {string} args.source         文件全文
 * @param {string[]} args.watchedNames 受监视模型名(由 deriveWatchedNames 得到)
 * @param {string[]} [args.dataFileSuffixes]  覆盖数据白名单(测试用)
 * @param {object} [args.env]
 * @returns {{ findings: Array<{severity:'error', rule:string, line:number, message:string, snippet:string}> }}
 */
function assessFile({ relPath = '', source = '', watchedNames = [], dataFileSuffixes, env } = {}) {
  if (!isEnabled(env)) return { findings: [] };
  const findings = [];
  const text = String(source || '');
  if (!text) return { findings };
  // 数据文件整文件豁免(含 SSOT 自身)。
  if (isDataFile(relPath, dataFileSuffixes || DATA_FILE_SUFFIXES)) return { findings };

  const matcher = buildLiteralMatcher(watchedNames);
  if (!matcher) return { findings };

  for (const l of classifyLines(text)) {
    if (!l.code) continue;
    matcher.lastIndex = 0;
    let m;
    const seenOnLine = new Set();
    while ((m = matcher.exec(l.code)) !== null) {
      const name = m[2];
      if (seenOnLine.has(name)) continue;
      seenOnLine.add(name);
      findings.push({
        severity: 'error',
        rule: 'model-hardcoding',
        line: l.no,
        message:
          `模型名 "${name}" 被硬编码进逻辑。模型名称的唯一真源是 ` +
          `services/backend/src/constants/models.js —— 请改引用对应数组名或 ` +
          `PRIMARY.<role>,这样换模型只改 models.js 一处,不会「改一处、处处漏」。` +
          `(若此处确为模型属性数据 catalog/pricing/alias,请把文件加入守卫的数据白名单。)`,
        snippet: l.text.trim().slice(0, 100),
      });
    }
  }

  return { findings };
}

module.exports = {
  isEnabled,
  isDataFile,
  deriveWatchedNames,
  buildLiteralMatcher,
  classifyLines,
  assessFile,
  DATA_FILE_SUFFIXES,
};
