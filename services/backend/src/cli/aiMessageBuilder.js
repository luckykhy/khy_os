/**
 * aiMessageBuilder.js — Message construction, gateway generation request, and preflight availability.
 *
 * Extracted from aiChatCore.js. Contains _buildStructuredMessages (message array assembly),
 * _gatewayGenerate (full gateway request with watchdog timers), and _preflightGatewayAvailability
 * (adapter connectivity probe).
 *
 * @module cli/aiMessageBuilder
 */
'use strict';

// ── Imports ──
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtime = require('../services/khyUpgradeRuntime');

const _chatState = require('./aiChatState');

// ── Host-injected deps (set via setAiMessageBuilderDeps) ──
let getGateway = null;
let _resolveLocalPreferredMaxTokens = null;
let _isLocalThinkingModel = null;
let _registerActiveGatewayRequest = null;
let _unregisterActiveGatewayRequest = null;

function setAiMessageBuilderDeps(deps = {}) {
  if (deps.getGateway !== undefined) {
    getGateway = deps.getGateway;
  }
  if (deps._resolveLocalPreferredMaxTokens !== undefined) {
    _resolveLocalPreferredMaxTokens = deps._resolveLocalPreferredMaxTokens;
  }
  if (deps._isLocalThinkingModel !== undefined) {
    _isLocalThinkingModel = deps._isLocalThinkingModel;
  }
  if (deps._registerActiveGatewayRequest !== undefined) {
    _registerActiveGatewayRequest = deps._registerActiveGatewayRequest;
  }
  if (deps._unregisterActiveGatewayRequest !== undefined) {
    _unregisterActiveGatewayRequest = deps._unregisterActiveGatewayRequest;
  }
}

// ── 弱模型核心工具集(按需调用,非跳过)────────────────────────────
// 弱模型(实测缺原生工具调用 / flash-lite 类)注入过多工具会跑偏。仅保留日常按需最常用
// 的核心工具(搜索/读/写/改/内容搜索/文件搜索/命令/定位/提问/待办)+ mcp 视觉工具;
// 其余 160+ 工具不注入,需要时模型仍可调用这些核心工具(如「附近有什么好玩的」→ web_search)。
const _WEAK_CORE_TOOL_RE = [
  /^(websearch|web_search|webfetch|web_fetch|webbrowser)$/i,
  /^(read|readfile|read_file)$/i,
  /^(write|writefile|write_file)$/i,
  /^(edit|editfile|edit_file|multiedit)$/i,
  /^(glob|find_files)$/i,
  /^(grep|rg)$/i,
  /^(bash|shell|shellcommand|shell_command|powershell)$/i,
  /^(open_app|openapp|getlocation|get_location)$/i,
  /^(askuserquestion|todowrite|todo_write)$/i,
  /^mcp__/i,
];
function _isWeakCoreTool(name) {
  const n = String(name || '').trim();
  if (!n) {
    return false;
  }
  return _WEAK_CORE_TOOL_RE.some((re) => re.test(n));
}

// ── Image save/open helpers ──────────────────────────────────────────
/**
 * Save a base64 image to the project disk's tmp\khy-images\ (dedicated output
 * directory on the same drive as the khy-os installation). Falls back to
 * Desktop or os.tmpdir() if unavailable.
 * @param {string} base64OrDataUrl
 * @param {string} [mimeType='image/png']
 * @returns {string|null} file path or null on failure
 */
