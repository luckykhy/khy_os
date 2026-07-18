'use strict';

/**
 * deliverySummaryFormat.js — 「收尾总结用『根因 / 改动 / 验证』三段式」的意图指令构造器
 * (纯叶子:零 IO、确定性、绝不抛、可单测)。
 *
 * 立场(用户目标 2026-07-04「总结我希望也是和你一样结构化的:根因,改动,验证」):当本轮是
 * 一项**实质的工程任务**(修复 bug / 实现功能 / 重构 / 改动代码)时,khy 的收尾总结应当像
 * 一份工程交付说明那样结构化 —— 先讲**根因**(问题的真正成因 / 需求取证,定位到文件:行),
 * 再列**改动**(实际改了哪些文件、关键函数、门控),最后给**验证**(实际跑过的测试 / 守卫 /
 * 回归证据)。这既便于用户一眼看清,也把「诚实交付」固化进输出格式。
 *
 * 归属:protocol tier(工作流协议 —— 规定「这一类任务收尾时按什么结构呈现」),与
 * testWriting / laziness / errorEnumeration 同族。仅在识别到工程任务意图时注入;纯闲聊 /
 * 问答 / 检索不注入(且指令文本内亦自限适用范围,双保险)。
 *
 * 契约:env 门控 KHY_DELIVERY_SUMMARY_FORMAT(默认开,仅显式 0/false/off/no 关闭)。关闭 →
 * routeDeliverySummary 返 {shouldInject:false, directive:''} → ai.js entries 该项为空 →
 * 整合层过滤空串 → 系统提示逐字节回退(不注入本段)。父门控经 flagRegistry 集中判定,
 * 不可用时回退本地 CANON 词表。
 *
 * @module services/deliverySummaryFormat
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先走 flagRegistry(集中优先级 + dogfood),不可用时回退本地 CANON 词表。
 * 默认开,仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_DELIVERY_SUMMARY_FORMAT', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_DELIVERY_SUMMARY_FORMAT;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/** 去掉代码块 / 行内代码,避免代码里的字样干扰意图识别。委托单一真源 utils/stripCodeSpans。 */
const _stripCode = require('../utils/stripCodeSpans');

// ── 工程任务意图识别(零假阳性优先;线性正则,无灾难性回溯)───────────────────────
// 判据 = 命中「改动 / 交付类动作动词」。纯提问(为什么 / 是什么 / 解释一下)与闲聊没有这类
// 动作动词,不会命中 —— 这是刻意的零假阳性边界。指令文本内部亦声明「若只是闲聊/问答/检索则
// 不必套用」,构成第二重保险。
const _TASK_VERB_RE = new RegExp([
  // 中文:修复 / 实现 / 重构 / 改动 / 对齐 / 集成 / 落地 / 优化 / 搭建 / 完成……
  '修复|修好|修一下|修个|修掉|解决|处理掉|实现|实装|落地|接线|对齐|重构|优化|改进',
  '|改一下|改成|改造|封装|集成|搭建|构建|建立|开发|新增|添加|加个|加上|做这个|做一个|完成',
  // 英文:fix / implement / refactor / optimize / integrate / wire / build / add……
  '|\\bfix(es|ed|ing)?\\b|\\bimplement(s|ed|ing)?\\b|\\brefactor(s|ed|ing)?\\b|\\boptimi[sz]e',
  '|\\bintegrat(e|es|ed|ing)\\b|\\bwir(e|es|ed|ing)\\b|\\bbuild\\b|\\badd(s|ed|ing)?\\b',
  '|\\brefactor\\b|\\bresolv(e|es|ed|ing)\\b|\\bmigrat(e|es|ed|ing)\\b|\\bpatch(es|ed|ing)?\\b',
].join(''), 'i');

/**
 * 识别一段文本是否为「实质工程任务」意图(应产出结构化交付总结)。零假阳性优先。
 * @param {string} text
 * @returns {{shouldInject:boolean}}
 */
