'use strict';

/**
 * installIntegrity.js — Khy-OS 已装副本完整性自检（确定性纯叶子）
 *
 * 送别礼的第四个角度：前三件礼分别管「进化(1000 条提示词)」「反向定位(症状分诊)」
 * 「还原环境自检(node/npm/版本)」——它们都检查**周遭**。本文件补上唯一缺口：
 * 检查**装进来的东西本身是否完整无损**。
 *
 * 为什么需要它：pip(`khy-os`)/npm(`@khy-os/khy-os`) 的发布侧确有完整性校验
 * （scripts/release/pip_packaging_rules.py 的 REQUIRED_WHEEL_PATHS、npm 的
 * REQUIRED_PATHS），但那是在**即将报废的构建机**上、对**刚构建出的产物**跑的。
 * 一旦包发出去，另一台机器上：下载被截断、pip 装了一半、某个文件没被打进
 * bundle……都无人可查。本自检把「产物完整性保证」从构建机搬到**每一台幸存者的
 * 机器上，可离线运行**。
 *
 * 分层：本文件是**纯核心**——零 IO、无时钟、无随机、同输入恒同输出、绝不抛。
 * 真正 stat 文件系统的 IO 在 CLI scripts/verify-install.js 里、单独隔离且
 * fail-soft；本文件只对「探测结果」做纯判断。
 *
 * 单一真源与防漂移：CRITICAL_BUNDLE_PATHS 是「缺了它 khy 就跑不起来」的运行时
 * 关键路径子集，逐条源自 REQUIRED_WHEEL_PATHS（发布门的权威清单，本身来自真实
 * 生产事故——ai-backend/auth.js 曾掉出打包令每条代理/网关路由 500）。测试
 * installIntegrity.test.js 有一条反漂移断言：本表每一项都必须能在
 * REQUIRED_WHEEL_PATHS 里找到，杜绝两处各说各话。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 又出现「缺了它就整体跑不起来」的新关键文件 → 先把它加进发布门权威清单
 *      scripts/release/pip_packaging_rules.py 的 REQUIRED_WHEEL_PATHS，再把
 *      bundle 相对路径加进本文件 CRITICAL_BUNDLE_PATHS（顺序=展示优先级）。
 *   2. 反漂移测试会强制两处一致；只改一处会红，这是刻意的护栏。
 *   3. 改完跑：node --test scripts/tests/installIntegrity.test.js（必须绿）。
 */

// 运行时关键路径（相对 bundle 根，即 .../bundled/ 之下）。缺任一 = khy 无法启动。
// 每条都由发布门权威清单背书——pip 的 REQUIRED_WHEEL_PATHS 或 npm 的 REQUIRED_PATHS
// （反漂移测试强制这一点）。services/backend/package.json 刻意不列此表：它是
// CLI resolveBundleRoot 定位 bundle 的锚点，缺它会先触发「无法定位 bundle」，已被覆盖。
const CRITICAL_BUNDLE_PATHS = [
  // 后端运行时入口：没有它 khy 根本起不来（npm REQUIRED_PATHS 背书）
  'services/backend/bin/khy.js',
  'services/backend/server.js',
  // 数据层入口：缺失曾令启动即崩（pip REQUIRED_WHEEL_PATHS 背书）
  'services/backend/src/models/index.js',
  // ai-backend 鉴权中间件：真实事故点，缺它每条代理/网关路由 500
  'services/ai-backend/src/middleware/auth.js',
  // 前端入口：管理页由此挂载
  'apps/ai-frontend/src/main.js',
  // 内核构建根：workshop 完整性锚点
  'kernel/Makefile',
  // 纯叶子契约守卫：无 AI 维护时的护栏，缺它则守护体系失守
  'scripts/lib/leafContractGuard.js',
];

// 每条关键路径缺失时的人话说明 + 照抄即用的修法（务必安全，不得含
// commit/push/rm/curl/publish 之类危险动作）。
const _PATH_HINTS = {
  'services/backend/bin/khy.js':
    '后端 CLI 入口缺失——包不完整，khy 无法启动。',
  'services/backend/server.js':
    '后端服务入口缺失——管理后端无法拉起。',
  'services/backend/src/models/index.js':
    '数据层入口缺失——启动即崩。',
  'services/ai-backend/src/middleware/auth.js':
    'AI 后端鉴权中间件缺失——每条代理/网关路由会 500（历史事故点）。',
  'apps/ai-frontend/src/main.js':
    '前端入口缺失——管理页打不开。',
  'kernel/Makefile':
    '内核构建根缺失——workshop 不完整。',
  'scripts/lib/leafContractGuard.js':
    '纯叶子契约守卫缺失——无 AI 维护时的护栏丢了。',
};

const _GENERIC_FIX =
  '重装官方包补齐：pip 通道 `pip install --force-reinstall khy-os`，' +
  'npm 通道 `npm install -g @khy-os/khy-os`；两条渠道的包都自带完整 bundle。';

/**
 * 把任意探测结果规整为 { path -> boolean }。非法项按「缺失(false)」保守处理
 * （宁可提示也不漏报），未知键忽略。
 */
function _normalizeProbes(probeResults) {
  const out = {};
  if (!probeResults || typeof probeResults !== 'object') return out;
  for (const p of CRITICAL_BUNDLE_PATHS) {
    out[p] = probeResults[p] === true; // 只有明确 true 才算存在
  }
  return out;
}

/**
 * 评估已装副本完整性：喂进「关键路径是否存在」的探测结果 → 排序算出缺失清单
 * + 每项具名修法。纯计算，绝不抛：异常退化为保守的「无法判断」空结果。
 *
 * @param {object} probeResults { '<bundle 相对路径>': boolean }，由 CLI 探测层提供
 * @param {object} [opts]
 * @param {boolean} [opts.bundleResolved] CLI 是否成功定位到 bundle 根（false=整包缺失）
 * @returns {{intact:boolean, checked:number, missing:Array, present:Array, summary:string}}
 */
function assessInstallIntegrity(probeResults, opts = {}) {
  try {
    const bundleResolved = !(opts && opts.bundleResolved === false);
    const probes = _normalizeProbes(probeResults);
    const missing = [];
    const present = [];
    for (const p of CRITICAL_BUNDLE_PATHS) {
      if (probes[p] === true) {
        present.push(p);
      } else {
        missing.push({
          path: p,
          reason: _PATH_HINTS[p] || '关键文件缺失。',
          fix: _GENERIC_FIX,
        });
      }
    }
    const intact = bundleResolved && missing.length === 0;
    let summary;
    if (!bundleResolved) {
      summary =
        '无法定位已安装的 bundle 目录——包可能未装好或安装严重不完整。' + _GENERIC_FIX;
    } else if (intact) {
      summary = `完整：${present.length}/${CRITICAL_BUNDLE_PATHS.length} 项运行时关键文件齐全，已装副本可用。`;
    } else {
      summary = `不完整：缺失 ${missing.length}/${CRITICAL_BUNDLE_PATHS.length} 项运行时关键文件，khy 可能无法正常启动。`;
    }
    return {
      intact,
      checked: CRITICAL_BUNDLE_PATHS.length,
      missing,
      present,
      summary,
    };
  } catch {
    return {
      intact: false,
      checked: 0,
      missing: [],
      present: [],
      summary: '无法判断已装副本完整性（自检内部异常，已安全降级）。',
    };
  }
}

module.exports = {
  assessInstallIntegrity,
  CRITICAL_BUNDLE_PATHS,
  _PATH_HINTS,
  _normalizeProbes,
  _GENERIC_FIX,
};
