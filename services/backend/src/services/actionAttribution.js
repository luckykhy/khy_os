'use strict';

/**
 * actionAttribution.js
 *
 * 「自我动作认领 / 因果叙述连贯」—— 当 khyos **亲自**执行了一个变更/破坏性动作
 * (删除、覆盖、移动、写入)后,叙述结果时必须**认领**这个动作,而不是把自己刚做的事
 * 甩给一个模糊的外部过去原因。
 *
 * 触发本件的真实缺陷:khyos 自己跑了 `del <文件>`,命令报告「找不到」,它却把文件消失
 * 叙述成「**可能之前**已经被清理过」——把刚执行的删除动作推给未知过去,因果自相矛盾
 * (我执行了删除 ⇄ 可能别人早就删了)。正确叙述应是「我执行了删除命令,系统显示这些文件
 * 在执行时已不在该路径」,因果链清楚:我做了 X → 结果 Y → 现在状态 Z。
 *
 * 纯叶子:无 I/O、无随机、单一真源。给定**刚执行完**的一批工具结果,确定性判定这批里有没有
 * 变更/破坏性动作,并(在变更尚未被叙述、处于粘性窗口内时)产出一段中文 [SYSTEM:] 指令,由
 * 上层在工具结果回灌下一轮**之前**注入,让模型据此连贯、第一人称地叙述。
 *
 * 为什么需要「粘性」状态:真实回合常是 删除 → 只读探查(Glob/Read) → 叙述。叙述发生在删除
 * 的后几轮,中间隔着只读批次。若只在「本批次含变更」的那一轮注入,叙述轮就读不到指令。故用
 * 一个小状态机:一旦看到变更动作就置 pending,之后的几轮(STICKY_WINDOW)持续注入,直到模型
 * 收尾(收尾轮不再有工具结果消息,状态自然停止被查询)。
 *
 * 零假阳性:纯只读批次(Read/Grep/Glob/web_search)且无 pending → 不注入(currentMessage 字节
 * 不变)。只有确实发生过变更/破坏性动作才介入。
 *
 * 与既有件的关系(同「叙述/诚实呈现」族,正交):
 *  - flexibleToolNarration 讲「旁白别机械」;outputIntegrityMonitor 盯「输出本身完整」;
 *    本件讲「叙述里别把自己刚做的动作甩给外因,因果要连贯」。
 *  - 与 loop 内既有的事后 nudge(失败恢复 / 伪成功拒绝 / 自相矛盾)互补:那些是收尾后重做,
 *    本件是叙述**之前**前置引导。
 */

// 变更类工具(写/编辑/移动/清理):亲手改变了世界状态。
const MUTATING_TOOL_RE = /^(write|write_file|writefile|file_write|edit|editfile|file_edit|multiedit|multi_edit|notebookedit|notebook_edit|applypatch|apply_patch|move|rename|mkdir|diskcleanup)$/i;

