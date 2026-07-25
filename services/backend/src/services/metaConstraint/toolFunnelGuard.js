'use strict';

/**
 * toolFunnelGuard.js — the executeTool integration seam for the dynamic adaptive
 * constraint engine ([DESIGN-ARCH-034] 接管点：「让能力地板在真实工具链路生效」).
 *
 * 元约束求解层（capabilityProbe → riskClassifier → constraintMatrix → solver）本身
 * 是纯计算，`MetaConstraintSolver.applyToTicket` 把能力地板叠加进一张 metaplan 票据
 * 但**不会**自己执行。本守卫把那条接缝接到唯一的工具调度漏斗 `executeTool` 上：
 * 在执行前，按**执行该动作的模型**的能力向量求出约束地板，并据此对**这一次具体调用**
 * 真正挂载锁具：
 *
 *   Prompt_Soft  → 放行（宾客原则：强模型零校验损耗，不拖入任何重校验）。
 *   Code_Hard    → 对候选 `content` 跑 metaplan 代码拦截器（AST/语法），不过即拦截
 *                  （高压电笼：弱模型连改注释都过代码级物理阻断，越权由代码层挡死）。
 *   System_Block → 极危/不可逆操作要求显式确认；既有系统调用网关已盖
 *                  EXEC_APPROVED 戳的视为已确认（绝不二次打断）；无确认通道则
 *                  fail-closed 拦截。
 *
 * 设计铁律（与 [DESIGN-ARCH-034] §6 防呆一致）：
 *   - 零侵入：本守卫只读 solver/metaplan 两套单一真源，自身不持有约束知识副本，
 *     不改 tool-use loop、不改调度器；它是 executeTool 漏斗里一枚可一键关闭的闸门。
 *   - kill-switch：`KHY_METACONSTRAINT=off` 整体旁路。
 *   - fail-open：能力层加载/求解异常一律落回既有管线（既有权限/网关/锁仍把关），
 *     绝不因本层抖动卡死或误杀工具调用。**唯一**例外是已判定 System_Block 且
 *     拿不到确认通道时 fail-closed（安全方向）——那是「该锁的没锁上」而非「本层崩了」。
 *   - 只增不减：能力地板经 `escalate` 进同一单调格，只能把策略抬严，绝不放松红线/熔断。
 */

const { MetaConstraintSolver } = require('./index');
const injection = require('../metaplan/constraintInjection');
const strategy = require('../metaplan/constraintStrategy');

const SOFT = strategy.STRATEGIES.PROMPT_SOFT;
const HARD = strategy.STRATEGIES.CODE_HARD;
const BLOCK = strategy.STRATEGIES.SYSTEM_BLOCK;

const _solver = new MetaConstraintSolver();

// 文件扩展名 → metaplan 语言 + 该语言对应的代码拦截器执行器。语言决定 Code_Hard
// 究竟挂哪一类 AST 校验器（js→babel / py→python_ast / 其余→vm_or_native 配平探测）。
const EXT_TABLE = {
  '.js': { language: 'javascript', executor: 'js_babel_writer' },
  '.mjs': { language: 'javascript', executor: 'js_babel_writer' },
  '.cjs': { language: 'javascript', executor: 'js_babel_writer' },
  '.jsx': { language: 'jsx', executor: 'js_babel_writer' },
  '.ts': { language: 'typescript', executor: 'js_babel_writer' },
  '.tsx': { language: 'tsx', executor: 'js_babel_writer' },
  '.py': { language: 'python', executor: 'py_ast_replacer' },
};

/** Resolve the file path a write-style tool targets, across common param names. */
function _pathOf(params) {
  if (!params || typeof params !== 'object') return '';
  return String(params.path || params.file || params.filename || params.file_path || params.filePath || '');
}

/** The single candidate content value present at the funnel (write/edit tools). */
function _contentOf(params) {
  if (!params || typeof params !== 'object') return null;
  const c = params.content != null ? params.content
    : (params.new_string != null ? params.new_string : params.text);
  return typeof c === 'string' ? c : null;
}

