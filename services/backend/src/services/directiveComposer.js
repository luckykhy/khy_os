'use strict';

/**
 * directiveComposer.js — 系统提示词「意图指令」整合层(单一真源)
 *
 * 背景(为什么有这个文件):
 *   cli/ai.js 在 compute 期由约 16 个**彼此正交的纯叶子**各自识别用户意图,产出一段要注入
 *   系统提示词的「指令」(mathSolve / philosophyDesign / nlAction / errorEnumeration / …)。
 *   历史上 inject 期是一堵**扁平拼接墙**:每个叶子一行 `if (d) sp += '\n\n' + d`,固定源码
 *   顺序、无优先级、无冲突协调。当多路意图同时命中(图+数学题+哲学段),模型会收到一堆等
 *   权的「你必须先做 X」指令块,只能挑一个——这就是「功能堆砌、无法贯通」的物理形态。
 *
 *   本叶子是**整合层**:把已经算好的若干 directive 按「类别(tier)」编排,并在**多套工作流
 *   协议同时生效**时插入一段确定性的「协调头」,把零散指令显式串成一套有次序的执行计划,
 *   让模型不再「挑一个忽略其余」。它**不识别意图、不改任何叶子的文本**——只负责「怎么组合」。
 *
 * 纯叶子契约:
 *   - 零 I/O、无随机、无时钟、确定性。
 *   - **绝不抛**:任何异常 → 回退到等价「门控关」的 join 拼接(fail-soft)。
 *   - **门控 KHY_DIRECTIVE_COMPOSER 默认开**;关闭 → 逐字节回退到历史拼接顺序与内容。
 *
 * 单一真源:所有「指令类别 / 编排次序 / 协调头文案」只在本文件,绝不散写进 ai.js。
 */

// ───────────────────────────────────────────────────────────────────────────
// SSOT:每个 directive key → { tier, label }
//
// tier 语义:
//   'guard'    约束 / 真值 / 护栏类——告诉模型「别做什么 / 必须采用这个事实」。这类先注入,
//              因为它们是后续工作流的前提(真值、护栏在前,工作流在后)。
//   'protocol' 规定工作流类——告诉模型「这一类任务要按什么步骤做」。这类后注入(end-salience),
//              且当 ≥2 个同时生效时由协调头统一编排。
//
// 列表顺序即「同 tier 内的确定性相对顺序」,与历史 ai.js inject 顺序一致(零意外重排)。
// ───────────────────────────────────────────────────────────────────────────
const DIRECTIVE_REGISTRY = Object.freeze({
  // —— guard:真值 / 护栏,先注入 ——
  // intentAssurance 是「用户真实意图」这条最根本的真值(主目标 + 硬约束 + 必保锚点),
  // 因此排在所有 guard 之首:它是后续一切工作流协议都必须服务/遵守的前提。历史上它被
  // 单独注入在整合层之后(=「贯通」缺口:用户真实意图与协调计划脱节),现纳入整合层作
  // 为领头 guard,让协调头之下的多套协议显式地为「这个主目标 + 这些约束」服务。
  intentAssurance:      { tier: 'guard',    label: '意图保护(用户主目标 / 硬约束 / 必保锚点——一切协议都为它服务)' },
  groundTruth:          { tier: 'guard',    label: '地面真值(算术/进制已精确算出,直接采用勿重算)' },
  deterministicFacts:   { tier: 'guard',    label: '确定性真值(单位/常数/定理权威值,直接采用)' },
  inlineImageOcrGuard:  { tier: 'guard',    label: '内联图片路径护栏(禁 DIY-OCR / 反复 Read)' },
  searchNecessity:      { tier: 'guard',    label: '联网搜索必要性(该搜/不该搜)' },
  changeWatch:          { tier: 'guard',    label: 'khy 自身改动回核(对/不对/无法判断)' },
  installConfigGuard:   { tier: 'guard',    label: '配置 khy vs 安装第三方工具歧义护栏(别装第三方、把参数映射到 khy)' },

  // —— protocol:工作流协议,后注入并参与协调 ——
  intent:               { tier: 'protocol', label: '意图模式(goal/coding/analyze/…)' },
  multimodalIntent:     { tier: 'protocol', label: '多模态分路消歧(勿混淆/勿丢弃任一路)' },
  promptIntentRepair:   { tier: 'protocol', label: '奔赴真实意图(先结合语境纠错复述)' },
  clarification:        { tier: 'protocol', label: '选项卡澄清(把真实需求选出来)' },
  diskCleanupClarify:   { tier: 'protocol', label: '清盘参数澄清(扫描深度/颗粒细度交用户选)' },
  mathSolve:            { tier: 'protocol', label: '数学解题协议(分步+精确值+回代自检)' },
  testWriting:          { tier: 'protocol', label: '测试编写协议(对齐框架+成体系覆盖+确定性+跑出证据)' },
  errorEnumeration:     { tier: 'protocol', label: '先枚举再修复(列全错误清单再逐个修)' },
  nlConfig:             { tier: 'protocol', label: '自然语言改设置(直接调 Configure)' },
  nlAction:             { tier: 'protocol', label: '自然语言驱动动作(找/修自身 bug、学开源)' },
  philosophyDesign:     { tier: 'protocol', label: '哲学→软件类比落地' },
  laziness:             { tier: 'protocol', label: '最小代码方法论(懒人阶梯)' },
  goal:                 { tier: 'protocol', label: '持久目标(朝目标持续推进)' },
  // 收尾格式协议:实质工程任务完成后按「根因/改动/验证」三段式收尾。排在末位——它规范的是
  // 「所有工作做完后怎么呈现总结」,天然是最后一环。
  deliverySummaryFormat: { tier: 'protocol', label: '收尾总结格式(根因/改动/验证三段式)' },
});

