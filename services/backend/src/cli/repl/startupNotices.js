'use strict';

/**
 * Post-banner best-effort startup notices for the classic REPL welcome box.
 *
 * Split from cli/repl/startupHeader.js (behavior-preserving leaf): three
 * independent, fail-soft notice blocks that render AFTER the bordered header —
 * model-retirement warning, unfinished-build resume hint, rotating startup tip.
 * Each is best-effort and never blocks startup; none touches the factory deps
 * except c (chalk), modelName and adapterName, so it lifts cleanly to module scope.
 */

function printPostBannerNotices(c, modelName, adapterName) {
  const dim = c.dim;

    // ── 模型退役启动提示（对齐 CC 启动期 model-deprecation-warning）──
  // 门控 KHY_MODEL_DEPRECATION_NOTICE（默认开）。若当前钉选模型已排定退役日期，
  // 启动时给一行 CC 风格提示（时态感知：已于/将于）。当前 khy 型号(opus-4-x 等)不在
  // 退役表 → 无提示；仅当有人钉到旧代模型才触发。全 best-effort，绝不阻断启动。
  try {
    const fp = require('../../services/futureProofing');
    const notice = fp.getModelRetirementNotice(modelName, {
      adapterName,
      nowMs: Date.now(),
    });
    if (notice) {
      console.log('  ' + c.yellow(notice));
      console.log('');
    }
  } catch {
    /* 退役提示是增益，绝不阻断启动 */
  }

  // ── 未完成构建发现横幅 ──
  // 若当前工作目录存在被打断（断电/断网/token耗尽/Ctrl+C/khy故障）残留的可续检查点，
  // 在启动时主动提示，并给出确切续作命令。全 best-effort，绝不阻断启动。
  try {
    const resumeAdvisor = require('../../services/resumeAdvisor');
    try {
      resumeAdvisor.pendingForCwd && require('../../services/boulderState').purgeExpired?.();
    } catch {
      /* purge is optional */
    }
    const pending = resumeAdvisor.pendingForCwd(process.cwd());
    if (pending) {
      const hint = resumeAdvisor.formatStartupHint(pending, { color: c });
      if (hint) {
        console.log(hint);
        console.log('');
      }
    }
  } catch {
    /* 发现性是增益，绝不阻断启动 */
  }

  // ── 启动轮换提示（对齐 CC tips「背后的逻辑」）──
  // 门控 KHY_STARTUP_TIPS（默认开）。从内置 tips 注册表按 per-tip cooldownSessions 冷却 +
  // isRelevant 相关性过滤，选「最久未显示」的一条，跨会话持久化 numStartups/tipsHistory，
  // 在横幅后浮现一行。门控关/无候选 → 不显示（逐字节回退今日行为：今日 tips 为死代码，
  // 本就不显示任何提示）。全 best-effort，绝不阻断启动。
  try {
    const tipStore = require('../../services/tipHistoryStore');
    const tip = tipStore.bumpStartupAndSelectTip(process.env);
    if (tip && tip.text) {
      console.log('  ' + dim('※ 提示  ' + tip.text));
      console.log('');
    }
  } catch {
    /* 轮换提示是增益，绝不阻断启动 */
  }
}

module.exports = { printPostBannerNotices };
