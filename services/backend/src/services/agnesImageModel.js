'use strict';

/**
 * agnesImageModel.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「agnes 文生图默认走的是文档里根本不存在的 agnes-image-2.1-flash → 模型调不出来」。
 * Sapiens AI 官方文档(POST /v1/images/generations)只登记**一个**图像模型
 * `agnes-image-2.0-flash`,并明确它**同一模型统一支持**文生图 / 图生图 / 多图合成三种工作流;
 * 文档从未出现 `agnes-image-2.1-flash`。而 imageGenService 历史把文生图默认 hardcode 成
 * `2.1-flash`、仅图改图才用 `2.0-flash` → 一条普通「画一张 X」(无输入图)请求打到一个官方
 * 端点上并不存在的模型 ID,自然报错/调不出来。
 *
 * 本叶子把「agnes 文生图默认模型」这一个决策收敛为单一真源:
 *   - 开门(KHY_AGNES_UNIFIED_IMAGE_MODEL 默认开)→ 文生图默认与官方一致 = `agnes-image-2.0-flash`
 *     (与图改图默认同一模型,呼应文档「一个模型干全部三种工作流」);
 *   - 关门(0/false/off/no)→ 逐字节回退历史默认 `agnes-image-2.1-flash`(与今日行为完全一致)。
 *
 * 两个模型都真实、都在官方登记,都支持文生图与图生图,因此都应可被 catalog 列出、被显式选中:
 *   - `agnes-image-2.0-flash`:统一模型(文生图/图生图/多图合成),作默认;
 *   - `agnes-image-2.1-flash`:升级版(高信息密度/复杂构图优化,文生图/图生图),作可选。
 * `knownAgnesImageModels()` 即这份可选清单的单一真源(2.0 在前=默认,2.1 在后)。
 *
 * 只管**默认值 + 已知清单**:调用方的显式 env 覆盖(KHY_IMAGE_GEN_AGNES_MODEL)与 UI/参数 model
 * 覆盖始终优先于本叶子,叶子只在「没有任何覆盖」时决定回落到哪个 ID,并声明「哪些 ID 是官方登记
 * 可选的」。图改图默认(2.0-flash)本就正确,不受本门控影响。绝不抛:异常回退历史默认。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 官方文档登记的唯一「统一」图像模型(统一文生图/图生图/多图合成),作文生图默认。
const UNIFIED_AGNES_IMAGE_MODEL = 'agnes-image-2.0-flash';
// 升级版图像模型(高信息密度/复杂构图,文生图/图生图);既是历史文生图默认(逐字节回退基准),
// 也是官方登记的可选模型 —— 两个身份同一个 ID。
const UPGRADED_AGNES_IMAGE_MODEL = 'agnes-image-2.1-flash';
// 历史文生图默认 = 升级版 ID(关门回退目标)。
const LEGACY_AGNES_GEN_MODEL = UPGRADED_AGNES_IMAGE_MODEL;

// 官方登记、可显式选中的 agnes 图像模型清单(单一真源)。2.0 在前(默认),2.1 在后(可选)。
const KNOWN_AGNES_IMAGE_MODELS = [UNIFIED_AGNES_IMAGE_MODEL, UPGRADED_AGNES_IMAGE_MODEL];

/**
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function unifiedImageModelEnabled(env = process.env) {
  const raw = env && env.KHY_AGNES_UNIFIED_IMAGE_MODEL;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * agnes 文生图(text-to-image)默认模型:开门 → 官方统一 2.0-flash;关门/异常 → 历史 2.1-flash。
 * 只决定默认;call-site 的显式 env / 参数覆盖优先于本返回值。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function defaultAgnesGenModel(env = process.env) {
  try {
    return unifiedImageModelEnabled(env) ? UNIFIED_AGNES_IMAGE_MODEL : LEGACY_AGNES_GEN_MODEL;
  } catch {
    return LEGACY_AGNES_GEN_MODEL;
  }
}

/**
 * 官方登记、可显式选中的 agnes 图像模型清单(2.0-flash 默认在前、2.1-flash 可选在后)。
 * 两者都支持文生图与图生图。返回副本,调用方可自由改动不影响内部常量。
 * @returns {string[]}
 */
function knownAgnesImageModels() {
  return KNOWN_AGNES_IMAGE_MODELS.slice();
}

module.exports = {
  unifiedImageModelEnabled,
  defaultAgnesGenModel,
  knownAgnesImageModels,
  UNIFIED_AGNES_IMAGE_MODEL,
  UPGRADED_AGNES_IMAGE_MODEL,
  LEGACY_AGNES_GEN_MODEL,
  KNOWN_AGNES_IMAGE_MODELS,
};