function detectDeliveryTask(text) {
  try {
    const cleaned = _stripCode(text);
    if (!cleaned.trim()) return { shouldInject: false };
    return { shouldInject: _TASK_VERB_RE.test(cleaned) };
  } catch {
    return { shouldInject: false };
  }
}

/** 依据文本粗判 locale:含 CJK → 'zh',否则 'en'。 */
// 收敛到 utils/pickLocale 单一真源(逐字节委托,调用点不变)
const pickLocale = require('../utils/pickLocale');

/**
 * 构建「根因 / 改动 / 验证」三段式收尾总结指令。确定性模板,无随机 / 时钟 / 用户文本回显。
 * @param {object} [opts]  {locale}
 * @returns {string}
 */
function buildDeliverySummaryDirective(opts = {}) {
  const locale = opts.locale === 'en' ? 'en' : 'zh';

  if (locale === 'en') {
    return [
      '[SYSTEM: Delivery summary format protocol]',
      'This turn is a substantive engineering task (fix / implement / refactor / change code). When you finish, wrap up with a structured summary in three sections — Root cause / Changes / Verification — so the user can see at a glance what you did and why:',
      '- **Root cause**: the real cause of the bug, or the key evidence for the requirement — pin it to `file:line` and say in a sentence why it is there. For a pure new feature, state the goal and the wiring point.',
      '- **Changes**: what you actually changed — new/edited files, key functions, gate/flag names (if any), listed as short lines or `·` bullets. Prefer lines over tables (they read better in a terminal).',
      '- **Verification**: the evidence you actually ran — test counts (N/N), guard/regression results, key manual checks. If something failed, say it failed; if skipped, say skipped.',
      'Honesty red line: NEVER fabricate verification you did not run, never claim a false pass, never overstate the scope of the change; mark honestly whatever you did not do.',
      'If this turn is actually just chit-chat, a question, or pure lookup (no real code change), you do NOT need this structure — answer normally.',
    ].join('\n');
  }

  return [
    '[SYSTEM: 收尾总结格式协议]',
    '本轮是一项实质的工程任务(修复 / 实现 / 重构 / 改动代码)。完成后,请用「根因 / 改动 / 验证」三段式收尾总结,让用户一眼看清做了什么、为什么、有没有验证:',
    '- **根因**:问题的真正成因,或需求的关键取证 —— 定位到「文件:行」,用一句话说清「为什么是这里」。若是纯新增功能,则写清目标与接线点。',
    '- **改动**:实际改了什么 —— 新增或修改的文件、关键函数、门控名(若有),逐条用短行或「·」列出;不要堆表格(终端里线条 / 短行更易读)。',
    '- **验证**:实际跑过的证据 —— 测试通过数(N/N)、守卫 / 回归结果、关键手测。失败就如实写失败,跳过就写跳过。',
    '诚实红线:**绝不**编造没跑过的验证、不谎报通过、不夸大改动范围;没做到的部分如实标注。',
    '若本轮其实只是闲聊、回答问题或纯检索(没有实质代码改动),无需套用此结构,正常作答即可。',
  ].join('\n');
}

/**
 * 编排:识别工程任务意图并产出注入指令。镜像 routeTestWriting 的契约。
 * @param {object} args
 * @param {string}  args.text
 * @param {object}  [args.env]
 * @returns {{shouldInject:boolean, directive:string}}
 */
function routeDeliverySummary({ text = '', env } = {}) {
  try {
    if (!isEnabled(env)) return { shouldInject: false, directive: '' };
    const det = detectDeliveryTask(text);
    if (!det.shouldInject) return { shouldInject: false, directive: '' };
    return { shouldInject: true, directive: buildDeliverySummaryDirective({ locale: pickLocale(text) }) };
  } catch {
    return { shouldInject: false, directive: '' };
  }
}

module.exports = {
  isEnabled,
  detectDeliveryTask,
  pickLocale,
  buildDeliverySummaryDirective,
  routeDeliverySummary,
};
