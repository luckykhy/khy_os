'use strict';

/**
 * upstreamStudyPlan.js — 纯叶子:UpstreamStudy 的「怎么改」**决策层**(在精华/糟粕之上再叠两维)。
 *
 * 用户诉求(goal 2026-07-06 扩充):把开源更新包学进来时,除了「取其精华弃其糟粕」,还要点明——
 *   ①**哪些能改代码、哪些不能改**(移植安全性);②**哪些先改、哪些后改**(移植顺序)。
 * 这两问是纯逻辑(只看已列到的 {path, bucket} 元数据),与真正列目录的 archiveInspectService、
 * 编排的 upstreamStudy facade 彻底分离,便于确定性测试与门控回退。
 *
 * 两个维度:
 *   portabilityOf → 能改/不能改:
 *     forbidden(**不能移植**):许可证/法律文件(LICENSE/COPYING/NOTICE…改它=引入上游许可)、
 *                              以及一切糟粕桶(vendored/生成物/二进制/密钥…本就不该照搬)。
 *     caution(**谨慎, 不能整段覆盖**):配置/依赖清单(改依赖/构建须手动核对)、changelog(用来理解, 非代码)。
 *     safe(**可择优移植**):源码 / 测试 / 一般文档。
 *   portWaveOf → 先改/后改(移植顺序波次):
 *     0 先读·理解改动(不移植):changelog / migration / 一般理据文档;
 *     1 先改·接口/契约/配置(实现依赖它们):.d.ts / .proto / .graphql / 名含 types|schema|interface|api / 配置;
 *     2 再改·具体实现:普通源码;
 *     3 最后·测试(移植完用它验证):测试文件。
 *
 * 契约:零 I/O(不碰 fs/网络/子进程/crypto,只对 {path,bucket,...} 元数据判定)、确定性(无时钟/随机)、
 * 绝不抛(fail-soft)。可 require 同层纯叶子 upstreamStudyCatalog 复用 baseOf/extOf(仍是纯的)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_UPSTREAM_STUDY_PLAN  默认 on(parent=KHY_UPSTREAM_STUDY_TOOL)——移植计划总开关。
 *     关 ⇒ portabilityOf/portWaveOf 恒返空档、buildStudyPlan 返 null(逐字节回退:facade 不产 plan 字段)。
 *
 * @module services/upstreamStudyPlan
 */


// 许可证 / 法律文件(basename 去扩展名命中)——照搬会把上游许可/著作权引入 Khy,绝不移植。
const LICENSE_RE = /^(licen[sc]e|copying|copyright|notice|patents?|authors|contributors|unlicense|third[-_]?party[-_]?notices?)$/i;

// 「接口/契约」信号:扩展名。
const CONTRACT_EXTS = new Set(['.proto', '.graphql', '.gql', '.thrift', '.avsc']);

// 「接口/契约」信号:basename(含 TS 声明文件 .d.ts,与名字含 types/schema/interface/api/dto/model 的源码)。
const DTS_RE = /\.d\.ts$/i;
const CONTRACT_BASE_RE = /(^|[._-])(type|types|schema|schemas|interface|interfaces|contract|contracts|api|apis|dto|dtos|model|models|proto|constants?)([._-]|\.|$)/i;

// migration / upgrading 类文档(先读)——CHANGELOG_RE 已在 catalog 归为 bucket:'changelog';这里补一般 doc 情形。
const READ_FIRST_DOC_RE = /(^|[._-])(migration|migrating|upgrade|upgrading|breaking|readme|changelog|changes|news|history)([._-]|\.|$)/i;

const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 移植计划总开关。默认 on。 */
function isPlanEnabled(env) {
  return _isEnabled('KHY_UPSTREAM_STUDY_PLAN', env);
}

function _baseOf(path) {
  try {
    const cat = require('./upstreamStudyCatalog');
    if (cat && typeof cat.baseOf === 'function') return cat.baseOf(path);
  } catch { /* fall through */ }
  return (String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '').toLowerCase();
}

function _extOf(path) {
  try {
    const cat = require('./upstreamStudyCatalog');
    if (cat && typeof cat.extOf === 'function') return cat.extOf(path);
  } catch { /* fall through */ }
  const base = _baseOf(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i) : '';
}

