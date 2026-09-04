'use strict';

/**
 * Harness/protocol context resolution extracted from runToolUseLoop
 * (T-021 C3-P2 — reuses the C3-P1 mutation-free cluster pattern).
 *
 * Owns, verbatim from the former loop body:
 *   - model-capability tier → harness profile (only T0/frontier relaxes; see
 *     modelTier.js) — resolved early so its dials shape the loop cap and the
 *     scaffolding gates downstream
 *   - "model lacks reliable native tool calling" detection (gate-aware SSOT
 *     modelToolingCapability + measured verdicts from toolCapabilityStore;
 *     fail-soft → stays false → legacy warning text, byte-identical)
 *   - tool-call PROTOCOL seam: explicit options.toolCallProtocol is
 *     authoritative; otherwise the harness profile default. Only the TEXT
 *     branch routes through the adapter.
 *
 * Pure resolution: reads options/env + **injected** service modules, never
 * mutates loop state. ZERO requires in this module — requiring gateway/adapter
 * modules statically would join the existing require-graph SCC (R3 gate
 * blocks any cycle that gains a member); the caller keeps the lazy requires
 * exactly where they were and injects them here. The caller destructures the
 * returned bag into the original underscore names, so all downstream
 * references stay unchanged.
 */

function resolveProtocolContext(deps) {
  const { chatOpts, options, modelTier, loopBreadcrumb, toolCap, toolCapStore, toolProtocolAdapter } =
    deps;

  // Model-capability tier → harness profile. Resolved early (the model id is
  // available from options/chatOpts before effectiveChatOpts is built) so its
  // dials can shape the loop cap below and the scaffolding gates downstream.
  // Only T0 (frontier) relaxes; T1/T2/T3 keep current behavior. See modelTier.js.
  const harnessProfile = modelTier.harnessProfile(
    modelTier.resolveTier(
      String(
        (chatOpts && chatOpts.model) || options?.model || process.env.GATEWAY_PREFERRED_MODEL || ''
      )
    )
  );
  loopBreadcrumb('harness-profile', harnessProfile);

  // Is the active model known to LACK reliable native tool calling? If so, the
  // text-parse fallback below (a turn with no structured toolUseBlocks) is the
  // EXPECTED, first-class path — the model is driven via <tool_call> text
  // interception, NOT an adapter defect — so we emit a calm breadcrumb instead of
  // the alarming "adapter should return structured blocks" warning. This is the
  // mechanism that lets pure-text models (no function calling) still call khy
  // tools. SSOT: modelToolingCapability (gate-aware; off → stays false → legacy
  // warning text, byte-identical).
  let modelLacksNativeTools = false;
  try {
    const modelForCap = String(
      (chatOpts && chatOpts.model) || options?.model || process.env.GATEWAY_PREFERRED_MODEL || ''
    );
    // 名字只作辅助:实测裁决(toolCapabilityStore 的 live probe / 被动学习)胜过按名字的
    // SMALL_MODEL_HINTS 启发。与三处决策门(khyUpgradeRuntime 教学门 + relay/multiFree 剥离门)
    // 同源同参——此前本处漏传 measured,名字在此成了事实主判据(一个实测能原生调工具的
    // flash/lite 模型仍被误标为「文本协议·预期」)。best-effort:store 不可用 → measured=null →
    // 回落 provisional 名字启发(仍安全)。
    let measuredCap = null;
    try {
      measuredCap = toolCapStore.getVerdict(modelForCap);
    } catch {
      /* best effort */
    }
    modelLacksNativeTools =
      toolCap.isEnabled() &&
      toolCap.modelLacksReliableToolCalling(modelForCap, { measured: measuredCap });
  } catch {
    /* fail-soft: keep the alarming default off */
  }

  // Tool-call PROTOCOL seam. The unified loop serves both cloud (native tool_use)
  // and weak-local (text <tool_call>) models. The active protocol is dispatch-
  // driven: an explicit options.toolCallProtocol (set by the local-mode dispatch,
  // which KNOWS it is talking to a local adapter) is authoritative; otherwise fall
  // back to the harness profile (default 'native' for every tier). Only the TEXT
  // branch routes through the adapter — the native parse/format stays inline and
  // byte-identical, so the cloud path is untouched.
  const toolProtocolAdapterRef = toolProtocolAdapter;
  const activeProtocol =
    options && (options.toolCallProtocol === 'text' || options.toolCallProtocol === 'native')
      ? options.toolCallProtocol
      : harnessProfile.toolCallProtocol || 'native';
  const isTextProtocol = activeProtocol === 'text';
  const activeAdapter = toolProtocolAdapterRef.resolveAdapter(activeProtocol);
  if (isTextProtocol) {
    loopBreadcrumb('tool-protocol', { protocol: activeProtocol });
  }

  return { harnessProfile, modelLacksNativeTools, activeProtocol, isTextProtocol, activeAdapter };
}

module.exports = { resolveProtocolContext };