// tier 注入次序:guard 在前,protocol 在后。
const TIER_ORDER = Object.freeze(['guard', 'protocol']);

/**
 * 门控判定:KHY_DIRECTIVE_COMPOSER 默认开;options.directiveComposer 可覆盖。
 * 关闭 → composeDirectives 走逐字节回退(纯 join)。
 * @param {object} [options]
 * @returns {boolean}
 */
function _enabled(options = {}) {
  if (options && options.directiveComposer !== undefined) {
    return !['0', 'false', 'off', 'no'].includes(
      String(options.directiveComposer).trim().toLowerCase()
    );
  }
  const raw = String(process.env.KHY_DIRECTIVE_COMPOSER || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * 等价「门控关」的拼接:过滤空串后按入参顺序用空行连接。
 * 这是历史 ai.js inject 行为的逐字节复刻(每块之间 '\n\n')。
 * @param {Array<{directive:string}>} entries
 * @returns {string}
 */
function _legacyJoin(entries) {
  return entries
    .map(e => String((e && e.directive) || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 构建「多协议协调头」:当本回合 ≥2 套工作流协议同时生效时,显式告诉模型
 * 「这些协议都生效、按列出的次序协调执行、绝不只挑一个、绝不相互忽略」。
 *
 * 确定性模板:只消费已知 label(来自 SSOT,非用户输入),无随机/时钟,绝不回显用户文本。
 * @param {string[]} protocolLabels  本回合生效的 protocol label(按注入次序)
 * @returns {string}
 */
function buildCoherenceHeader(protocolLabels = []) {
  const labels = (Array.isArray(protocolLabels) ? protocolLabels : [])
    .map(s => String(s || '').trim())
    .filter(Boolean);
  const lines = [];
  lines.push('## 本回合有多套处理协议同时生效 —— 请「贯通」执行,勿只挑其一');
  lines.push('本次输入同时命中了下列处理协议。它们**互补、并非互斥**,请把它们当成**一套有次序的执行计划**协调执行:');
  labels.forEach((label, i) => {
    lines.push(`${i + 1}. ${label}`);
  });
  lines.push('');
  lines.push('协调规则:');
  lines.push('1. **全部生效,按上列次序执行**:先满足靠前的协议的前提,再推进靠后的;绝不只执行其中一个而忽略其余,也绝不把多套协议混为一谈。');
  lines.push('2. **若两套协议看似冲突**:以更靠前者为优先约束,在不违背它的前提下尽量满足靠后者;无法同时满足时,用一行说明你的取舍理由,再继续推进。');
  lines.push('3. **先于其后的各协议详述**:下面紧接着是各协议的完整要求,逐条遵守。');
  return lines.join('\n');
}

/**
 * 整合层主入口(单一真源)。
 *
 * @param {object} input
 * @param {Array<{key:string, directive:string}>} input.entries
 *        已计算好的指令列表,顺序即历史 ai.js inject 顺序。key 须为 DIRECTIVE_REGISTRY 已知键;
 *        未知 key 仍按 protocol 兜底处理(不丢弃,fail-soft)。
 * @param {object} [input.options]  env 覆盖({directiveComposer})
 * @returns {string}  待 `sp += '\n\n' + 返回值` 的单一字符串(可能为空串)
 */
function composeDirectives(input = {}) {
  const entries = Array.isArray(input && input.entries) ? input.entries : [];
  const options = (input && input.options) || {};

  // 门控关 → 逐字节回退到历史 join 行为。
  if (!_enabled(options)) {
    return _legacyJoin(entries);
  }

  try {
    // 1) 过滤空 directive,保留顺序,标注 tier。
    const active = [];
    for (const e of entries) {
      const directive = String((e && e.directive) || '').trim();
      if (!directive) continue;
      const key = String((e && e.key) || '');
      const meta = DIRECTIVE_REGISTRY[key];
      // 未知 key → 按 protocol 兜底(绝不丢弃),label 用 key 本身。
      const tier = meta ? meta.tier : 'protocol';
      const label = meta ? meta.label : key;
      active.push({ key, directive, tier, label });
    }

    if (active.length === 0) return '';

    // 2) 按 tier 分组,组内保持入参相对顺序。
    const byTier = { guard: [], protocol: [] };
    for (const a of active) {
      (byTier[a.tier] || byTier.protocol).push(a);
    }

    // 3) 协议冲突仲裁:对**真正互斥**的协议对做确定性取舍——按优先级抑制败者,并产出显式仲裁
    //    说明。门控关(KHY_PROTOCOL_ARBITRATION)或无互斥对命中 → 空抑制,byTier.protocol 原样,
    //    输出逐字节回退到今日「全协议 + 协调头」。仲裁叶子绝不抛;此处再包一层兜底。
    let arbitrationNotice = '';
    try {
      const protocolArbitration = require('./protocolArbitration');
      const protoKeys = byTier.protocol.map(p => p.key);
      const { suppressed, arbitrations } = protocolArbitration.arbitrate(protoKeys);
      if (suppressed && suppressed.size > 0) {
        byTier.protocol = byTier.protocol.filter(p => !suppressed.has(p.key));
        const labels = {};
        for (const k of Object.keys(DIRECTIVE_REGISTRY)) labels[k] = DIRECTIVE_REGISTRY[k].label;
        arbitrationNotice = protocolArbitration.buildArbitrationNotice(arbitrations, labels);
      }
    } catch { /* 仲裁失败 → 不抑制,退化为今日协调头软取舍 */ }

    // 4) 统计**仲裁后**生效的 protocol 数量,决定是否插入协调头。
    const protocolCount = byTier.protocol.length;

    const out = [];
    // guard 段(若有)先注入。
    for (const g of byTier.guard) out.push(g.directive);

    // 仲裁说明(若有)紧随 guard:它是「哪些 protocol 本回合不生效」的元规则,须先于协议详述。
    if (arbitrationNotice) out.push(arbitrationNotice);

    if (protocolCount >= 2) {
      // 真正的「多路打架」场景 → 协调头 + 各 protocol。
      out.push(buildCoherenceHeader(byTier.protocol.map(p => p.label)));
      for (const p of byTier.protocol) out.push(p.directive);
    } else {
      // 0 或 1 个 protocol → 不加噪声,直接注入(近字节回退)。
      for (const p of byTier.protocol) out.push(p.directive);
    }

    return out.join('\n\n');
  } catch {
    // 绝不抛:任何意外 → 回退到等价门控关的 join。
    return _legacyJoin(entries);
  }
}

/**
 * 公开门控判定:供调用点(cli/ai.js)以**完全相同**的口径决定是否把 intentAssurance
 * 这条领头 guard 纳入整合层 entries。返回值与 composeDirectives 内部门控判定字节一致——
 * 调用点据此分支,确保门控关时逐字节回退到历史「整合层之后单独注入 intentAssurance」。
 * @param {object} [options]
 * @returns {boolean}
 */
function isComposerEnabled(options = {}) {
  return _enabled(options);
}

module.exports = {
  DIRECTIVE_REGISTRY,
  TIER_ORDER,
  buildCoherenceHeader,
  composeDirectives,
  isComposerEnabled,
};
