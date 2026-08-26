'use strict';

/**
 * executionComplexitySignals.js — 从「执行证据」而非「用户措辞」判定任务复杂度
 * (纯叶子:零 IO、确定性、绝不抛、可单测)。
 *
 * 背景(goal「让 khyos 完成复杂任务的能力」实测):复杂度判定目前**只在开工前按用户
 * 消息的文本表面打一次分**,执行过程中暴露出的真实规模从不回头修正。实测反例
 * (taskComplexity.isComplexTask / taskScale.resolveTaskScale):
 *
 *   「重构登录模块,保持对外 API 不变」        → cplx=0 simple / scale=normal
 *   「把整个后端的错误处理统一成一套」        → cplx=0 simple / scale=small(!)
 *   「给项目加上端到端测试」                  → cplx=0 simple
 *   「帮我看看 auth 的 login token 和 db …」  → cplx=2(比上面所有真实重构都高)
 *
 * 即:简短表述的真实复杂任务全部判为简单,而啰嗦的简单提问反而得分更高——判据是
 * **措辞的繁简**,不是**活儿的大小**。后果是这类任务拿不到规划注入
 * (taskComplexity.injectPlanningPrompt 的 <execution_plan>)、拿不到自动分解提示,
 * 于是模型一头扎进去、跑几十轮后失焦,正是「复杂任务做不完」的主因之一。
 *
 * 本叶子补上缺失的那一环:**执行中复杂度升级**。它只看循环已经积累的客观证据
 * (改过几个文件、跨了几个目录、烧了几轮、连续失败几次),当真实规模越过阈值时,
 * 判定「这活儿比开场判定的大」,由上层一次性注入一条指令,要求模型先摆计划、把剩余
 * 工作登记到任务板(TaskCreate/TaskUpdate)再继续。
 *
 * 与既有件的关系(正交,不重复):
 *  - taskComplexity / taskScale 看「开工前的措辞」;本件看「开工后的事实」。
 *  - modelSwitchManager.maybeEscalate 升级的是**模型档位**;本件升级的是**规划姿态**。
 *  - actionAttribution 讲「叙述别把自己的动作甩给外因」;本件讲「规模超预期就回头补计划」。
 *  - 任务记忆召回(tools/taskMemorySection)已按轮刷新——读侧本就通畅,缺的正是
 *    「规模在执行中浮现时,有谁去触发写侧」。本件就是那个触发器。
 *
 * 契约:
 *   ① 门控 KHY_EXEC_COMPLEXITY_ESCALATION(默认开·关词表与其它门控同款)→ 不升级;
 *   ② 阈值 KHY_EXEC_COMPLEXITY_MIN_SCORE(数值,默认 4,与 isComplexTask 的 >=4 对齐);
 *   ③ 零 IO、不碰文件系统、不改任何状态,只读入参与 env;
 *   ④ 绝不抛:坏数据 / 缺字段 → 退化成「不升级」,绝不阻断工具循环。
 */

// 与其它门控同款 falsy 词表(prompts.getMemorySection / taskMemorySection 一致)。
const _OFF = ['0', 'false', 'off', 'no', 'disable', 'disabled'];

// 变更类工具名(写/编辑/移动/新建)。与 actionAttribution.MUTATING_TOOL_RE 同一族判据;
// 那个常量未导出,此处按同一名单独立成形(两处都是"这些名字算变更"的事实陈述,非逻辑复制)。
const MUTATING_TOOL_RE =
  /^(write|write_file|writefile|file_write|edit|editfile|file_edit|edit_file|multiedit|multi_edit|notebookedit|notebook_edit|applypatch|apply_patch|move|rename|mkdir)$/i;

// 变更类工具里承载目标路径的参数键(与 actionAttribution.classifyToolBatch 同序)。
const _PATH_KEYS = ['file_path', 'path', 'filePath', 'target', 'source', 'dest'];

// 计数上界——超大 toolCallLog 不该让本件变成热点(纯 CPU 也要有界)。
const MAX_SCANNED_CALLS = 500;

