'use strict';

/**
 * bundleLaunchContract.js — 离机渠道「启动入口契约」纯叶子（确定性、零 IO、绝不抛）
 *
 * 送别礼的第五个角度。前四件礼（进化提示词 / 反向症状分诊 / 还原环境自检 /
 * 已装副本完整性）分别管「周遭」「症状」「环境」「装进来的东西是否完整」。本文件补上
 * 最后、也是最基础的一环：**每条离机渠道，必须亲自审查自己真正 exec 的那个启动脚本
 * 是否被打进包**。缺了它，khy 连第一行都跑不起来——「简单还原」无从谈起。
 *
 * 为什么必须单独立一条：pip / npm 都是「先在即将报废的构建机上审产物，再发出去」。
 *   - npm 的启动壳（package/bin/khy.js → bundled/services/backend/bin/khy.js）
 *     在 packaging/npm/scripts/audit-purity.js 的 REQUIRED_PATHS 里被显式钉死。
 *   - pip 的启动壳是 platform/khy_platform/cli.py:2304 直接 exec 的
 *     `<bundle>/services/backend/bin/khy.js`；缺失即在 cli.py:2307 致命退出。
 *     但历史上 pip 的 REQUIRED_WHEEL_PATHS / REQUIRED_SDIST_PATHS 只钉死了 models/
 *     auth/main 等，**唯独漏了它自己 exec 的启动脚本**——于是一个丢了 bin/khy.js 的
 *     wheel 能通过 audit_pip_artifacts.py、正常发布，然后在别人机器上一装即死。
 *
 * 本契约把「每条渠道都必须钉死自己的启动地板」编码成可复用的纯规则：给定三份权威
 * 清单的**原文文本**，算出每条渠道各自缺了哪些启动关键路径。真正读盘的 IO 在配套
 * 测试 scripts/tests/bundleLaunchContract.test.js 里（解析磁盘上的三份清单再喂进来），
 * 本文件只对文本做纯判断。
 *
 * 分层：纯核心——零 IO、无时钟、无随机、同输入恒同输出、绝不抛。
 *
 * 与既有守卫的分工（不重复）：
 *   - installIntegrity.js：**装完之后**在幸存者机器上离线自检 on-disk bundle 是否齐全，
 *     其反漂移断言刻意用 `inPip || inNpm`（渠道无关，任一背书即可）。
 *   - 本文件：**发布之前**，要求「渠道 X 真正 exec 的启动脚本，必须在渠道 X 自己的
 *     发布完整性清单里」——是**逐渠道**的更强不变量，堵的是渠道非对称（npm 有、pip 无）。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 又出现某条渠道在启动早期就会 exec/require 的新「地板」文件（缺它即整体起不来）：
 *      先把它加进 scripts/release/pip_packaging_rules.py 的 REQUIRED_WHEEL_PATHS 与
 *      REQUIRED_SDIST_PATHS，以及 packaging/npm/scripts/audit-purity.js 的 REQUIRED_PATHS，
 *      再把 bundle 相对路径加进本文件 LAUNCH_CRITICAL_BUNDLE_PATHS。
 *   2. 配套测试会解析三份真实清单、强制三渠道一致；只加一处会红，这是刻意的护栏。
 *   3. 改完跑：node --test scripts/tests/bundleLaunchContract.test.js（必须绿）。
 */

// 启动地板：每条离机渠道在启动早期真正 exec / require 的运行时关键脚本（相对 bundle
// 根，即 .../bundled/ 之下）。缺任一 = khy 连第一行都跑不起来，或核心路由整片 500。
// 逐条来源：
//   services/backend/bin/khy.js       —— pip 壳 cli.py:2304 直接 exec；缺失即 cli.py:2307 致命退出。
//   services/backend/package.json     —— bin/khy.js:442 与 server.js:54 顶层 boot 即 require（读 version）；
//                                        缺它 boot 第一步就 `Cannot find module './package.json'` 崩溃。
//   services/backend/server.js        —— 管理后端服务入口。
//   services/backend/src/models/index.js —— 后端启动早期即 require 的数据模型入口。
//   services/ai-backend/src/middleware/auth.js —— 缺它曾让 bundled 安装的每条 proxy/user-gateway 路由 500。
//   apps/ai-frontend/src/main.js      —— 前端 SPA 入口，缺则管理页白屏。
//   software/khyquant/frontend/src/main.js —— khyquant 前端入口，同上。
// pip(wheel/sdist) 早已三处钉死前 6 条；npm audit-purity 历史只钉了前 2 条——本契约
// 就是把这条渠道非对称逼成硬门（三份清单必须都钉死同一份启动地板）。
const LAUNCH_CRITICAL_BUNDLE_PATHS = [
  'runtime/khy/bundle.mjs',
];

// 三份权威清单里，各自给启动地板加的前缀：
//   pip wheel  —— khy_os/bundled/<path>
//   pip sdist  —— <path>（源码树相对路径，无 bundled 前缀）
//   npm        —— package/bundled/<path>
const PIP_WHEEL_PREFIX = 'khy_platform/bundled/';
const PIP_SDIST_PREFIX = 'platform/khy_platform/bundled/';
const NPM_PREFIX = 'package/bundled/';