function _stem(base) {
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

/**
 * 判定一个条目**能不能把它的代码改进搬进 Khy**。绝不抛。
 * 门控关 ⇒ {verdict:'', reason:''}(逐字节回退)。
 *
 * @param {{path:string, bucket?:string, verdict?:string}} item  通常是已分类的精华条目(带 bucket);
 *        也接受任意条目——糟粕/中性(bucket 非精华类)一律 forbidden。
 * @param {object} [env]
 * @returns {{verdict:'forbidden'|'caution'|'safe'|'', reason:string}}
 */
function portabilityOf(item, env) {
  try {
    if (!isPlanEnabled(env)) return { verdict: '', reason: '' };
    if (!item) return { verdict: 'forbidden', reason: '空条目' };
    const path = String(item.path || '');
    const base = _baseOf(path);
    const stem = _stem(base);
    const bucket = String(item.bucket || '');

    // forbidden:法律文件 —— 无论它被归成 doc 精华,照搬都会引入上游许可/著作权。
    if (LICENSE_RE.test(stem)) {
      return { verdict: 'forbidden', reason: '许可证/法律文件:照搬会引入上游许可, 勿覆盖 Khy 对应文件' };
    }
    // forbidden:非精华桶(糟粕/中性)——本就不该移植。
    const ESSENCE = new Set(['changelog', 'source', 'test', 'doc', 'config']);
    if (bucket && !ESSENCE.has(bucket)) {
      return { verdict: 'forbidden', reason: '糟粕/非精华:不移植(依赖/生成物/二进制/密钥等)' };
    }
    // caution:配置/依赖清单 —— 改依赖/构建须手动核对, 不能整段覆盖 Khy 的配置。
    if (bucket === 'config') {
      return { verdict: 'caution', reason: '构建/依赖清单:只手动核对差异, 不能整段覆盖 Khy 配置' };
    }
    // caution:changelog —— 用来理解「改了什么」, 本身不是要搬进 Khy 的代码。
    if (bucket === 'changelog') {
      return { verdict: 'caution', reason: '更新说明:读它理解改动, 不作为代码移植进 Khy' };
    }
    // safe:源码/测试/一般文档 —— 可择优移植具体改进(仍由人/模型逐处核对)。
    return { verdict: 'safe', reason: '源码/测试/文档:可择优移植具体改进(逐处核对, 非整段搬运)' };
  } catch {
    return { verdict: 'forbidden', reason: '判定异常, 保守不移植' };
  }
}

// 波次标签(单一真源)。
const WAVES = Object.freeze([
  Object.freeze({ wave: 0, label: '先读 · 理解改动(不移植代码)' }),
  Object.freeze({ wave: 1, label: '先改 · 接口/契约/配置(实现依赖它们)' }),
  Object.freeze({ wave: 2, label: '再改 · 具体实现' }),
  Object.freeze({ wave: 3, label: '最后 · 测试(移植完用它验证)' }),
]);

/**
 * 判定一个条目在移植时**该第几波改**(先后顺序)。绝不抛。
 * 门控关 ⇒ null(逐字节回退:facade 不排波次)。
 *
 * @param {{path:string, bucket?:string}} item
 * @param {object} [env]
 * @returns {{wave:number, label:string}|null}
 */
function portWaveOf(item, env) {
  try {
    if (!isPlanEnabled(env)) return null;
    if (!item) return null;
    const path = String(item.path || '');
    const base = _baseOf(path);
    const ext = _extOf(path);
    const bucket = String(item.bucket || '');

    // 0 先读:changelog 桶,或名字像 migration/upgrade/readme 的文档。
    if (bucket === 'changelog') return { ...WAVES[0] };
    if (bucket === 'doc' && READ_FIRST_DOC_RE.test(base)) return { ...WAVES[0] };

    // 1 先改:接口/契约/配置(实现依赖它们)。
    if (bucket === 'config') return { ...WAVES[1] };
    if (DTS_RE.test(base) || CONTRACT_EXTS.has(ext) || CONTRACT_BASE_RE.test(base)) return { ...WAVES[1] };

    // 3 最后:测试。
    if (bucket === 'test') return { ...WAVES[3] };

    // 2 再改:普通源码 / 其余一般文档。
    return { ...WAVES[2] };
  } catch {
    return null;
  }
}

/**
 * 把一批(通常是 Top-N 精华)条目排成移植计划:能改的按波次分组、不能改的进 forbidden 桶。绝不抛。
 * 门控关 ⇒ null(逐字节回退:facade 不产 plan 字段)。
 *
 * @param {Array<{path:string, bucket?:string, isNew?:boolean, isChanged?:boolean, tooLarge?:boolean}>} items
 * @param {object} [env]
 * @returns {{waves:Array<{wave:number,label:string,items:Array}>, forbidden:Array<{path:string,reason:string}>, note:string}|null}
 */
function buildStudyPlan(items, env) {
  try {
    if (!isPlanEnabled(env)) return null;
    const list = Array.isArray(items) ? items : [];
    const byWave = new Map(WAVES.map((w) => [w.wave, []]));
    const forbidden = [];

    for (const it of list) {
      if (!it) continue;
      const port = portabilityOf(it, env);
      if (port.verdict === 'forbidden') {
        forbidden.push({ path: String(it.path || ''), reason: port.reason });
        continue;                       // 不能改的不排入波次
      }
      const w = portWaveOf(it, env);
      const wave = w ? w.wave : 2;
      const bucketArr = byWave.get(wave) || byWave.get(2);
      bucketArr.push({
        path: String(it.path || ''),
        bucket: String(it.bucket || ''),
        portability: port.verdict,       // 'safe' | 'caution'
        reason: port.reason,
        isNew: !!it.isNew,
        isChanged: !!it.isChanged,
        tooLarge: !!it.tooLarge,
      });
    }

    const waves = WAVES
      .map((w) => ({ wave: w.wave, label: w.label, items: byWave.get(w.wave) || [] }))
      .filter((w) => w.items.length > 0);

    return {
      waves,
      forbidden,
      note: '先后仅为建议顺序;能改/不能改仅为移植安全性提示——最终由你逐处核对, 绝不整包合并。',
    };
  } catch {
    return null;
  }
}

module.exports = {
  isPlanEnabled,
  portabilityOf,
  portWaveOf,
  buildStudyPlan,
  WAVES,
  LICENSE_RE,
  CONTRACT_BASE_RE,
};
