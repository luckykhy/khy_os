'use strict';

/**
 * envInfoLines.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「/菜单命令全部补齐 + 其它功能从前端逐项对齐」+ router-path vs
 * interactive-twin drift 家族(承刀101-108)。`/env` 命令有**三处实现**且互相漂移:
 *   ① router case 'env'(router.js:1460):Platform/Node/CWD/Shell/Git branch(英文·无版本·无 TERM);
 *   ② 菜单孪生(repl.js:4040 selected.flag==='env'):平台/Node/工作目录/Shell/终端/Git 分支(无版本);
 *   ③ 键入孪生(repl.js:4800 trimmed==='/env'):平台/Node/工作目录/Shell/版本(无终端·无 Git 分支)。
 * 两条交互中文孪生(②③)本应彼此一致(面归属),却各缺对方的字段 = 呈现侧 half-wired
 * 漂移(菜单缺版本·键入缺终端+Git 分支)。
 *
 * 本叶子把「环境信息各字段值 → 缩进展示行数组」这段纯格式化抽出单测,作为两孪生的单一真源
 * (SSOT):shell 侧采集各值(process.platform/arch/version、cwd、SHELL/TERM env、host 版本、
 * `git rev-parse` 分支——都是 IO/进程读取),叶子只做确定性字符串拼装。两孪生门控开时都调它 →
 * 输出**逐字段一致的超集**(平台/Node/工作目录/Shell/终端/版本/Git 分支)。
 *
 * 门控 KHY_ENV_INFO_ALIGN(默认开;{0,false,off,no} 关)。关 → 两孪生各自逐字节回退刀109前
 * 内联行(菜单保留 终端+Git 分支无版本·键入保留 版本无终端无 Git 分支),互不影响。这是**孪生
 * 对齐总开关**(独立字段级门控·同刀108 KHY_COMPACT_TWIN_ALIGN 形态):因两孪生今日基线不同,
 * 单一叶子无法同时逐字节复刻两者,故对齐后的超集与今日各不同字节 → 需总开关保 byte-identity 红线。
 *
 * 诚实边界(刻意):① 只对齐两条**交互中文孪生**;router 英文诊断面(Platform/Git branch·无
 *   版本/终端)是刻意的面差异(承刀102/104 face-difference·honest-NA),本刀不动 router。
 *   ② Git 分支为空(非 git 仓 / 采集失败)→ 省略该行(不显空分支·两孪生一致)。
 *   ③ 叶子零 IO:分支采集由 shell 侧 execSync fail-soft 完成,拿不到 → 传空 → 叶子省略行。
 *   ④ Shell/终端 缺失 → 'N/A'(沿用今日两孪生口径)。⑤ 门控关 / 坏输入 → 各自回退,整体不抛。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/** KHY_ENV_INFO_ALIGN 门控:默认开(unset → 开),{0,false,off,no} 关。 */
function envInfoAlignEnabled(env = process.env) {
  const raw = env && env.KHY_ENV_INFO_ALIGN;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/**
 * 构造环境信息缩进展示行(不含 bold 标题与尾部空行——那些由 shell 侧渲染)。
 * 字段顺序固定:平台 / Node / 工作目录 / Shell / 终端 / 版本 / Git 分支。
 * gitBranch 空(''/空白/null)→ 省略 Git 分支行(非 git 仓 / 采集失败)。
 * @param {{platform?:string,arch?:string,nodeVersion?:string,cwd?:string,shell?:string,term?:string,version?:string,gitBranch?:string}} [values]
 * @returns {string[]}
 */
function buildEnvInfoLines(values) {
  const v = values || {};
  const lines = [];
  lines.push(`    平台: ${v.platform} ${v.arch}`);
  lines.push(`    Node: ${v.nodeVersion}`);
  lines.push(`    工作目录: ${v.cwd}`);
  lines.push(`    Shell: ${v.shell || 'N/A'}`);
  lines.push(`    终端: ${v.term || 'N/A'}`);
  lines.push(`    版本: ${v.version}`);
  const branch = v.gitBranch == null ? '' : String(v.gitBranch).trim();
  if (branch) lines.push(`    Git 分支: ${branch}`);
  return lines;
}

module.exports = {
  envInfoAlignEnabled,
  buildEnvInfoLines,
};
