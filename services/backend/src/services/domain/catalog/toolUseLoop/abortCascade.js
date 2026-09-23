'use strict';

/**
 * domain/catalog/toolUseLoop/abortCascade.js — the two-tier AbortController cascade,
 * extracted verbatim from runToolUseLoop's body (T-021 in-body phase slice #2).
 *
 * `setupAbortCascade(deps)` builds the session-level `parentAbort`, wires it to the
 * caller-supplied external abort signal (`options.abortSignal` / `options.signal`) and to
 * the mutable `interruptSignal` (500ms self-cleaning poll → chunk-level interrupt), then
 * resolves the tool-execution abort signal (`_toolAbortSig`, gated by
 * KHY_TOOL_ABORT_SIGNAL) and defines the per-iteration sibling-abort factory
 * (`_createSiblingAbort`, links a child controller to parentAbort).
 *
 * Behavior-preserving: called at the EXACT source position it replaced, so parentAbort
 * construction / externalSignal listener registration / the 500ms timer all fire at the
 * same instant as before. The core destructures the returned bag back into the original
 * names (`parentAbort`, `externalSignal`, `_toolAbortSig`, `_isAborted`,
 * `_createSiblingAbort`) so all downstream reads (`parentAbort.signal.aborted` at the
 * tool-exec guards, `externalSignal.aborted`, `_toolAbortSig` into
 * `_buildToolInterruptPlan`) stay byte-identical. `_isAborted` + `_createSiblingAbort`
 * are carried verbatim even though currently unreferenced (cooperative-cancellation
 * granularity is a SEPARATE behavior changeset, not this pure refactor).
 *
 * Leaf deps: only `options` + `interruptSignal` (both already in scope at the call site).
 * `require('../../flagRegistry')` re-based for this dir; AbortController / setInterval /
 * process.env are globals. NO core back-edge (M6 cycles stay 0).
 */

function setupAbortCascade(deps = {}) {
  const options = deps.options;
  const interruptSignal = deps.interruptSignal;

  // ── 双层 AbortController 级联（借鉴 Claude Code parent→sibling→child） ──
  // parentAbort: 整个会话级取消（用户中断/超时），杀死所有子操作
  // siblingAbort: 单轮迭代级取消（工具执行超时），不影响整个会话
  const parentAbort = new AbortController();
  const externalSignal = options.abortSignal || options.signal || null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      parentAbort.abort(externalSignal.reason || 'external abort');
    } else {
      externalSignal.addEventListener(
        'abort',
        () => {
          try {
            parentAbort.abort(externalSignal.reason || 'external abort');
          } catch {
            /* ignore */
          }
        },
        { once: true }
      );
    }
  }
  const _isAborted = () => parentAbort.signal.aborted;

  // D9: Cascade interruptSignal → parentAbort for chunk-level interrupt
  // This ensures that when an interrupt arrives mid-stream, the streaming
  // response from the AI provider is immediately aborted (not waiting for iteration end)
  // Self-cleaning: stops once interrupt fires or parentAbort is already aborted
  if (interruptSignal) {
    const _iw = setInterval(() => {
      if (parentAbort.signal.aborted) {
        clearInterval(_iw);
        return;
      }
      if (interruptSignal.interrupted) {
        clearInterval(_iw);
        parentAbort.abort('interrupt');
      }
    }, 500);
    if (_iw.unref) {
      _iw.unref();
    }
  }

  // ESC / 用户中断 → 执行中的工具取消:parentAbort 只在真·中断(外部 abort / interruptSignal)
  // 时触发,把它的 signal 穿进工具执行(traceContext.abortSignal),让一次长搜索/抓取/DB 查询
  // 在按 ESC 时立即松手,而不是苦等工具的 120s 硬超时。门控 KHY_TOOL_ABORT_SIGNAL(默认开);
  // 关 → null → toolCalling 不与工具竞赛(byte-identical)。安全:parentAbort 无自发 abort。
  let _toolAbortEnabled = true;
  try {
    _toolAbortEnabled = require('../../flagRegistry').isFlagEnabled(
      'KHY_TOOL_ABORT_SIGNAL',
      process.env
    );
  } catch {
    _toolAbortEnabled = true;
  }
  const _toolAbortSig = _toolAbortEnabled ? parentAbort.signal : null;

  // 每轮迭代创建一个 siblingAbort（链接 parentAbort）
  function _createSiblingAbort() {
    const sibling = new AbortController();
    const onParentAbort = () => {
      try {
        sibling.abort(parentAbort.signal.reason || 'parent abort');
      } catch {
        /* ignore */
      }
    };
    if (parentAbort.signal.aborted) {
      sibling.abort(parentAbort.signal.reason || 'parent abort');
    } else {
      parentAbort.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    return {
      controller: sibling,
      signal: sibling.signal,
      abort: (reason) => {
        try {
          sibling.abort(reason);
        } catch {
          /* ignore */
        }
      },
      cleanup: () => {
        parentAbort.signal.removeEventListener('abort', onParentAbort);
      },
    };
  }
  return {
    parentAbort,
    externalSignal,
    _toolAbortSig,
    _isAborted,
    _createSiblingAbort,
  };
}

module.exports = { setupAbortCascade };