/** Map a path to {language, executor}; falls back to a naked raw injector. */
function _toolchainForPath(path) {
  const lower = String(path || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  return EXT_TABLE[ext] || { language: '', executor: 'raw_string_injector' };
}

/**
 * Resolve the executing model id. The scheduler does not thread the model into
 * every tool call, so we read it from the trace context first (threaded by
 * toolUseLoop) and fall back to the gateway's preferred-model env.
 */
function _resolveModelId(traceContext) {
  const fromCtx = traceContext && traceContext.model;
  return String(fromCtx || process.env.GATEWAY_PREFERRED_MODEL || '');
}

/** Whether the syscall gateway already approved this exact call (no re-prompt). */
function _alreadyApproved(params) {
  try {
    const { EXEC_APPROVED } = require('../execApproval');
    return !!(EXEC_APPROVED && params && params[EXEC_APPROVED]);
  } catch {
    return false;
  }
}

/**
 * Demand an explicit System_Block confirmation through the host control channel.
 * Returns true only on an explicit allow; absent a channel it returns false so
 * the caller fail-closes (安全方向).
 */
async function _confirmBlock(traceContext, tool, params, note) {
  const onCtrl = traceContext && typeof traceContext.onControlRequest === 'function'
    ? traceContext.onControlRequest : null;
  if (!onCtrl) return false; // 无确认通道 → 不放行（fail-closed）
  let resp = null;
  try {
    resp = await onCtrl({
      requestId: `mc_block_${tool || ''}`,
      request: {
        subtype: 'can_use_tool',
        tool_name: tool,
        input: { tool, level: 'System_Block', reason: note, params },
      },
    });
  } catch {
    return false;
  }
  // 与 toolCalling/syscallGateway 同一套解码契约：true / 'always' / {behavior:'allow'} 视为放行。
  if (resp === true || resp === 'always' || resp === 'allow-always') return true;
  if (resp === false || resp == null) return false;
  const r = (resp && resp.response) ? resp.response : resp;
  if (!r || typeof r !== 'object') return false;
  const b = String(r.behavior || '').toLowerCase();
  return b === 'allow' || b === 'allow-always';
}

/**
 * The funnel guard. Given a tool call about to execute, solve the capability
 * floor and physically enforce it.
 *
 * @param {object} ctx
 * @param {string} ctx.tool          resolved tool name
 * @param {object} ctx.params        normalized params (the unique value surface)
 * @param {object} [ctx.descriptor]  resolved tool descriptor (unused today, kept for parity)
 * @param {object} [ctx.traceContext] { model, onControlRequest, ... }
 * @returns {Promise<{allow:boolean, error?:string, floor?:string, band?:string,
 *   riskClass?:string, skipped?:boolean, faultSafe?:boolean, preApproved?:boolean,
 *   confirmed?:boolean}>}
 */
async function enforce(ctx = {}) {
  if (process.env.KHY_METACONSTRAINT === 'off') return { allow: true, skipped: true };

  const { tool, params, traceContext } = ctx;
  try {
    const modelId = _resolveModelId(traceContext);
    const selfReport = traceContext && traceContext.capabilitySelfReport;
    const path = _pathOf(params);
    const content = _contentOf(params);
    const command = params && typeof params.command === 'string' ? params.command : '';
    const { language, executor } = _toolchainForPath(path);

    // Seed a baseline (most-permissive) ticket; applyToTicket RAISES it to the
    // capability floor. The toolchain is language-matched so a Code_Hard floor
    // mounts the right interceptor; the baseline strategy is Soft so the floor,
    // not the seed, decides the outcome.
    const baseline = {
      effectiveStrategy: SOFT,
      tool,
      path,
      command,
      content,
      overrides: [],
      _plan: { toolchain: [executor], constraint_strategy: SOFT },
    };
    const ticket = _solver.applyToTicket(baseline, { modelId, selfReport });
    const floor = ticket.effectiveStrategy;
    const cap = ticket.capability || {};
    const meta = { floor, band: cap.band, riskClass: cap.riskClass };

    if (floor === SOFT) return { allow: true, ...meta };

    if (floor === HARD) {
      // 高压电笼的牙齿：对候选代码跑 AST/语法拦截器，语法不过坚决打回。
      // 无 content（如纯删除/读）或无可识别语言 → 没东西可校验 → 放行（地板已尽责）。
      if (content && language) {
        const v = injection.runHardValidation(ticket._plan, content, { language });
        if (v && v.passed === false) {
          const why = (v.violations || []).map((x) => x.error).filter(Boolean).join('；') || '代码级校验未通过。';
          return {
            allow: false,
            ...meta,
            error: `能力地板 [${cap.band}/Code_Hard] 代码级拦截：${why}`,
          };
        }
      }
      return { allow: true, ...meta };
    }

    // System_Block — 极危/不可逆。网关已确认（盖戳）→ 放行不二次打断。
    if (_alreadyApproved(params)) return { allow: true, ...meta, preApproved: true };
    const ok = await _confirmBlock(traceContext, tool, params,
      `能力地板 [${cap.band}/System_Block]：${cap.riskClass} 高危操作需显式确认`);
    if (ok) return { allow: true, ...meta, confirmed: true };
    return {
      allow: false,
      ...meta,
      error: `能力地板 [${cap.band}/System_Block] 拦截：${cap.riskClass} 高危/不可逆操作需显式确认且未获批准（fail-closed）。`,
    };
  } catch {
    // 防呆 fail-open：能力层任何异常都落回既有管线（其自身仍有权限/网关/锁把关），
    // 绝不因本层抖动卡死或误杀。
    return { allow: true, faultSafe: true };
  }
}

module.exports = {
  enforce,
  // exported for unit tests / advanced integration
  _toolchainForPath,
  _resolveModelId,
  _pathOf,
  _contentOf,
};