// 破坏性 shell 动作:删除 / 覆盖 / 强制移动。命中即「破坏性」(数据可能不可逆)。
//  - posix: rm / rmdir / unlink / shred / truncate
//  - windows cmd: del / erase / rd / rmdir
//  - powershell: Remove-Item / ri / del(alias) / rd(alias)
const DESTRUCTIVE_SHELL_RE = /(^|[\s;&|(])(rm|rmdir|unlink|shred|truncate|del|erase|rd|remove-item|remove-itemproperty)(\s|$)/i;
// 覆盖重定向 ( > file,但放行 >> 追加 )。
const OVERWRITE_REDIR_RE = /[^>]>(?!>)\s*\S/;
// 移动/重命名(变更但通常非破坏性)。
const MOVE_SHELL_RE = /(^|[\s;&|(])(mv|move|ren|rename|move-item)(\s|$)/i;

// 命令的结果文本里表示「目标本就不存在 / 没找到」的 no-op 迹象(中英 + cmd/powershell)。
const NOOP_OUTCOME_RE = /找不到|未找到|不存在|没有找到|无法找到|could not find|cannot find|can't find|no such file|not found|does not exist|doesn't exist|nothing to|0 files?\b/i;

// shell 工具名(不同适配器叫法不一)。
const SHELL_TOOL_RE = /^(bash|shell|shellcommand|shell_command|cmd|command|exec|run|terminal|_legacy_cmd)$/i;

const STICKY_WINDOW = 2; // 变更后再注入至多 2 个后续(只读)轮,覆盖「变更→探查→叙述」。

function _enabled(options = {}) {
  if (options && options.actionAttribution !== undefined) {
    return !['0', 'false', 'off', 'no'].includes(
      String(options.actionAttribution).trim().toLowerCase()
    );
  }
  const raw = String(process.env.KHY_ACTION_ATTRIBUTION || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function _resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const parts = [];
  for (const k of ['output', 'stdout', 'stderr', 'content', 'error', 'message', 'text']) {
    const v = result[k];
    if (typeof v === 'string') parts.push(v);
    else if (v && typeof v === 'object') {
      for (const kk of ['message', 'code', 'hint']) if (typeof v[kk] === 'string') parts.push(v[kk]);
    }
  }
  return parts.join(' ');
}

/**
 * 从一条 shell 命令里尽力抽取被操作的目标(引号路径优先,其次动词后的实参)。仅用于让叙述
 * 指令更具体,best-effort,抽不到就返回空。
 * @param {string} command
 * @returns {string[]}
 */
function extractTargets(command) {
  const cmd = String(command || '');
  const targets = [];
  // 1) 引号包裹的路径(cmd 删除里几乎都带引号)。
  const quoted = cmd.match(/"([^"]+)"|'([^']+)'/g);
  if (quoted) {
    for (const q of quoted) targets.push(q.slice(1, -1));
  }
  if (targets.length) return _dedupCap(targets);
  // 2) 退一步:动词后的非选项 token(粗略)。
  const m = cmd.match(/\b(rm|del|erase|rd|rmdir|unlink|mv|move|ren|rename)\b\s+(.+)$/i);
  if (m) {
    for (const tok of m[2].split(/\s+/)) {
      if (tok && !tok.startsWith('-') && !tok.startsWith('/')) targets.push(tok);
    }
  }
  return _dedupCap(targets);
}

function _dedupCap(arr, cap = 4) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const s = String(x).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 判定「刚执行完」的一批工具结果里,有没有变更 / 破坏性动作。确定性,零假阳性优先。
 * @param {Array<{tool?:string,name?:string,params?:object,result?:any}>} toolResults
 * @returns {{mutated:boolean, destructive:boolean, actions:Array<{verb:string,destructive:boolean,target:string[],noop:boolean,tool:string}>}}
 */
function classifyToolBatch(toolResults) {
  const actions = [];
  const list = Array.isArray(toolResults) ? toolResults : [];
  for (const tr of list) {
    if (!tr) continue;
    const tool = String(tr.tool || tr.name || '');
    const params = tr.params || tr.input || {};
    const resText = _resultText(tr.result);
    const noop = NOOP_OUTCOME_RE.test(resText);

    if (SHELL_TOOL_RE.test(tool)) {
      const command = String(params.command || params.cmd || params.script || '');
      if (!command) continue;
      if (DESTRUCTIVE_SHELL_RE.test(command) || OVERWRITE_REDIR_RE.test(command)) {
        actions.push({ verb: 'delete', destructive: true, target: extractTargets(command), noop, tool });
      } else if (MOVE_SHELL_RE.test(command)) {
        actions.push({ verb: 'move', destructive: false, target: extractTargets(command), noop, tool });
      }
    } else if (MUTATING_TOOL_RE.test(tool)) {
      const dest = /diskcleanup|del|remove|rm/i.test(tool);
      const target = [];
      for (const k of ['file_path', 'path', 'filePath', 'target', 'source', 'dest']) {
        if (typeof params[k] === 'string') target.push(params[k]);
      }
      actions.push({ verb: 'modify', destructive: dest, target: _dedupCap(target), noop, tool });
    }
  }
  return {
    mutated: actions.length > 0,
    destructive: actions.some(a => a.destructive),
    actions,
  };
}

/**
 * 构建「自我动作认领」中文 [SYSTEM:] 指令(确定性,无随机)。供上层注入工具结果回灌消息,
 * 让模型在叙述**之前**读到。
 * @param {object} ctx
 * @param {Array<{verb:string,destructive:boolean,target:string[],noop:boolean}>} ctx.actions
 * @returns {string}
 */
function buildAttributionDirective(ctx = {}) {
  const actions = Array.isArray(ctx.actions) ? ctx.actions : [];
  const destructive = actions.some(a => a.destructive);
  const anyNoop = actions.some(a => a.noop);
  const targets = _dedupCap(actions.flatMap(a => Array.isArray(a.target) ? a.target : []), 4);

  const lines = [];
  lines.push('[SYSTEM: 自我动作认领 —— 你刚刚**亲自**执行了'
    + (destructive ? '删除/覆盖等变更操作' : '变更操作')
    + (targets.length ? `(目标:${targets.join('、')})` : '')
    + '。叙述结果时请遵守:');
  lines.push('1. **认领你自己的动作**:用第一人称、主动语态说明你做了什么(例如「我已执行删除命令」「我修改了 X」),不要把你刚做的事说成被动发生的。');
  lines.push('2. **禁止甩锅给模糊外因**:在没有证据时,不要把你自己刚执行的结果归因为「可能之前已经被清理过」「可能是别人/更早的操作做的」这类未知过去原因——那会让因果自相矛盾(你明明刚亲手做了)。');
  if (anyNoop) {
    lines.push('3. **命令报告目标不存在时如实说清因果**:这次命令显示目标「找不到/已不存在」。请准确叙述真实因果——是「我执行了删除命令,但系统显示这些文件在执行时已不在该路径」,而不是含糊的「可能之前被清理过」;区分「我删除了它」与「我执行删除时它本就不在」,二者不要混为一谈。');
  }
  lines.push((anyNoop ? '4' : '3') + '. **保持因果链连贯**:我执行了 X → 结果是 Y → 所以现在状态是 Z。不要在同一段里既说自己做了、又把它推给未知过去。]');
  return lines.join('\n');
}

/**
 * 创建粘性状态(由 loop 持有,跨迭代)。
 * @returns {{pending:Array, sinceMutation:number}}
 */
function createAttributionState() {
  return { pending: [], sinceMutation: 0 };
}

/**
 * 记录「刚执行完」的一批工具结果并裁决是否注入指令(单一真源主入口)。
 *
 * 语义:本批含变更动作 → 累积进 pending、窗口归零;本批无变更但有 pending → 窗口 +1。
 * 当 pending 非空且仍在 STICKY_WINDOW 内 → 产出指令(让本批结果回灌时附带,使后续叙述轮可见)。
 *
 * @param {object} state    createAttributionState() 的返回值(就地更新)
 * @param {Array}  toolResults  本轮工具结果
 * @param {object} [opts]
 * @param {object} [opts.options]  门控覆盖(options.actionAttribution)
 * @returns {{mutated:boolean, destructive:boolean, actions:Array, directive:(string|null)}}
 */
function recordToolBatch(state, toolResults, opts = {}) {
  const st = state && typeof state === 'object' ? state : createAttributionState();
  if (!Array.isArray(st.pending)) st.pending = [];
  const enabled = _enabled(opts.options || {});
  const batch = classifyToolBatch(toolResults);

  if (batch.mutated) {
    st.pending.push(...batch.actions);
    st.pending = st.pending.slice(-5); // 只记最近几次,避免无界增长
    st.sinceMutation = 0;
  } else if (st.pending.length > 0) {
    st.sinceMutation += 1;
  }

  const within = st.pending.length > 0 && st.sinceMutation <= STICKY_WINDOW;
  const directive = (enabled && within)
    ? buildAttributionDirective({ actions: st.pending })
    : null;

  return { ...batch, directive };
}

module.exports = {
  STICKY_WINDOW,
  extractTargets,
  classifyToolBatch,
  buildAttributionDirective,
  createAttributionState,
  recordToolBatch,
};