/**
 * 升级门控是否开启(默认开)。
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
function isEscalationEnabled(env = process.env) {
  const raw = env && env.KHY_EXEC_COMPLEXITY_ESCALATION;
  return !_OFF.includes(
    String(raw == null ? '' : raw)
      .trim()
      .toLowerCase()
  );
}

/**
 * 解析升级阈值(默认 4,与 taskComplexity.isComplexTask 的 score>=4 对齐)。
 * 非法 / 非正数 → 回退默认值。
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number}
 */
function resolveMinScore(env = process.env) {
  const n = Number.parseInt(String((env && env.KHY_EXEC_COMPLEXITY_MIN_SCORE) || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

/**
 * 取路径的父目录(纯字符串,跨 posix/windows 分隔符)。无分隔符 → ''(根级文件)。
 * @param {string} p
 * @returns {string}
 */
function _dirOf(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : '';
}

/**
 * 单条 toolCallLog 记录是否为「失败」。形制与 loop 内既有判据一致:
 * result 缺失 / success === false / 带 error 字段 → 失败。
 * @param {*} result
 * @returns {boolean}
 */
function _isFailure(result) {
  if (!result || typeof result !== 'object') {
    return false;
  }
  return result.success === false || Boolean(result.error);
}

/**
 * 从累积的 toolCallLog 里收集执行规模信号。纯函数,绝不抛。
 *
 * @param {Array<{tool?:string,params?:object,result?:object}>} toolCallLog
 * @param {object} [opts]
 * @param {number} [opts.iterationsUsed] - 已消耗的循环轮次
 * @returns {{filesTouched:number, dirsTouched:number, mutatingCalls:number,
 *            iterationsUsed:number, failureStreak:number, totalCalls:number}}
 */
function collectExecutionSignals(toolCallLog, opts = {}) {
  const empty = {
    filesTouched: 0,
    dirsTouched: 0,
    mutatingCalls: 0,
    iterationsUsed: 0,
    failureStreak: 0,
    totalCalls: 0,
  };
  try {
    const list = Array.isArray(toolCallLog) ? toolCallLog.slice(-MAX_SCANNED_CALLS) : [];
    const files = new Set();
    const dirs = new Set();
    let mutatingCalls = 0;

    for (const entry of list) {
      if (!entry) {
        continue;
      }
      const tool = String(entry.tool || entry.name || '');
      if (!MUTATING_TOOL_RE.test(tool)) {
        continue;
      }
      mutatingCalls += 1;
      const params = entry.params || entry.input || {};
      for (const k of _PATH_KEYS) {
        const v = params && params[k];
        if (typeof v === 'string' && v.trim()) {
          const norm = v.trim().replace(/\\/g, '/');
          files.add(norm);
          dirs.add(_dirOf(norm));
        }
      }
    }

    // 尾部连续失败数:反复失败意味着当前打法不成立(欠规划),是升级的强信号。
    let failureStreak = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && _isFailure(list[i].result)) {
        failureStreak += 1;
      } else {
        break;
      }
    }

    const iterationsUsed =
      Number.isFinite(opts.iterationsUsed) && opts.iterationsUsed > 0
        ? Math.floor(opts.iterationsUsed)
        : 0;

    return {
      filesTouched: files.size,
      dirsTouched: dirs.size,
      mutatingCalls,
      iterationsUsed,
      failureStreak,
      totalCalls: list.length,
    };
  } catch {
    return empty;
  }
}

/**
 * 按执行信号打复杂度分,并判定是否该升级规划姿态。
 *
 * 打分维度(每条都是「已经发生的事实」,不是对措辞的猜测):
 *   ① 触及文件数   >=6 → +3 ; >=3 → +2      多文件即跨面改动
 *   ② 触及目录数   >=3 → +2                 跨目录即跨模块
 *   ③ 已用轮次     >=14 → +2 ; >=8 → +1     长链条本身就是复杂度
 *   ④ 变更调用数   >=5 → +1                 改动密度
 *   ⑤ 尾部连败     >=3 → +2                 反复失败 = 欠规划
 *
 * @param {object} signals - collectExecutionSignals 的返回
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{escalate:boolean, score:number, minScore:number, reasons:string[]}}
 */
function assessExecutionComplexity(signals, env = process.env) {
  const inert = { escalate: false, score: 0, minScore: resolveMinScore(env), reasons: [] };
  try {
    if (!isEscalationEnabled(env)) {
      return inert;
    }
    const s = signals || {};
    const files = Number(s.filesTouched) || 0;
    const dirs = Number(s.dirsTouched) || 0;
    const iters = Number(s.iterationsUsed) || 0;
    const mutating = Number(s.mutatingCalls) || 0;
    const streak = Number(s.failureStreak) || 0;

    let score = 0;
    const reasons = [];

    if (files >= 6) {
      score += 3;
      reasons.push(`已改动 ${files} 个文件`);
    } else if (files >= 3) {
      score += 2;
      reasons.push(`已改动 ${files} 个文件`);
    }
    if (dirs >= 3) {
      score += 2;
      reasons.push(`跨 ${dirs} 个目录`);
    }
    if (iters >= 14) {
      score += 2;
      reasons.push(`已消耗 ${iters} 轮`);
    } else if (iters >= 8) {
      score += 1;
      reasons.push(`已消耗 ${iters} 轮`);
    }
    if (mutating >= 5) {
      score += 1;
      reasons.push(`${mutating} 次写入/编辑`);
    }
    if (streak >= 3) {
      score += 2;
      reasons.push(`末尾连续 ${streak} 次工具失败`);
    }

    const minScore = resolveMinScore(env);
    return { escalate: score >= minScore, score, minScore, reasons };
  } catch {
    return inert;
  }
}

/**
 * 构建一次性「规模超预期,回头补计划」指令。escalate 为假 → null(不花上下文)。
 *
 * 指令让模型做两件既有机制已支撑、但此前无人触发的事:
 *   ① 摆一份 <execution_plan>(与 taskComplexity.injectPlanningPrompt 同一形制,
 *      下游 parseExecutionPlan / matchToolCallToStep 已能解析并跟踪步进);
 *   ② 把剩余工作登记到任务板(TaskCreate/TaskUpdate)——任务记忆按轮回灌
 *      (tools/taskMemorySection),登记后模型每轮都能看见,不再失焦。
 *
 * 遵守状态透明红线:指令里陈述的是「动作 + 目标 + 进度」的具体事实(改了几个文件、
 * 跨几个目录、用了几轮),没有「正在处理…」式模糊话。
 *
 * @param {{escalate:boolean, score:number, reasons:string[]}} assessment
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string|null}
 */
function buildEscalationDirective(assessment, env = process.env) {
  try {
    if (!isEscalationEnabled(env)) {
      return null;
    }
    const a = assessment || {};
    if (!a.escalate) {
      return null;
    }
    const reasons = Array.isArray(a.reasons) ? a.reasons.filter(Boolean) : [];
    const evidence = reasons.length > 0 ? reasons.join('、') : '执行规模已超出开场判定';

    return [
      '[SYSTEM: 规模复核——这个任务的实际规模比开场判定的大(' + evidence + ')。',
      '开场时它被当作简单任务处理,没有排计划。现在补上,再继续:',
      '① 用 <execution_plan> 标签摆一份剩余步骤(2-5 步,写明具体文件/函数名);',
      '② 把其中尚未完成的步骤用 TaskCreate 登记到任务板,开始做某步时 TaskUpdate 置 in_progress、做完置 completed',
      '(任务板每轮都会回灌给你,登记后就不会丢);',
      '③ 然后立即继续执行第一个未完成步骤——不要重做已完成的部分。',
      '本提示只出现一次。]',
    ].join(' ');
  } catch {
    return null;
  }
}

module.exports = {
  isEscalationEnabled,
  resolveMinScore,
  collectExecutionSignals,
  assessExecutionComplexity,
  buildEscalationDirective,
  MUTATING_TOOL_RE,
  MAX_SCANNED_CALLS,
};
