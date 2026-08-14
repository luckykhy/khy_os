'use strict';

/**
 * Shell 失败的「错误映射」纯模块(平台无关,可独立单测)。
 *
 * 从 shellCommand.js 抽出,因 defineTool 冻结导出对象、无法挂测试钩子(与
 * winCommandTranslate / shellClassifier 同款的兄弟纯模块范式)。
 *
 * 解决的真实缺口:子进程非零退出且 **stdout/stderr 全空** 时(典型:`... 2>nul | find "中文"`
 * —— stderr 被 `2>nul` 抹掉、`find` 因代码页对中文 needle 误判无匹配而 exit 1),原先 error
 * 只剩裸 `Command exited with code 1`,用户与模型都拿不到「为什么失败」。本模块保证非零退出
 * **永不**塌缩成裸退出码:有输出 → 附输出尾部;无输出 → 附一条基于命令形态推断的诊断行。
 */

const TAIL = 800;

/** stderr 被丢弃到 null 设备的重定向(cmd `2>nul` / POSIX `2>/dev/null` / PowerShell `2>$null`)。 */
const _STDERR_DISCARD_RE = /2>\s*(nul|\/dev\/null|\$null)\b/i;

/** 末段管道是否为 find / findstr / grep 这类「过滤器」(退出码 1 = 未匹配,而非硬错误)。 */
const _FILTER_TAIL_RE = /\|\s*(find|findstr|grep)\b[^|]*$/i;

/**
 * 仅当命令无任何 stdout/stderr 输出时,推断「为什么没有细节」的诊断行。
 * 纯函数,只看退出码与命令形态;返回单行中文诊断(始终非空)。
 * @param {number} code 子进程退出码
 * @param {string} [command] 原始命令(用于形态推断)
 * @returns {string}
 */
function diagnoseEmptyFailure(code, command) {
  const cmd = String(command || '');
  // 过滤器(find/findstr/grep)退出码 1:这是「未匹配」的正常语义,不一定是错误。
  if (code === 1 && _FILTER_TAIL_RE.test(cmd)) {
    let line = 'find/findstr/grep 退出码 1 = 未匹配到任何行(不一定是错误);'
      + 'Windows 上对中文/非 ASCII needle 常因代码页(chcp)误判为无匹配。';
    // 叠加:若同时把 stderr 抹掉了,提示移除重定向。
    if (_STDERR_DISCARD_RE.test(cmd)) {
      line += ' 此外 stderr 被重定向到 null 而丢弃,移除该重定向后重跑可见真实错误。';
    }
    return line;
  }
  // stderr 被显式丢弃:真实失败原因被 2>nul / 2>/dev/null / 2>$null 抹掉了。
  if (_STDERR_DISCARD_RE.test(cmd)) {
    return 'stderr 被重定向到 null 而丢弃,真实错误未被捕获;移除该重定向(如 2>nul)后重跑可见原因。';
  }
  // 通用空输出:退出码是唯一信号。
  return '命令无任何 stdout/stderr 输出;退出码即唯一信号。';
}

/**
 * 把非零退出映射成可读 error 字符串。永不塌缩成裸退出码。
 *
 * 有 output → `Command exited with code N` + 输出尾部(≤800 字符);
 * output 空 → `Command exited with code N` + diagnoseEmptyFailure 的诊断行。
 *
 * @param {number} code
 * @param {string} output stdout+stderr 合并文本
 * @param {string} [command] 原始命令(供空输出时形态诊断)
 * @returns {string}
 */
function composeShellError(code, output, command) {
  const base = `Command exited with code ${code}`;
  const text = String(output || '').trim();
  let composed;
  if (!text) {
    composed = `${base}\n${diagnoseEmptyFailure(code, command)}`;
  } else {
    const snippet = text.length > TAIL ? `…${text.slice(-TAIL)}` : text;
    composed = `${base}\n${snippet}`;
  }
  // inline-python 姿势错(python3 not-found / `-c` 多行块 SyntaxError):据命令形态 + 报错
  // 签名追加一句「怎么改」。修复动作不在原 stderr 里,附加后模型可一次到位。门控关 / 无命中 /
  // 异常 → null(逐字节回退,不追加)。懒加载 + fail-soft,绝不因本增强破坏错误组装。
  try {
    const { buildPythonInvocationHint } = require('./pythonInvocationHint');
    const hint = buildPythonInvocationHint(command, output, process.env);
    if (hint) composed = `${composed}\n${hint}`;
  } catch { /* 提示叶子不可用 → 保持原错误串 */ }
  // 通用错误分类(教 khyos 处理未见过的错误):非空 stderr 但不属 python 姿势错时,据报错
  // 签名把失败归入一个已知环境/姿势错家族(命令找不到 / 权限 / 路径 / 缺依赖 / 端口 / 磁盘 /
  // 网络),各追加**一条**可操作改法。单火 · 让位 python(not-found 由上面的 python 叶子接管,
  // 本叶子对 python 命令的 not-found 家族返回 null 不重复)· 只治环境/姿势错不猜业务逻辑错。
  // 门控关 / 无命中 / 异常 → null(逐字节回退,不追加)。懒加载 + fail-soft,绝不因本增强破坏组装。
  try {
    const { buildShellErrorHint } = require('./shellErrorClassify');
    const classHint = buildShellErrorHint(command, output, process.env);
    if (classHint) composed = `${composed}\n${classHint}`;
  } catch { /* 分类叶子不可用 → 保持原错误串 */ }
  return composed;
}

module.exports = {
  composeShellError,
  diagnoseEmptyFailure,
};