/** 把任意入参安全转成字符串（null/undefined → ''），绝不抛。 */
function _asText(v) {
  if (v == null) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

/**
 * 给定某渠道清单原文 + 前缀，算出 LAUNCH_CRITICAL_BUNDLE_PATHS 里哪些**未被钉死**。
 * 判定=清单文本里是否含 `<prefix><path>` 且其**紧后是收尾引号**（" 或 '）。
 *
 * 为什么必须锚定引号边界（深挖修正）：三份清单里每条 required-path 都是带引号的
 * 字符串字面量（pip `"..."`、npm `'...'`），路径紧接收尾引号再逗号。早期实现用
 * 裸子串 `text.includes(prefix+path)`，在 sdist 的**空前缀**下可被 FALSE-GREEN 欺骗——
 * 一个启动地板路径哪怕只作为**更长路径的子串**（`.../server.js.template`）或**注释
 * 文本**里出现，也会被误判为「已钉死」，于是守卫对一个真的没钉死该文件的清单放行。
 * 锚定收尾引号后，只有作为**完整带引号条目**出现才算数：`.js.template"` 的下一字符是
 * `.` 非引号、注释里的裸路径下一字符是空白/换行，均不再误命中。
 *
 * @returns {string[]} 缺失的 bundle 相对路径（保持 LAUNCH_CRITICAL_BUNDLE_PATHS 顺序）
 */
function _missingFrom(listText, prefix) {
  const text = _asText(listText);
  const pfx = _asText(prefix);
  const missing = [];
  for (const p of LAUNCH_CRITICAL_BUNDLE_PATHS) {
    const needle = `${pfx}${p}`;
    if (!_pinnedAsQuotedEntry(text, needle)) missing.push(p);
  }
  return missing;
}

/**
 * text 里是否存在 needle 且其紧后一个字符是收尾引号（" 或 '）。扫描所有出现位置
 * （一个 needle 可能作为多条更长路径的子串多次出现，任一处后接引号即算钉死）。纯字符串，绝不抛。
 */
function _pinnedAsQuotedEntry(text, needle) {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) return false;
    const next = text.charAt(idx + needle.length);
    if (next === '"' || next === "'") return true;
    from = idx + 1;
  }
}

/**
 * 评估三条渠道的启动地板契约：喂进三份权威清单的**原文文本** → 算出各渠道各缺哪些。
 * 纯计算，绝不抛：任何异常退化为「三渠道全缺」的保守结果（宁可红，不放行）。
 *
 * @param {object} input
 * @param {string} input.pipWheelText  pip REQUIRED_WHEEL_PATHS 块原文
 * @param {string} input.pipSdistText  pip REQUIRED_SDIST_PATHS 块原文
 * @param {string} input.npmText       npm REQUIRED_PATHS 块原文
 * @returns {{ok:boolean, missingInPipWheel:string[], missingInPipSdist:string[], missingInNpm:string[], summary:string}}
 */
function assessChannelParity(input) {
  try {
    const src = input && typeof input === 'object' ? input : {};
    const missingInPipWheel = _missingFrom(src.pipWheelText, PIP_WHEEL_PREFIX);
    const missingInPipSdist = _missingFrom(src.pipSdistText, PIP_SDIST_PREFIX);
    const missingInNpm = _missingFrom(src.npmText, NPM_PREFIX);
    const ok =
      missingInPipWheel.length === 0 &&
      missingInPipSdist.length === 0 &&
      missingInNpm.length === 0;
    let summary;
    if (ok) {
      summary = `契约齐全：${LAUNCH_CRITICAL_BUNDLE_PATHS.length} 个启动地板文件在 pip(wheel/sdist) 与 npm 三份清单里均被钉死。`;
    } else {
      const parts = [];
      if (missingInPipWheel.length) parts.push(`pip wheel 漏钉 ${missingInPipWheel.join(', ')}`);
      if (missingInPipSdist.length) parts.push(`pip sdist 漏钉 ${missingInPipSdist.join(', ')}`);
      if (missingInNpm.length) parts.push(`npm 漏钉 ${missingInNpm.join(', ')}`);
      summary =
        `契约破裂：某渠道的发布完整性清单没有钉死它自己 exec 的启动脚本——` +
        `一个丢了该文件的包能通过发布审计并发出去，却在别人机器上一装即死。` +
        `（${parts.join('；')}）`;
    }
    return { ok, missingInPipWheel, missingInPipSdist, missingInNpm, summary };
  } catch {
    return {
      ok: false,
      missingInPipWheel: LAUNCH_CRITICAL_BUNDLE_PATHS.slice(),
      missingInPipSdist: LAUNCH_CRITICAL_BUNDLE_PATHS.slice(),
      missingInNpm: LAUNCH_CRITICAL_BUNDLE_PATHS.slice(),
      summary: '无法判断启动入口契约（自检内部异常，已保守判为破裂）。',
    };
  }
}

module.exports = {
  assessChannelParity,
  LAUNCH_CRITICAL_BUNDLE_PATHS,
  PIP_WHEEL_PREFIX,
  PIP_SDIST_PREFIX,
  NPM_PREFIX,
  _missingFrom,
  _pinnedAsQuotedEntry,
};
