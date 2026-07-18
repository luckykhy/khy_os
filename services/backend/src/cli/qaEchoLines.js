'use strict';

/**
 * qaEchoLines.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 TUI-vs-经典 REPL drift 家族(承刀105/106 中断标记、刀114 缓存警告孪生):
 * AskUserQuestion 工具答完后,**TUI 侧已保留持久回显**——`useQueryBridge.js:299
 * buildDecisionRecord()` 产出 `{role:'qa', qa:[{question,choice}]}`,由
 * `Transcript.js:361` 渲染成 `❓ 问题` / `   → 所选`,选项覆盖层清除后仍留在滚动历史。
 * 但**经典 REPL 侧缺此回显**:`repl.js` 的 AskUserQuestion 分支用
 * `renderer.askInlineQuestion()` 收答案,其 `cleanup()`(aiRenderer.js:104-113)在选中后
 * `moveCursor+clearScreenDown` 把整段菜单(含问题)擦除且**不留任何字**,收完直接
 * `return {behavior:'allow'}` 从不打印——用户选完即消失(用户实测反馈)。
 *
 * 本叶子把「answers 映射 → 持久回显文本行数组」这段纯格式化抽出单测,作为经典 REPL 侧
 * 回显的排版真源。视觉对齐 TUI `Transcript.js:361-371`:标题行由 shell 侧渲染(着色),
 * 叶子只产出每题两行 `  ❓ {question}` / `     → {choice}`(明文,着色留给调用方,同
 * envInfoLines/themePanelLines 惯例)。
 *
 * 门控 KHY_QA_ECHO(默认开;{0,false,off,no} 关)。关 → 返回 [](shell 侧 length===0 则
 * 不打印)= 逐字节回退今日「选完即消失」行为。
 *
 * 诚实边界(刻意):① answers 的值已由 repl 侧 join(多选 'a, b' 字符串),叶子原样透传
 *   不再加工;② 空 answers / 全空值 → [](无可回显);③ 取消(用户跳过)不走此路——repl
 *   取消分支提前 return,压根不调本叶子;④ 只服务 AskUserQuestion 工具回显,权限决策
 *   (role:'decision')是另一路,不在此。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/** KHY_QA_ECHO 门控:默认开(unset → 开),{0,false,off,no} 关。 */
function qaEchoEnabled(env = process.env) {
  const raw = env && env.KHY_QA_ECHO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/**
 * 构造 AskUserQuestion 答案的持久回显行(不含标题与尾部空行——那些由 shell 侧渲染)。
 * 每题两行:`  ❓ {question}` 与 `     → {choice}`。对齐 TUI Transcript.js 的 ❓/→ 视觉。
 *
 * @param {Record<string,string>} answers  键=问题文本,值=已 join 的所选答案字符串。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}  门控关 / 空 answers / 全空值 → []。
 */
function buildQaEchoLines(answers, env = process.env) {
  if (!qaEchoEnabled(env)) return [];
  if (!answers || typeof answers !== 'object') return [];

  const lines = [];
  for (const [question, choice] of Object.entries(answers)) {
    const q = String(question == null ? '' : question).trim();
    const a = String(choice == null ? '' : choice).trim();
    // 问题为空则整题跳过(无从回显);答案为空仍显示问题行 + 空箭头,如实反映。
    if (!q) continue;
    lines.push(`  ❓ ${q}`);
    lines.push(`     → ${a}`);
  }
  return lines;
}

module.exports = {
  qaEchoEnabled,
  buildQaEchoLines,
};
