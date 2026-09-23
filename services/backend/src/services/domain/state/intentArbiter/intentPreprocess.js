'use strict';

/**
 * intentPreprocess.js — 纯叶子:意图文本「解析前确定性归一」单一真源(Phase C-2 第 1 层)。
 *
 * 背景(为什么需要本叶子):
 *   IntentSpectrumAnalyzer 的全部判别都靠 `text.includes(词)` 子串命中。若用户经 CJK-IME
 *   敲入**全角数字 / 全角空格**(`跑一下　测试`、`２０２４`),或粘贴带**多余空白**的文本,
 *   规则会静默落空(全角空格 U+3000 ≠ 半角空格,`\s` 不认全角)。对一个中文优先的 CLI,
 *   这类输入并不罕见。本叶子在 analyze() 入口把意图文本做**确定性**归一,提升规则稳健性。
 *
 * 设计取舍(诚实边界):只做「全角→半角(数字/空格) + 空白折叠 + 裁剪」。**绝不**做字符间
 *   空白剥离(`执 行`→`执行` 会改语义)、繁简转换、同义词替换(那是 lexicon 层的事)。
 *   全角折叠**复用既有纯叶子** cli/fullWidthInput 的 normalizeFullWidthDigits/Space,
 *   绝不在 arbiter 内重写(尊重 fullWidthInput 单一真源)。
 *
 * 纯叶子契约:零 IO、确定性、绝不抛、可单测。env 由调用方注入(不在叶子内读 process.env)。
 * 门控 KHY_INTENT_PREPROCESS 默认开;关 → canonicalize 原样返回入参(字节回退:解析等价历史)。
 */

/**
 * 取 fullWidthInput 的两个折叠函数。
 *
 * 分层说明:本叶子是 L2 services，`cli/fullWidthInput` 是 L2 cli 侧的**纯函数叶子**
 * (60 行、零 require、无 IO)。服务层直接 require 它是反向分层(archDebtScan R1) ——
 * 那个文件真正的家在服务层，只是当年第一个消费者是 TUI 选择菜单，才落在 cli/ 下。
 *
 * 两档回落(与 sessionForestService 同一范式):
 *   ① cliLeafPort 已注册 → 直接用端口里的函数(依赖方向已由 cli 自注册反转)。
 *   ② 未注册 → 自举 `cli/ai` 触发自注册，再取一次。
 * 本文件因此只有 **一行** cli 引用，且语义是「拉起 CLI 让其自注册」而非「向 cli 要能力」。
 * 两条路拿到的是同一份实现，行为逐字节不变。
 */
function _fw() {
  const port = require('../../../cliLeafPort');
  let space = port.getNormalizeFullWidthSpace();
  let digits = port.getNormalizeFullWidthDigits();
  if (typeof space !== 'function' || typeof digits !== 'function') {
    // 唯一 cli 引用：不是取能力，是触发 cli/ai 自注册（见上）。
    require('../../../../cli/ai');
    space = require('../../../cliLeafPort').getNormalizeFullWidthSpace();
    digits = require('../../../cliLeafPort').getNormalizeFullWidthDigits();
  }
  if (typeof space !== 'function' || typeof digits !== 'function') {
    throw new Error('fullWidthInput 未注册到 cliLeafPort(cli/ai 不可用)');
  }
  return { normalizeFullWidthSpace: space, normalizeFullWidthDigits: digits };
}

const FALSY = new Set(['0', 'false', 'off', 'no']);

/** 预处理子门控(默认开;{0,false,off,no} 关闭)。 */
function isEnabled(env) {
  const e = env && typeof env === 'object' ? env : {};
  const raw = e.KHY_INTENT_PREPROCESS;
  if (raw === undefined || raw === null || raw === '') {
    return true;
  }
  return !FALSY.has(String(raw).trim().toLowerCase());
}

/**
 * 解析前确定性归一。门控关 → 原样返回入参(字节回退);开 → 全角折半角 + 空白折叠 + trim。
 * 容错:非串 / null / undefined 经 String 守卫,绝不抛。
 * @param {string} text  原始意图文本(调用方通常已 trim)
 * @param {object} [env] 环境(门控注入点)
 * @returns {string}
 */
function canonicalize(text, env) {
  // 门控关:原样返回入参 —— 调用方传入的(已 trim 的)串逐字节不变。
  if (!isEnabled(env)) {
    return text;
  }
  let s = String(text == null ? '' : text);
  const fw = _fw();
  // 1) 全角空格 U+3000 → 半角(复用 fullWidthInput 纯函数)。
  s = fw.normalizeFullWidthSpace(s);
  // 2) 全角数字 ０-９ → 半角(同上)。
  s = fw.normalizeFullWidthDigits(s);
  // 3) 连续空白折叠为单个半角空格 + 裁剪首尾。
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

module.exports = {
  isEnabled,
  canonicalize,
};