function _saveImageToDesktop(base64OrDataUrl, mimeType = 'image/png') {
  try {
    let base64 = String(base64OrDataUrl || '');
    const dataUrlMatch = base64.match(/^data:[^;]+;base64,(.+)$/i);
    if (dataUrlMatch) {
      base64 = dataUrlMatch[1];
    }
    if (!base64 || base64.length < 16) {
      return null;
    }

    const ext =
      (mimeType || '').includes('jpeg') || (mimeType || '').includes('jpg')
        ? '.jpg'
        : (mimeType || '').includes('webp')
          ? '.webp'
          : (mimeType || '').includes('gif')
            ? '.gif'
            : '.png';

    // Primary: <drive>:\tmp\khy-images\ (dedicated output dir on same disk as project)
    const { primary, fallback: fallbackDir } = _getKhyOutputDir('images');
    const finalDir = fs.existsSync(primary) || _tryMkdir(primary) ? primary : fallbackDir;

    fs.mkdirSync(finalDir, { recursive: true });
    const fileName = `khy_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    const outFile = path.join(finalDir, fileName);
    fs.writeFileSync(outFile, Buffer.from(base64, 'base64'));
    return outFile;
  } catch {
    return null;
  }
}

function _tryMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the khy output directory (<drive>:\tmp\khy-<subdir>\) based on the drive
 * where this project is installed (derived from __dirname). Falls back to
 * Desktop → tmpdir if the primary dir cannot be created.
 * @param {string} subdir - e.g. 'images' or 'videos'
 * @returns {{dir: string, primary: string, fallback: string}}
 */
function _getKhyOutputDir(subdir) {
  const drive = path.parse(__dirname).root; // e.g. "D:\"
  const primary = path.join(drive, 'tmp', `khy-${subdir}`);
  const fallback = fs.existsSync(path.join(os.homedir(), 'Desktop'))
    ? path.join(os.homedir(), 'Desktop')
    : path.join(os.tmpdir(), `khy-${subdir}`);
  return {
    primary,
    fallback,
    dir: fs.existsSync(primary) || _tryMkdir(primary) ? primary : fallback,
  };
}

/**
 * Open a file with the system default viewer (Windows).
 * Works for both images and videos.
 * @param {string} filePath
 */
function _openFileWithSystemViewer(filePath) {
  if (!filePath || process.platform !== 'win32') {
    return;
  }
  try {
    execSync(`start "" "${filePath}"`, { stdio: 'ignore', shell: 'cmd.exe' });
  } catch {
    /* best-effort */
  }
}

/**
 * Wrap an async operation with a timer-based progress simulation.
 * Fires onProgress at ~5% / ~25% / ~50% / ~75% / ~90% over the given duration.
 * The callback is never called after the wrapped promise resolves.
 * @param {Function} fn        async function to wrap
 * @param {number}   durationMs  estimated total time in ms
 * @param {Function} onProgress  called with (percent: number)
 * @returns {Promise<T>}
 */
async function _withProgressSimulation(fn, durationMs, onProgress) {
  const milestones = [5, 25, 50, 75, 90];
  let timer = null;
  let settled = false;
  let idx = 0;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const tick = () => {
    if (settled) {
      return;
    }
    if (idx < milestones.length) {
      try {
        onProgress(milestones[idx]);
      } catch {
        /* non-essential */
      }
      idx++;
      const delay = durationMs * (idx < milestones.length ? 0.3 : 0.5);
      timer = setTimeout(tick, Math.min(delay, 3000));
    }
  };

  timer = setTimeout(tick, Math.min(durationMs * 0.15, 2000));

  try {
    const result = await fn();
    return result;
  } finally {
    settled = true;
    cleanup();
  }
}

// ── Message Building ──

/**
 * Build structured messages array for adapters that support native message format.
 * This preserves role boundaries instead of flattening into a single string.
 * 支持 Anthropic content blocks（tool_use/tool_result）直接透传。
 * @param {string} systemPrompt
 * @param {Array} messages
 * @returns {Array<{role: string, content: string|Array}>}
 */
function _buildStructuredMessages(systemPrompt, messages) {
  let _contentToText;
  try {
    _contentToText = require('../services/contentBlockUtils').contentToText;
  } catch {
    _contentToText = (c) => String(c || '');
  }

  const result = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === 'system') {
      // 中间 system 消息（如 contextCompressor 摘要）转为 user 角色
      result.push({ role: 'user', content: _contentToText(msg.content) });
    } else if (msg.role === 'tool') {
      result.push({ role: 'user', content: `[Tool Result]\n${_contentToText(msg.content)}` });
    } else if (Array.isArray(msg.content)) {
      // 结构化 content blocks（assistant+tool_use 或 user+tool_result）— 直接透传
      result.push({ role: msg.role, content: msg.content });
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  // A1: 统一角色交替守卫 — 一处修复，所有路径受益
  const { enforceRoleAlternation } = require('../services/contextCompressor');
  const alternated = enforceRoleAlternation(result);

  // A2: tool_use/tool_result 配对修复 — 确保每个 assistant 消息中的 tool_use block
  // 在下一个 user 消息中都有对应的 tool_result。
  // 对标 Claude Code ensureToolResultPairing(): 未配对时注入 placeholder tool_result，
  // 而不是降级 assistant 的 tool_use blocks 为纯文本（降级会丢失结构化上下文）。
  try {
    const { ensureToolResultPairing } = require('../services/contentBlockUtils');
    ensureToolResultPairing(alternated);
  } catch {
    /* contentBlockUtils not available — skip pairing repair */
  }

  return alternated;
}

// ── Gateway Generation ──

async function _gatewayGenerate(
  conversationPrompt,
  fullSystemPrompt,
  messages,
  userMessage,
  opts,
  effortPreset
) {
  const gw = getGateway();
  if (!gw.isInitialized()) {
    await gw.init();
  }

  // top_p is locked by runtime — never allow external override
  const lockedTopP = runtime.lockTopP(userMessage);

  // Inject tool definitions so the model knows what tools are available
  let toolDefs;
  try {
    const { getToolDefinitions } = require('../services/toolCalling');
    toolDefs = getToolDefinitions();
    if (process.env.KHY_DEBUG_TOOLS === '1') {
      console.error(
        `[DEBUG-PROFILE] BEFORE filter: ${toolDefs.length} defs, CU=${toolDefs.some((t) => (t.name || t.function?.name) === 'ComputerUse')}, DC=${toolDefs.some((t) => (t.name || t.function?.name) === 'DesktopControl')}, toolFilter=${opts._agentContext?.toolFilter || '(none)'}`
      );
    }
    // Apply tool profile filter from agent context (e.g. 'explore' → read-only tools)
    if (opts._agentContext?.toolFilter) {
      const { filterToolsByProfile } = require('../tools/toolProfile');
      const toolsMap = new Map(toolDefs.map((t) => [t.name || t.function?.name, t]));
      const filtered = filterToolsByProfile(toolsMap, opts._agentContext.toolFilter);
      const before = toolDefs.length;
      toolDefs = [...filtered.values()];
      const after = toolDefs.length;
      if (process.env.KHY_DEBUG_TOOLS === '1') {
        console.error(
          `[DEBUG-PROFILE] _gw profileFilter=${opts._agentContext.toolFilter} ${before}->${after}`
        );
        const cu = toolDefs.find((t) => (t.name || t.function?.name) === 'ComputerUse');
        const dc = toolDefs.find((t) => (t.name || t.function?.name) === 'DesktopControl');
        console.error(`[DEBUG-PROFILE] After filter: CU=${!!cu} DC=${!!dc}`);
      }
    }
    // Apply disallowedTools denylist as secondary safety layer
    if (opts._agentContext?.disallowedTools?.length > 0) {
      const deny = new Set(opts._agentContext.disallowedTools);
      toolDefs = toolDefs.filter((t) => !deny.has(t.name) && !deny.has(t.function?.name));
    }
  } catch {
    toolDefs = undefined;
  }

  // 弱模型按需裁剪(「工具按需调用,而非跳过」):实测缺原生工具调用(text)或小名弱模型
  // (flash/lite/mini…)拿 172 个工具会跑偏——脑补「系统修复任务」去读 tool_capability.json、
  // 绕开用户的问题。这里只保留**核心按需工具集**(搜索/读/写/改/搜索/命令/定位/提问/待办 +
  // mcp 视觉),其余 160+ 不再注入:需要时(如「附近有什么好玩的」)web_search 仍在、按需调用;
  // 简单问题没有可用工具诱导 → 模型直接作答。原生工具模型不受影响(全量注入)。
  // 门 KHY_WEAK_TOOL_CURATION(默认开);关 → 字节回退今日全量注入。
  try {
    const _curateOff = ['0', 'false', 'off', 'no'].includes(
      String(process.env.KHY_WEAK_TOOL_CURATION || '')
        .trim()
        .toLowerCase()
    );
    if (!_curateOff && Array.isArray(toolDefs) && toolDefs.length > 0) {
      const {
        modelLacksReliableToolCalling,
      } = require('../services/gateway/modelToolingCapability');
      let _measured = null;
      try {
        _measured = require('../services/gateway/toolCapabilityStore').getVerdict(
          opts.preferredModel || ''
        );
      } catch {
        /* store 不可用 → 走名字启发 */
      }
      if (modelLacksReliableToolCalling(opts.preferredModel || '', { measured: _measured })) {
        toolDefs = toolDefs.filter((t) =>
          _isWeakCoreTool(t.name || (t.function && t.function.name))
        );
      }
    }
  } catch {
    /* fail-soft: 裁剪失败 → 全量注入(今日行为) */
  }

  // Forced-summarization turn (toolUseLoop Fix #3): when the loop asks the model
  // to write a closing summary from already-gathered tool data, suppress all
  // function-calling so the model can ONLY produce text. Offering no tools is the
  // reliable lever here — a forced tool_choice would suppress the text instead,
  // the exact opposite of what a summary turn needs. Weak models (e.g.
  // sensenova-flash-lite / minimax) otherwise keep re-calling the same tool and
  // never write the closing answer ("工具✓ 但没输出").
  if (opts._forceNoTools) {
    toolDefs = undefined;
  }

  // Build structured messages array for adapters that support it
  let structuredMessages = _buildStructuredMessages(fullSystemPrompt, messages);

  // Stage 3.5 (small-model pipeline): few-shot tool-use examples for weak T3
  // models — injected only into the model-bound array, never persisted history.
  try {
    const { injectFewShotExamples } = require('../services/fewShotInjector');
    const { _classifyTaskType } = require('./aiTaskClassifier');
    structuredMessages = injectFewShotExamples(structuredMessages, {
      modelId: opts.preferredModel,
      historyMessages: messages,
      taskType: _classifyTaskType(userMessage),
      onLog: (line) => {
        if (typeof opts.onStatus === 'function') {
          opts.onStatus({ phase: 'request', message: line });
        }
      },
    }).messages;
  } catch {
    /* fail-soft: few-shot injection must never break a request */
  }

  // Gateway request watchdogs: abort only when the chain stops making progress.
  // Unlike Promise.race-only timeout, this aborts underlying adapter work so
  // stale streams cannot continue printing after fallback.
  const preferredAdapter = String(
    opts.preferredAdapter !== undefined
      ? opts.preferredAdapter
      : process.env.GATEWAY_PREFERRED_ADAPTER || ''
  )
    .trim()
    .toLowerCase();
  // Detect if a local adapter will be used: either user explicitly preferred it,
  // or the gateway's first available adapter is local (localLLM/ollama).
  let isLocalPreferredAdapter = preferredAdapter === 'localllm' || preferredAdapter === 'ollama';
  if (!isLocalPreferredAdapter && !preferredAdapter) {
    try {
      const firstAvailable = gw.getFirstAvailableAdapter?.();
      if (firstAvailable && (firstAvailable === 'localLLM' || firstAvailable === 'ollama')) {
        isLocalPreferredAdapter = true;
      }
    } catch {
      /* best effort */
    }
  }
  let localLLMStatus = null;
  let localHotAttached = false;
  if (isLocalPreferredAdapter && preferredAdapter !== 'ollama') {
    try {
      const localLLMService = require('../services/localLLMService');
      if (localLLMService && typeof localLLMService.tryAdoptHotRunner === 'function') {
        const adopted = await localLLMService.tryAdoptHotRunner();
        localHotAttached = !!(adopted && adopted.adopted);
      }
      if (localLLMService && typeof localLLMService.getStatus === 'function') {
        localLLMStatus = localLLMService.getStatus();
      }
    } catch {
      /* best effort */
    }
  }

  const defaultStallTimeoutMs = isLocalPreferredAdapter ? 240000 : 300000;
  let GATEWAY_STALL_TIMEOUT_MS = parseInt(
    process.env.KHY_GATEWAY_STALL_TIMEOUT_MS ||
      process.env.KHY_GATEWAY_TIMEOUT_MS ||
      String(defaultStallTimeoutMs),
    10
  );
  const allowShortLocalHard =
    String(process.env.KHY_LOCAL_ALLOW_SHORT_HARD_TIMEOUT || 'false').toLowerCase() === 'true';
  let hardTimeoutAutoRaised = false;
  if (isLocalPreferredAdapter && !allowShortLocalHard) {
    const warmMinHardTimeoutMs = Math.max(
      30000,
      parseInt(process.env.KHY_LOCAL_MIN_HARD_TIMEOUT_MS || '120000', 10) || 120000
    );
    const coldMinHardTimeoutMs = Math.max(
      warmMinHardTimeoutMs,
      parseInt(process.env.KHY_LOCAL_COLD_HARD_TIMEOUT_MS || '180000', 10) || 180000
    );
    const degradedMinHardTimeoutMs = Math.max(
      coldMinHardTimeoutMs,
      parseInt(process.env.KHY_LOCAL_DEGRADED_HARD_TIMEOUT_MS || '210000', 10) || 210000
    );
    const minRequiredStallTimeoutMs = localLLMStatus?.lastError
      ? degradedMinHardTimeoutMs
      : localLLMStatus && localLLMStatus.available && !localLLMStatus.loaded
        ? coldMinHardTimeoutMs
        : warmMinHardTimeoutMs;
    if (GATEWAY_STALL_TIMEOUT_MS < minRequiredStallTimeoutMs) {
      GATEWAY_STALL_TIMEOUT_MS = minRequiredStallTimeoutMs;
      hardTimeoutAutoRaised = true;
    }
  }
  const defaultIdleTimeoutMs = isLocalPreferredAdapter
    ? Math.min(120000, Math.max(0, GATEWAY_STALL_TIMEOUT_MS - 10000))
    : Math.min(45000, Math.max(0, GATEWAY_STALL_TIMEOUT_MS - 5000));
  const configuredIdleTimeoutMs = Math.max(
    0,
    parseInt(process.env.KHY_GATEWAY_IDLE_TIMEOUT_MS || String(defaultIdleTimeoutMs), 10)
  );
  const allowShortLocalIdle =
    String(process.env.KHY_LOCAL_ALLOW_SHORT_IDLE || 'false').toLowerCase() === 'true';
  const baseMinLocalIdleTimeoutMs = Math.max(
    10000,
    parseInt(process.env.KHY_LOCAL_MIN_IDLE_TIMEOUT_MS || '30000', 10) || 30000
  );
  let minLocalIdleTimeoutMs = baseMinLocalIdleTimeoutMs;
  if (isLocalPreferredAdapter && !allowShortLocalIdle) {
    const coldMinIdleTimeoutMs = Math.max(
      minLocalIdleTimeoutMs,
      parseInt(process.env.KHY_LOCAL_COLD_IDLE_TIMEOUT_MS || '90000', 10) || 90000
    );
    const degradedMinIdleTimeoutMs = Math.max(
      coldMinIdleTimeoutMs,
      parseInt(process.env.KHY_LOCAL_DEGRADED_IDLE_TIMEOUT_MS || '120000', 10) || 120000
    );
    if (localLLMStatus?.lastError) {
      minLocalIdleTimeoutMs = degradedMinIdleTimeoutMs;
    } else if (localLLMStatus && localLLMStatus.available && !localLLMStatus.loaded) {
      minLocalIdleTimeoutMs = coldMinIdleTimeoutMs;
    }
  }
  let GATEWAY_IDLE_TIMEOUT_MS =
    isLocalPreferredAdapter && !allowShortLocalIdle && configuredIdleTimeoutMs > 0
      ? Math.min(
          Math.max(0, GATEWAY_STALL_TIMEOUT_MS - 5000),
          Math.max(configuredIdleTimeoutMs, minLocalIdleTimeoutMs)
        )
      : configuredIdleTimeoutMs;
  if (
    isLocalPreferredAdapter &&
    configuredIdleTimeoutMs > 0 &&
    GATEWAY_IDLE_TIMEOUT_MS > configuredIdleTimeoutMs &&
    typeof opts.onStatus === 'function'
  ) {
    try {
      opts.onStatus({
        phase: 'request',
        message: `检测到本地通道 idle 超时配置过短，已自动调整为 ${Math.round(GATEWAY_IDLE_TIMEOUT_MS / 1000)}s 以提升稳定性。`,
      });
    } catch {
      /* best effort */
    }
  }
  if (hardTimeoutAutoRaised && typeof opts.onStatus === 'function') {
    try {
      opts.onStatus({
        phase: 'request',
        message: `检测到本地通道链路停滞超时配置过短，已自动调整为 ${Math.round(GATEWAY_STALL_TIMEOUT_MS / 1000)}s 以提升稳定性。`,
      });
    } catch {
      /* best effort */
    }
  }

  // Optional stability multiplier (used by recovery retry paths).
  const stabilityTimeoutMultiplierRaw = Number(
    opts._stabilityTimeoutMultiplier || process.env.KHY_GATEWAY_STABILITY_TIMEOUT_MULTIPLIER || 1
  );
  const stabilityTimeoutMultiplier = Number.isFinite(stabilityTimeoutMultiplierRaw)
    ? Math.max(1, Math.min(3, stabilityTimeoutMultiplierRaw))
    : 1;
  if (stabilityTimeoutMultiplier > 1) {
    GATEWAY_STALL_TIMEOUT_MS = Math.round(GATEWAY_STALL_TIMEOUT_MS * stabilityTimeoutMultiplier);
    if (GATEWAY_IDLE_TIMEOUT_MS > 0) {
      GATEWAY_IDLE_TIMEOUT_MS = Math.min(
        Math.max(1000, Math.round(GATEWAY_IDLE_TIMEOUT_MS * stabilityTimeoutMultiplier)),
        Math.max(0, GATEWAY_STALL_TIMEOUT_MS - 1000)
      );
    }
    if (typeof opts.onStatus === 'function') {
      try {
        opts.onStatus({
          phase: 'request',
          message: `稳定性重试已放宽链路停滞窗口 ×${stabilityTimeoutMultiplier.toFixed(2)}（stall ${Math.round(GATEWAY_STALL_TIMEOUT_MS / 1000)}s）`,
        });
      } catch {
        /* best effort */
      }
    }
  }

  const abortController = new AbortController();
  let settled = false;
  let lastActivityTs = Date.now();
  let lastHeartbeatSec = -1;
  let localWarmupStage = -1;
  const localWarmupLabel = preferredAdapter === 'ollama' ? 'Ollama' : '本地模型';
  if (localHotAttached && typeof opts.onStatus === 'function') {
    try {
      opts.onStatus({
        phase: 'request',
        message: `${localWarmupLabel} 检测到热启动状态，已直接复用已加载引擎。`,
      });
    } catch {
      /* best effort */
    }
  }
  const localWarmupStages = [
    {
      sec: 8,
      message: `${localWarmupLabel} 预热中：首次加载模型约需 30-120 秒（取决于模型大小和硬件）`,
    },
    { sec: 20, message: `${localWarmupLabel} 正在加载模型与上下文，仍在运行...` },
    { sec: 45, message: `${localWarmupLabel} 仍在推理中；若为首次运行，这个耗时是常见现象。` },
  ];

  const markActivity = () => {
    lastActivityTs = Date.now();
  };

  const guardCallback = (fn, { mark = true } = {}) => {
    if (typeof fn !== 'function') {
      return undefined;
    }
    return (...args) => {
      if (settled) {
        return undefined;
      }
      if (mark) {
        markActivity();
      }
      return fn(...args);
    };
  };

  const resolvedMaxTokens = _resolveLocalPreferredMaxTokens(effortPreset.maxTokens, {
    isLocalPreferredAdapter,
    preferredAdapter,
    localLLMStatus,
    isThinkingModel: _isLocalThinkingModel(opts.preferredModel),
  });
  if (resolvedMaxTokens.capped && typeof opts.onStatus === 'function') {
    try {
      const capLabel = preferredAdapter === 'ollama' ? 'Ollama' : '本地模型';
      opts.onStatus({
        phase: 'request',
        message: `${capLabel} 已启用快速响应上限：maxTokens ${effortPreset.maxTokens} -> ${resolvedMaxTokens.maxTokens}`,
      });
    } catch {
      /* best effort */
    }
  }

  // Image-generation-only model fast-path: when the selected model is purely
  // an image generation backend (e.g. agnes-image-2.1-flash, dall-e-3) with no
  // text completion capability, routing through the text gateway produces garbage
  // thinking output instead of an image. Detect intent and call imageGenService
  // directly, bypassing the adapter cascade entirely.
  const _selectedImageModel = (() => {
    try {
      const { catalogModels } = require('../services/imageGenService');
      const modelId = String(opts.preferredModel || '').trim();
      if (!modelId) {
        return null;
      }
      const known = (catalogModels() || []).map((m) =>
        String(m.model || '')
          .trim()
          .toLowerCase()
      );
      const lower = modelId.toLowerCase();
      return known.includes(lower) ? modelId : null;
    } catch {
      return null;
    }
  })();
  if (_selectedImageModel) {
    const _IMAGE_INTENT_RE =
      /(画|绘|生成图|配图|图片|插画|海报|draw|image|picture|logo|图标|壁纸|头像)/i;
    if (_IMAGE_INTENT_RE.test(String(userMessage || ''))) {
      try {
        if (typeof opts.onStatus === 'function') {
          opts.onStatus({
            phase: 'request',
            message: `检测到图像模型 ${_selectedImageModel}，直接生成图像...`,
          });
        }
        if (typeof opts.onChunk === 'function') {
          opts.onChunk({ type: 'text', text: `正在通过 ${_selectedImageModel} 生成图像…\n` });
        }
        const { generate: generateImage } = require('../services/imageGenService');
        const imgResult = await _withProgressSimulation(
          () => generateImage({ prompt: String(userMessage || ''), model: _selectedImageModel }),
          12000,
          (pct) => {
            if (typeof opts.onStatus === 'function') {
              opts.onStatus({
                phase: 'request',
                message: `🎨 正在通过 ${_selectedImageModel} 生成图像… ${pct}%`,
              });
            }
          }
        );

        // Save to Desktop and auto-open for easy viewing
        const imagePaths = (imgResult.images || [])
          .map((img) => _saveImageToDesktop(img.base64 || img.dataUrl, 'image/png'))
          .filter(Boolean);
        for (const p of imagePaths) {
          try {
            _openFileWithSystemViewer(p);
          } catch {
            /* best-effort */
          }
        }

        const imageList = (imgResult.images || [])
          .map((img, i) => {
            const pathLine = imagePaths[i] ? `\n  📁 保存位置: ${imagePaths[i]}` : '';
            return `${i + 1}. [图像 ${imgResult.backend}/${imgResult.model || _selectedImageModel} ${imgResult.size || ''}]${pathLine}`;
          })
          .join('\n');
        const khyImgDir = _getKhyOutputDir('images').primary;
        const savedNote =
          imagePaths.length > 0 ? `\n💡 图片已自动打开，也可在 ${khyImgDir} 查看。` : '';
        const intro = String(userMessage || '')
          .trim()
          .slice(0, 60);
        const reply =
          imagePaths.length > 0
            ? `根据您的描述「${intro}」已生成 ${imagePaths.length} 张图像：\n${imageList}${savedNote}`
            : `🎨 已为您生成 ${imagePaths.length || imgResult.images.length} 张图像：\n${imageList}${savedNote}`;
        if (typeof opts.onChunk === 'function') {
          opts.onChunk({ type: 'text', text: reply });
        }
        return {
          content: reply,
          success: true,
          provider: `image:${imgResult.backend || 'unknown'}`,
          adapter: 'imageGen',
          model: imgResult.model || _selectedImageModel,
          thinking: null,
          toolUseBlocks: [],
          toolCallLog: [],
          tokenUsage: null,
          stopReason: 'stop',
          attempts: [],
        };
      } catch (imgErr) {
        const errMsg = String(imgErr && imgErr.message ? imgErr.message : imgErr || '图像生成失败')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          content: `图像生成失败：${errMsg}`,
          success: false,
          provider: `image:error`,
          adapter: 'imageGen',
          model: _selectedImageModel,
          thinking: null,
          error: errMsg,
          errorType: 'image_gen_error',
          toolUseBlocks: [],
          toolCallLog: [],
          tokenUsage: null,
          stopReason: 'error',
          attempts: [],
        };
      }
    }
  }

  // 注意：文本模型不再走 fast-path。图像/视频生成意图留给 LLM 通过
  // image_generate / video_generate 工具自然调用，保持对话上下文连贯。
  // 只有纯图像模型（无文本能力）仍走上面的 fast-path。

  const activeRequestId = _registerActiveGatewayRequest(abortController, {
    adapter: opts.preferredAdapter || preferredAdapter,
  });
  let generatePromise;
  try {
    generatePromise = gw.generate(conversationPrompt, {
      temperature: runtime.lockTemperature(userMessage),
      top_p: lockedTopP,
      maxTokens: resolvedMaxTokens.maxTokens,
      taskScale: opts.taskScale,
      sessionId: opts.sessionId,
      requestId: opts.requestId,
      _diagTraceId: opts._diagTraceId,
      strictPreferred: opts.strictPreferred,
      preferredAdapter: opts.preferredAdapter,
      preferredModel: opts.preferredModel,
      preferredStrict: opts.preferredStrict,
      _intentDirective: opts._intentDirective,
      userMessage,
      onChunk: guardCallback(opts.onChunk, { mark: true }),
      onControlRequest: guardCallback(opts.onControlRequest, { mark: true }),
      onFallback: guardCallback(opts.onFallback, { mark: true }),
      onWait: guardCallback(opts.onWait, { mark: true }),
      images: opts.images,
      system: fullSystemPrompt,
      messages,
      tools: toolDefs,
      _debugToolCount: toolDefs ? toolDefs.length : 0,
      structuredMessages,
      // /thinking controls the request, not just display: when off we send no
      // thinking budget and flag thinkingEnabled:false so native-thinking models
      // (Claude) skip extended_thinking and we pay no reasoning cost.
      thinking: _chatState.thinkingEnabled ? effortPreset.thinking || undefined : undefined,
      thinkingEnabled: _chatState.thinkingEnabled,
      abortSignal: abortController.signal,
    });
  } catch (err) {
    _unregisterActiveGatewayRequest(activeRequestId);
    throw err;
  }

  return new Promise((resolve, reject) => {
    let stallWatchdog = null;
    let idlePoll = null;
    const clearTimers = () => {
      if (stallWatchdog) {
        clearInterval(stallWatchdog);
      }
      stallWatchdog = null;
      if (idlePoll) {
        clearInterval(idlePoll);
      }
      idlePoll = null;
    };

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      _unregisterActiveGatewayRequest(activeRequestId);
      clearTimers();
      fn(value);
    };

    const abortAndReject = (message) => {
      const err =
        message instanceof Error ? message : new Error(String(message || 'AI gateway aborted'));
      if (!abortController.signal.aborted) {
        try {
          abortController.abort(err);
        } catch {
          /* ignore */
        }
      }
      finish(reject, err);
    };

    stallWatchdog = setInterval(() => {
      if (settled) {
        return;
      }
      const now = Date.now();
      const silentFor = now - lastActivityTs;
      if (silentFor >= GATEWAY_STALL_TIMEOUT_MS) {
        abortAndReject(
          new Error(
            `AI 网关链路停滞超时：已 ${Math.round(GATEWAY_STALL_TIMEOUT_MS / 1000)}s 无活动，所有适配器均未推进`
          )
        );
        return;
      }
    }, 1000);
    stallWatchdog.unref?.();

    if (GATEWAY_IDLE_TIMEOUT_MS > 0 && GATEWAY_IDLE_TIMEOUT_MS < GATEWAY_STALL_TIMEOUT_MS) {
      idlePoll = setInterval(() => {
        if (settled) {
          return;
        }
        const idleFor = Date.now() - lastActivityTs;
        const idleSec = Math.floor(idleFor / 1000);
        if (idleSec >= 8 && typeof opts.onStatus === 'function') {
          if (isLocalPreferredAdapter) {
            while (
              localWarmupStage + 1 < localWarmupStages.length &&
              idleSec >= localWarmupStages[localWarmupStage + 1].sec
            ) {
              localWarmupStage += 1;
              try {
                opts.onStatus({
                  phase: 'request',
                  message: localWarmupStages[localWarmupStage].message,
                  elapsed: idleFor,
                });
              } catch {
                /* best effort */
              }
            }
          }

          const heartbeatStep = isLocalPreferredAdapter ? 3 : 5;
          const bucket = Math.floor(idleSec / heartbeatStep);
          if (bucket !== lastHeartbeatSec) {
            lastHeartbeatSec = bucket;
            try {
              opts.onStatus({
                phase: 'request',
                message: isLocalPreferredAdapter
                  ? `请求本地模型 | 阶段: 模型预热或推理等待 | 目标: ${localWarmupLabel} | 进度: 已 ${idleSec}s 未收到新输出 | 已耗时: ${idleSec}s`
                  : `请求上游模型 | 阶段: 等待模型响应 | 目标: AI 网关 | 进度: 已 ${idleSec}s 未收到新输出 | 已耗时: ${idleSec}s`,
                elapsed: idleFor,
              });
            } catch {
              /* best effort */
            }
          }
        }
        if (idleFor >= GATEWAY_IDLE_TIMEOUT_MS) {
          const idleTimeoutSec = Math.round(GATEWAY_IDLE_TIMEOUT_MS / 1000);
          const idleTimeoutHint = isLocalPreferredAdapter ? '（本地模型可能仍在预热中）' : '';
          abortAndReject(
            new Error(`AI 网关空闲超时：${idleTimeoutSec} 秒，流已停滞${idleTimeoutHint}`)
          );
        }
      }, 1000);
      idlePoll.unref?.();
    }

    generatePromise.then((result) => finish(resolve, result)).catch((err) => finish(reject, err));
  });
}

// ── Preflight ──

async function _preflightGatewayAvailability(options = {}) {
  if (_chatState.gatewayPreflightDone) {
    return;
  }
  if (_chatState.gatewayPreflightInFlight) {
    return _chatState.gatewayPreflightInFlight;
  }
  _chatState.gatewayPreflightInFlight = (async () => {
    const gw = getGateway();
    const runtimeIsKhy =
      String(process.env.KHY_RUNTIME_MODE || '')
        .trim()
        .toLowerCase() === 'khy';
    if (!gw.isInitialized()) {
      await gw.init();
    }
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const maxBudgetMs = Math.max(
      600,
      parseInt(process.env.KHY_PREFLIGHT_MAX_MS || (runtimeIsKhy ? '1800' : '6000'), 10)
    );
    const adapterProbeTimeoutMs = Math.max(
      600,
      parseInt(process.env.KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS || (runtimeIsKhy ? '900' : '3000'), 10)
    );
    const maxAutoCandidates = Math.max(
      1,
      parseInt(process.env.KHY_PREFLIGHT_MAX_CANDIDATES || (runtimeIsKhy ? '2' : '3'), 10)
    );
    const startedAt = Date.now();

    const testAdapterQuickly = async (adapterKey) => {
      try {
        return await Promise.race([
          gw.testAdapter(adapterKey, { quick: true, timeoutMs: adapterProbeTimeoutMs }),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), adapterProbeTimeoutMs + 120);
            if (t.unref) {
              t.unref();
            }
          }),
        ]);
      } catch {
        return null;
      }
    };

    // If caller already selected a preferred adapter, test its live connectivity once.
    const preferred = String(
      options.preferredAdapter !== undefined
        ? options.preferredAdapter
        : process.env.GATEWAY_PREFERRED_ADAPTER || ''
    ).trim();
    if (preferred && preferred !== 'auto') {
      if (onProgress) {
        onProgress(`预检首选通道: ${preferred}`);
      }
      const probe = await testAdapterQuickly(preferred);
      const connectivityOk = !!probe?.connectivity?.success;
      const generationOk = probe?.generation ? !!probe.generation.success : true;
      const modelsOk = probe?.models ? !!probe.models.success : true;
      // Respect explicit user selection: do not silently rewrite preferred adapter
      // during preflight. If probe fails, keep current preference and let strict
      // execution return a clear error instead of auto-switching to another path.
      if (connectivityOk && generationOk && modelsOk) {
        return;
      }
      return;
    }

    // Auto-pick first operational adapter, skip relay-like adapters for chat by default.
    const statuses = gw
      .getStatus()
      .filter((s) => s.enabled && s.available)
      .slice(0, maxAutoCandidates);
    for (const s of statuses) {
      if (Date.now() - startedAt >= maxBudgetMs) {
        break;
      }
      if (['relay', 'relay_api', 'clipboard'].includes(s.type)) {
        continue;
      }
      if (onProgress) {
        onProgress(`预检通道: ${s.type}`);
      }
      const probe = await testAdapterQuickly(s.type);
      const connectivityOk = !!probe?.connectivity?.success;
      const generationOk = probe?.generation ? !!probe.generation.success : true;
      const modelsOk = probe?.models ? !!probe.models.success : true;
      if (connectivityOk && generationOk && modelsOk) {
        process.env.GATEWAY_PREFERRED_ADAPTER = s.type;
        process.env.GATEWAY_PREFERRED_STRICT = 'true';
        try {
          gw.setActiveChannel(s.type);
        } catch {
          /* lifecycle reconcile is best-effort */
        }
        return;
      }
    }
  })();
  try {
    await _chatState.gatewayPreflightInFlight;
  } finally {
    _chatState.gatewayPreflightDone = true;
    _chatState.gatewayPreflightInFlight = null;
  }
}

// ── Exports ──
module.exports = {
  _buildStructuredMessages,
  _gatewayGenerate,
  _preflightGatewayAvailability,
  setAiMessageBuilderDeps,
};
