'use strict';

/**
 * ilinkWorkspaceRouting — IlinkDispatcher 的「按账号绑定路由」职责簇。
 *
 * 从 ilinkDispatcher.js 拆出的第二簇。这一簇回答的是一个问题：
 * **「这条消息属于哪个工作空间 / 哪个 agent，跑完怎么原样还回去」**。
 *
 * 拆分的必要性（不只是行数问题）：
 *   这段代码是全文件**唯一**会改**进程级**状态的地方 —— `KHYQUANT_CWD` 环境变量、
 *   `process.cwd()`、以及 active-agent 指针，三者都是跨账号共享的。它必须持有
 *   严格的「谁在改、按什么顺序改、失败怎么退化、以及必须按 LIFO 逆序还原」这套
 *   不变量。把这条不变量单独放一处，评审时才有单一焦点；埋在一个千行类里，
 *   任何一次无关重构都可能悄悄破坏 restore 顺序。
 *
 * 依赖注入（与拆分前逐字节同构）：
 *   解析器函数由调用方传入（`resolveBindingStore` / `resolveWorkspaceRouter`），
 *   它们各自保留「测试注入优先、否则惰性 require 真模块、不可解则 null」的语义。
 *   本模块因此不 require 任何 ilink 内部件 —— 它只依赖两个解析器与 accountId。
 *
 * 契约：
 *   - 返回的 restore 函数**永远可调用**（无事发生时是 no-op）。
 *   - 端到端 fail-soft：任何一步失败都退化为「未绑定」，绝不抛。
 *   - restore 按 LIFO 逆序回放，每步单独 try —— 一个还原失败不影响其余。
 */

/**
 * 按账号绑定把当前查询路由进对应工作空间/agent，返回一个还原函数。
 *
 * **必须在全局独占锁内调用**：它改的是跨账号共享的进程级状态。锁保证没有别的
 * 账号查询并发在跑，所以这个「按时间片隔离」不会引入并发独立 agent。
 *
 * @param {object} deps
 * @param {string} deps.accountId              归属账号（空 → 不做任何路由）
 * @param {Function} deps.resolveBindingStore   () => store|null
 * @param {Function} deps.resolveWorkspaceRouter() => router|null
 * @returns {Function} restore 函数（永远安全可调）
 */
function applyBindingRouting(deps = {}) {
  const noop = () => {};
  const acc = deps.accountId;
  if (!acc) {
    return noop;
  }
  const resolveBindingStore = deps.resolveBindingStore;
  const resolveWorkspaceRouter = deps.resolveWorkspaceRouter;

  // ① Read the binding. Any failure → treat as unbound.
  let binding = null;
  try {
    const store = typeof resolveBindingStore === 'function' ? resolveBindingStore() : null;
    binding = store && typeof store.getBinding === 'function' ? store.getBinding(acc) : null;
  } catch {
    binding = null;
  }
  if (!binding) {
    return noop;
  }

  const workspace = String(binding.workspace || '').trim();
  const agent = String(binding.agent || '').trim();
  if (!workspace && !agent) {
    return noop;
  }

  const router = typeof resolveWorkspaceRouter === 'function' ? resolveWorkspaceRouter() : null;
  if (!router) {
    return noop;
  }

  const restores = [];

  // ② cwd switch. Capture prior KHYQUANT_CWD (may be unset) + process.cwd so
  //    restore is exact — including deleting the env var when it was unset.
  if (workspace && typeof router.switchCwd === 'function') {
    // Capture the restore baseline defensively: reading process.cwd() throws
    // if the current directory was deleted / became inaccessible, and env
    // reads are similarly guarded. Without a reliable baseline we cannot
    // guarantee an exact restore, so we abandon the cwd switch entirely and
    // proceed at the default cwd — honoring the module's fail-soft contract
    // (a failed switch degrades to "unbound", never throws).
    let baseline = null;
    try {
      baseline = {
        hadEnvCwd: Object.prototype.hasOwnProperty.call(process.env, 'KHYQUANT_CWD'),
        prevEnvCwd: process.env.KHYQUANT_CWD,
        prevProcCwd: process.cwd(),
      };
    } catch {
      /* fail-soft: cannot read current cwd/env → skip cwd switch */
    }
    if (baseline) {
      try {
        const res = router.switchCwd(workspace);
        if (!res || res.switched !== false) {
          restores.push(() => {
            // Restore chdir + env via the same switcher (keeps both cwd sources
            // in sync), then fix the env var if it was originally unset.
            try {
              router.switchCwd(baseline.prevProcCwd);
            } catch {
              /* best effort */
            }
            try {
              if (baseline.hadEnvCwd) {
                process.env.KHYQUANT_CWD = baseline.prevEnvCwd;
              } else {
                delete process.env.KHYQUANT_CWD;
              }
            } catch {
              /* best effort */
            }
          });
        }
      } catch {
        /* fail-soft: cwd switch failed → proceed at default cwd */
      }
    }
  }

  // ③ agent switch. Capture prior active id; setActiveAgent throws for an
  //    unknown agent → skip (proceed with default agent). Restore to prior id,
  //    or clear the pointer when there was none.
  if (agent && typeof router.setActiveAgent === 'function') {
    try {
      const prevAgent =
        typeof router.getActiveAgentId === 'function' ? router.getActiveAgentId() : null;
      router.setActiveAgent(agent);
      restores.push(() => {
        try {
          if (prevAgent) {
            router.setActiveAgent(prevAgent);
          } else if (typeof router.clearActiveAgent === 'function') {
            router.clearActiveAgent();
          }
        } catch {
          /* best effort */
        }
      });
    } catch {
      /* fail-soft: unknown agent → proceed with default agent */
    }
  }

  if (!restores.length) {
    return noop;
  }
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) {
      try {
        restores[i]();
      } catch {
        /* best effort: never throw on restore */
      }
    }
  };
}

module.exports = { applyBindingRouting };
