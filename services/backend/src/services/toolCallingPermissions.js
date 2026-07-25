'use strict';

/**
 * toolCalling 权限子系统(从 toolCalling.js 上帝文件抽出)。
 *
 * 承载:权限模式(CC 对齐)与档案映射、审批持久化(load/save)、危险模式开关、
 * requestPermission 有序 fail-closed 决策链、readline 注入与 preflight 上下文、
 * formatToolCall/getToolRisk。全部权限可变态(_permissions / _permissionMode /
 * _preflightContext / _rlProvider)**私有于本叶子**——宿主 executeTool 只调用权限
 * *函数*,从不触碰这些状态,故可无环抽出。
 *
 * **两条反向边经依赖注入打破**:getToolRisk/formatToolCall/requestPermission 需要宿主的
 * _resolveToolDescriptor / _findBuiltinTool(读宿主 _allTools 注册表)。宿主在加载时调用一次
 * setPermissionResolvers 注入这两个函数;被迁移函数体仍按**同名**引用这两个绑定,故字节不变
 * (仿本子系统既有的 setReadlineProvider / _rlProvider DI)。
 *
 * **刻意非纯零 IO 叶子**:readline 交互提示、fs 读写审批文件、chalk 终端着色、大量内联
 * require(execApproval/riskGate/permissionPolicy/permissionStore/syscallGateway 等)。放置为
 * toolCalling.js 的**同目录兄弟**以保迁移的相对 require 路径字节不变。宿主 module.exports 与
 * executeTool 按**同名 re-import** 接回,调用点字节不变。
 */
const readline = require('readline');
const path = require('path');
const fs = require('fs');
let _chalk;
const chalk = () => (_chalk ??= (require('chalk').default || require('chalk')));
const { PERMISSIONS_FILE, RISK_LEVELS } = require('./toolCallingBuiltins');

// 宿主描述符解析器,加载时由 setPermissionResolvers 注入一次(打破两条 leaf→host 反向边,
// 零环)。getToolRisk/formatToolCall/requestPermission 按**同名**调用,故其体字节不变。
let _resolveToolDescriptor = null;
let _findBuiltinTool = null;
function setPermissionResolvers(resolvers = {}) {
  if (typeof resolvers.resolveToolDescriptor === 'function') _resolveToolDescriptor = resolvers.resolveToolDescriptor;
  if (typeof resolvers.findBuiltinTool === 'function') _findBuiltinTool = resolvers.findBuiltinTool;
}


// ── Permission mode (CC alignment) ──────────────────────────────────
// Mirrors Claude Code's four permission modes as a single source of truth:
//   'default'     — rules/risk decide; interactive prompts as usual.
//   'plan'        — read-only rehearsal: every side-effecting tool is denied
//                   (prompt-free) so the model can plan without mutating state.
//   'acceptEdits' — auto-approve filesystem edits (Write/Edit/MultiEdit/…),
//                   still gate Bash / network / critical red line.
//   'auto'        — auto-approve routine calls (incl. safe shell); destructive or
//                   high/critical-risk actions still ask. Deterministic analog of
//                   CC's classifier-gated auto (khy has no classifier model).
//   'dontAsk'     — inverse of bypass: deny everything not EXPLICITLY allowed
//                   (fails loudly, for scripted/CI runs). CC alignment.
//   'bypass'      — auto-approve everything EXCEPT the critical red line and the
//                   syscall gateway L2 floor (KHY hardening over CC's bypass).
// The legacy boolean dangerousMode maps onto mode==='bypass' via the shims below,
// so existing callers keep working. Initial value can be seeded by env.
// Cycle order mirrors CC: default → acceptEdits → plan → auto → bypass in the
// Shift+Tab cycle (see appHostHelpers/replSession); dontAsk is startup/settings
// only (KHY_PERMISSION_MODE=dontAsk), never cycled — matching CC exactly.
const PERMISSION_MODES = Object.freeze(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypass']);
function _normalizePermissionMode(m) {
  const v = String(m || '').trim();
  // Tolerate CC's spelling 'bypassPermissions' / 'acceptedits' / 'dontask'.
  if (v === 'bypassPermissions' || v === 'yolo') return 'bypass';
  if (v.toLowerCase() === 'acceptedits') return 'acceptEdits';
  const lc = v.toLowerCase();
  if (lc === 'dontask' || lc === 'dont-ask' || lc === "don'task") return 'dontAsk';
  if (lc === 'auto') return 'auto';
  return PERMISSION_MODES.includes(v) ? v : 'default';
}
let _permissionMode = _normalizePermissionMode(process.env.KHY_PERMISSION_MODE);

// ── Canonical mode ↔ profile mapping (single source of truth) ────────
// KHY carries two permission vocabularies that historically drifted:
//   - toolCalling modes:   default / plan / acceptEdits / bypass  (CC alignment)
//   - permissionStore profiles: normal / strict / acceptEdits / yolo
// The TUI's applyPermissionMode kept them in lockstep by hand; every other
// caller of setPermissionMode left them split-brained. This frozen map is the
// ONE place the correspondence is defined. App.js and the unification test both
// import it so no third copy can drift.
const _MODE_TO_PROFILE = Object.freeze({
  default: 'normal',
  plan: 'strict',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  dontAsk: 'dontAsk',
  bypass: 'yolo',
});

/**
 * Map a permission mode to its canonical permissionStore profile.
 * @param {string} mode  any mode string (normalized first, so aliases work)
 * @returns {'normal'|'strict'|'acceptEdits'|'auto'|'dontAsk'|'yolo'}
 */
function permissionModeToProfile(mode) {
  return _MODE_TO_PROFILE[_normalizePermissionMode(mode)] || 'normal';
}

/**
 * Keep permissionStore's in-memory profile coherent with the active mode.
 *
 * Deliberately NON-persistent (persist:false): an explicit, in-session mode
 * change must NOT overwrite the user's durable on-disk profile. At module load
 * we never call this — the persisted profile stays authoritative until the user
 * actively changes mode, so a session default of 'default' can't silently
 * downgrade a persisted 'yolo'. Gated by KHY_PERMISSION_STORE like every other
 * store touch, and best-effort (store optional).
 */
function _syncPermissionProfile(mode) {
  if (process.env.KHY_PERMISSION_STORE === 'false') return;
  try {
    require('./permissionStore').setProfile(permissionModeToProfile(mode), { persist: false });
  } catch { /* permissionStore optional — coherence is best-effort */ }
}

// Edit-class tools auto-approved under acceptEdits mode (normalized names).
const _ACCEPT_EDITS_TOOLS = new Set([
  'write', 'writefile', 'createfile',
  'edit', 'editfile', 'multiedit', 'applypatch',
  'notebookedit',
]);

let _permissions = null;

/**
 * Load saved tool permissions.
 */
function loadPermissions() {
  if (_permissions) return _permissions;
  try {
    if (fs.existsSync(PERMISSIONS_FILE)) {
      _permissions = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  _permissions = _permissions || { approved: {}, denied: {}, dangerousAcknowledged: false };
  return _permissions;
}

/**
 * Save permissions to disk.
 */
function savePermissions() {
  try {
    const dir = path.dirname(PERMISSIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(_permissions, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * Set the active permission mode (CC alignment). Unknown values fall back to
 * 'default'. Single source of truth consulted by requestPermission/executeTool.
 * @param {'default'|'plan'|'acceptEdits'|'bypass'} mode
 * @returns {string} the normalized mode now in effect
 */
function setPermissionMode(mode) {
  _permissionMode = _normalizePermissionMode(mode);
  _syncPermissionProfile(_permissionMode);
  return _permissionMode;
}

/** @returns {string} the active permission mode. */
function getPermissionMode() {
  return _permissionMode;
}

/**
 * Enable dangerous mode (skip all confirmations) = permission mode 'bypass'.
 * Returns false if user hasn't acknowledged the warning yet.
 */
function enableDangerousMode() {
  const perms = loadPermissions();
  _permissionMode = 'bypass';
  _syncPermissionProfile('bypass');
  return perms.dangerousAcknowledged === true;
}

/**
 * Acknowledge dangerous mode warning (first-time) and enter 'bypass'.
 */
function acknowledgeDangerousMode() {
  const perms = loadPermissions();
  perms.dangerousAcknowledged = true;
  savePermissions();
  _permissionMode = 'bypass';
  _syncPermissionProfile('bypass');
}

function isDangerousMode() {
  return _permissionMode === 'bypass';
}

/** Leave bypass mode (back to 'default'); other modes are left untouched. */
function disableDangerousMode() {
  if (_permissionMode === 'bypass') {
    _permissionMode = 'default';
    _syncPermissionProfile('default');
  }
}

/**
 * Check if a tool call is pre-approved.
 */
function isApproved(toolName) {
  const perms = loadPermissions();
  return perms.approved[toolName] === true;
}

/**
 * Pre-approve a tool (remember for session).
 */
function approveTool(toolName, persist = false) {
  const perms = loadPermissions();
  perms.approved[toolName] = true;
  if (persist) savePermissions();
}

/**
 * Get the risk level info for a tool.
 */
function getToolRisk(toolName) {
  const descriptor = _resolveToolDescriptor(toolName);
  if (!descriptor || !descriptor.tool) return RISK_LEVELS.medium;
  return RISK_LEVELS[descriptor.tool.risk] || RISK_LEVELS.medium;
}

/**
 * Format tool call for display to user (for confirmation prompt).
 */
function formatToolCall(toolName, params) {
  const descriptor = _resolveToolDescriptor(toolName);
  const tool = descriptor?.tool || null;
  const risk = getToolRisk(toolName);
  const riskColor = chalk()[risk.color] || chalk().yellow;

  let display = '';
  display += chalk().bold(`  🔧 工具调用: ${toolName}\n`);
  display += `  ${riskColor(`[${risk.label}]`)} ${tool?.description || ''}\n`;

  if (params && Object.keys(params).length > 0) {
    display += chalk().dim('  参数:\n');
    for (const [key, value] of Object.entries(params)) {
      const displayVal = typeof value === 'string' && value.length > 100
        ? value.slice(0, 100) + '...'
        : JSON.stringify(value);
      display += chalk().dim(`    ${key}: `) + displayVal + '\n';
    }
  }

  return display;
}

/**
 * Map an onControlRequest resolution into a permission decision.
 *
 * The Ink TUI's permission overlay (PermissionsPrompt → App.js useInput) resolves
 * the control promise with a PRIMITIVE — `true` (allow), `'always'` (allow-always),
 * or `false` (deny) — not the `{behavior}` object shape the REPL host uses. We
 * tolerate both so this works under any host channel.
 *
 * @param {*} resp - resolution value from onControlRequest
 * @returns {'allow'|'allow-always'|'deny'}
 */
function _decisionFromControl(resp) {
  if (resp === true) return 'allow';
  if (resp === 'always' || resp === 'allow-always') return 'allow-always';
  if (resp && typeof resp === 'object') {
    // Tolerate the REPL/SDK object shape: { behavior } or nested { response }.
    let node = resp;
    if (node.type === 'control_response' && node.response) node = node.response;
    const inner = (node.response && typeof node.response === 'object') ? node.response : node;
    const behavior = inner.behavior || node.behavior;
    if (behavior === 'allow') return 'allow';
    if (behavior === 'allow-always') return 'allow-always';
  }
  return 'deny';
}

/**
 * Request user confirmation for a tool call.
 * Returns: 'allow' | 'allow-always' | 'deny'
 *
 * Interactive selection (Claude Code style):
 *   1. Yes             — Execute this time only
 *   2. Yes, always     — Permanently trust this tool
 *   3. No              — Refuse execution
 *   Esc to cancel · Tab to amend
 *
 * @param {string} toolName
 * @param {object} params
 * @param {Function} [onControlRequest] - Ink/host interactive channel. When
 *   present, interactive approval is routed through it (the Ink PermissionsPrompt)
 *   instead of the classic raw-mode readline dialog — the latter calls
 *   stdin.setRawMode(false) on the shared TTY and corrupts the Ink TUI into cooked
 *   mode. When absent (classic REPL / subagent / CI) the original dialog is used.
 */
/**
 * Resolve a tool's behavioral declarations from the registry (read-only /
 * destructive / category / risk). Single helper used by both requestPermission's
 * mode logic and executeTool's plan-mode pre-deny so the two stay consistent.
 * Tools without an isReadOnly declaration are treated as NOT read-only (the safe
 * default for plan mode: only explicitly read-only tools run).
 */
function _resolveToolBehavior(permissionKey, params) {
  let isReadOnly = false, isDestructive = false, category, risk;
  try {
    const registry = require('../tools');
    const regTool = registry.get(permissionKey);
    if (regTool) {
      isReadOnly = typeof regTool.isReadOnly === 'function' ? regTool.isReadOnly(params) : false;
      isDestructive = typeof regTool.isDestructive === 'function' ? regTool.isDestructive(params) : false;
      category = regTool.category;
      risk = regTool.risk;
    }
  } catch { /* registry not available — conservative defaults */ }
  return { isReadOnly, isDestructive, category, risk };
}

async function requestPermission(toolName, params, onControlRequest = null) {
  // Dedup short-circuit: execApproval already resolved (approved) this command
  // and stamped a Symbol token onto params. Honor it to avoid double-prompting.
  // A Symbol key cannot be forged by the model through JSON params.
  try {
    const { EXEC_APPROVED } = require('./execApproval');
    if (EXEC_APPROVED && params && params[EXEC_APPROVED] === true) return 'allow';
  } catch { /* execApproval optional */ }

  const descriptor = _resolveToolDescriptor(toolName);
  const permissionKey = descriptor?.resolvedName || toolName;

  // ── Critical red line (人闸门, learned from DesireCore) ───────────
  // An unbypassable human-gate step — anything IRREVERSIBLE (destructive: rm,
  // kill, drop table, git reset --hard) OR explicitly 'critical' (rm -rf /, .env
  // edits, …) — must always reach explicit human confirmation. It is NOT
  // auto-approvable by blanket bypass/dangerousMode/yolo or by a prior session
  // "remember". Only an explicit per-command execApproval (EXEC_APPROVED above)
  // or batch preflight counts as informed consent. Ordinary high-risk but
  // REVERSIBLE ops keep the existing flow so autonomous Goal Mode still works.
  // This is the backstop that holds even when the syscall gateway is disabled
  // (KHY_SYSCALL_GATEWAY=off). Kill switch: KHY_HUMAN_GATE=off.
  let criticalGate = false;
  if (process.env.KHY_HUMAN_GATE !== 'off') {
    try {
      const riskGate = require('./riskGate');
      const assessment = riskGate.assess(permissionKey, params, descriptor);
      criticalGate = riskGate.isUnbypassableGate(assessment);
    } catch { /* riskGate optional */ }
  }

  // ── Permission mode: plan (read-only) — authoritative deny ──────────
  // CC alignment. plan mode is a read-only rehearsal: deny every side-effecting
  // tool, ahead of preflight/persisted-allow so no prior grant can leak a write
  // through. Only tools the registry declares isReadOnly===true survive. This is
  // defense-in-depth for direct requestPermission callers; executeTool denies the
  // same calls earlier (prompt-free, before the gateway).
  if (_permissionMode === 'plan') {
    const beh = _resolveToolBehavior(permissionKey, params);
    if (beh.isReadOnly === false) return 'deny';
  }

  // Preflight batch approval — if tool was already approved in a batch, skip prompt
  if (_preflightContext && (_preflightContext.has(toolName) || _preflightContext.has(permissionKey))) return 'allow';

  // ── Fine-grained policy middleware (config-driven, opt-in) ──────────
  // Evaluates the call against <dataHome>/permissions.json. A strict no-op when
  // no policy file exists (existing behavior 100% unchanged). It can only ADD
  // protection, never relax it:
  //   - 'deny'    → block here, fail-closed.
  //   - 'confirm' → force the interactive prompt even under acceptEdits/bypass/
  //                 prior-approval (sets policyConfirm to suppress auto-grants).
  //   - 'auto'    → whitelist hit auto-allows AFTER the persisted-deny check,
  //                 and still subject to the unbypassable critical red line.
  // Kill switch: KHY_PERMISSION_POLICY=off.
  let policyConfirm = false;
  let policyAutoAllow = false;
  try {
    const permissionPolicy = require('./permissionPolicy');
    const _beh = _resolveToolBehavior(permissionKey, params);
    const verdict = permissionPolicy.evaluate(permissionKey, params, {
      category: _beh.category,
      isReadOnly: _beh.isReadOnly,
      isDestructive: _beh.isDestructive,
    });
    if (verdict) {
      if (verdict.decision === 'deny') return 'deny';
      if (verdict.decision === 'confirm') policyConfirm = true;
      else if (verdict.decision === 'auto') policyAutoAllow = true;
    }
  } catch { /* policy middleware optional — fall through unchanged */ }

  // New permission store check (if enabled)
  if (process.env.KHY_PERMISSION_STORE !== 'false') {
    try {
      const permStore = require('./permissionStore');
      const tool = descriptor?.tool || _findBuiltinTool(permissionKey);
      // Resolve behavioral declarations if available from new tool registry
      let isReadOnly = false;
      let isDestructive = false;
      let category;
      try {
        const registry = require('../tools');
        const regTool = registry.get(permissionKey);
        if (regTool) {
          isReadOnly = typeof regTool.isReadOnly === 'function' ? regTool.isReadOnly(params) : false;
          isDestructive = typeof regTool.isDestructive === 'function' ? regTool.isDestructive(params) : false;
          category = regTool.category;
        }
      } catch { /* registry not available */ }
      const decision = permStore.check(permissionKey, params, {
        risk: tool?.risk || 'medium',
        isReadOnly,
        isDestructive,
        category,
      });
      // A persisted 'allow' rule cannot override the critical red line.
      if (decision === 'allow' && !criticalGate) return 'allow';
      if (decision === 'deny') return 'deny';
      // decision === 'ask' → fall through to interactive prompt
    } catch { /* permissionStore not available — fall through */ }
  }

  // Policy whitelist auto-allow (auto mode, target in-whitelist). Placed AFTER
  // the persisted-deny check so an explicit store 'deny' still wins, and gated
  // by the critical red line which no whitelist can relax.
  if (policyAutoAllow && !criticalGate) return 'allow';

  // Auto-approve safe and low-risk read-only tools. A policy 'confirm' verdict
  // suppresses these blanket auto-grants so the user's prompt is honored.
  const tool = descriptor?.tool || _findBuiltinTool(permissionKey);
  if (tool && tool.risk === 'safe' && !policyConfirm) return 'allow';
  if (tool && tool.risk === 'low' && !policyConfirm) {
    // Low-risk tools (read_file, glob, grep, etc.) are auto-approved
    // unless they are dynamically destructive based on params
    let isDestructive = false;
    try {
      const registry = require('../tools');
      const regTool = registry.get(permissionKey);
      if (regTool && typeof regTool.isDestructive === 'function') {
        isDestructive = regTool.isDestructive(params);
      }
    } catch { /* registry not available */ }
    if (!isDestructive) return 'allow';
  }

  // ── Read-only default-approve (只读默认批准) ─────────────────────────
  // Read-only operations never mutate state, so they are approved by default —
  // the user should not be asked to confirm a `cat`/`grep`/`ls`/`git status`/a
  // read-only diagnostic. This consults the tool's DYNAMIC isReadOnly, which is
  // strictly more precise than the static risk tier: a generic shell tool is
  // statically risk:'medium'/'critical' yet `grep foo *.js` only reads. Placed
  // after the static safe/low grants so it widens (never narrows) auto-approval.
  // Hard-gated so it can ONLY add convenience, never relax protection:
  //   - criticalGate (irreversible / critical red line) always wins → still prompts;
  //   - a policy 'confirm' verdict still forces the interactive prompt;
  //   - a dynamically destructive param set disqualifies it (a read-only-declared
  //     tool that turns destructive on THESE params prompts — defense in depth).
  // This complements the syscall gateway (which already auto-allows L0 read-only
  // and stamps EXEC_APPROVED before we get here); it is what keeps read-only
  // friction-free when the gateway is disabled (KHY_SYSCALL_GATEWAY=off) and for
  // direct requestPermission callers. Reversible kill switch:
  // KHY_AUTO_APPROVE_READONLY=off.
  if (!criticalGate && !policyConfirm && process.env.KHY_AUTO_APPROVE_READONLY !== 'off') {
    const beh = _resolveToolBehavior(permissionKey, params);
    if (beh.isReadOnly === true && beh.isDestructive !== true) return 'allow';
  }

  // ── Permission mode auto-approve (CC alignment) ─────────────────────
  // acceptEdits: auto-approve filesystem edit tools (placed AFTER the persisted
  // deny check so an explicit deny still wins, mirroring CC's deny>ask>allow), and
  // still subject to the critical red line. bypass (legacy dangerousMode):
  // auto-approve everything EXCEPT the critical red line, which is unbypassable
  // even under bypass/yolo (DesireCore 不可覆盖红线).
  if (_permissionMode === 'acceptEdits' && !criticalGate && !policyConfirm) {
    const _norm = String(permissionKey).toLowerCase().replace(/[\s_-]/g, '');
    if (_ACCEPT_EDITS_TOOLS.has(_norm)) {
      const beh = _resolveToolBehavior(permissionKey, params);
      if (!beh.isDestructive) return 'allow';
    }
  }
  if (_permissionMode === 'bypass' && !criticalGate && !policyConfirm) return 'allow';

  // Previously approved (persisted or session). A prior "remember" does not
  // carry over to a critical-risk call — informed consent must be per-instance.
  // A policy 'confirm' verdict likewise overrides a prior session grant.
  if (!criticalGate && !policyConfirm && (isApproved(toolName) || isApproved(permissionKey))) return 'allow';

  // Ink host channel — when the TUI (or any host) provides an interactive
  // approval channel, route through it instead of the classic raw-mode dialog.
  // The classic dialog (below) calls stdin.setRawMode(false) + readline on the
  // shared TTY, which drops the Ink TUI to cooked mode (keystrokes leak below the
  // input box: ↑→^[[A, Enter→newline). onControlRequest drives the Ink
  // PermissionsPrompt overlay and never touches raw mode.
  if (typeof onControlRequest === 'function') {
    // 面向小白的执行前说明（Part D）：网关关闭时也要给。基于已解析的行为信号
    // 构造意图并生成深浅说明，随 input 下发给宿主渲染层。fail-soft——失败则只
    // 发原始 params，绝不阻断审批。
    let _ctrlInput = params;
    try {
      const beh = _resolveToolBehavior(permissionKey, params);
      const { buildIntent } = require('./syscallGateway/intentSchema');
      const intent = buildIntent({ tool: toolName, params, isReadOnly: beh.isReadOnly, isDestructive: beh.isDestructive, risk: beh.risk });
      const explanation = require('./syscallGateway/preExecutionExplainer').explain(intent, {});
      if (explanation) _ctrlInput = { ...params, explanation };
    } catch { _ctrlInput = params; }
    // 写入前 diff 预览(editDiffPreview,「TUI 真 code 生产能力」):默认 UI 的 Ink 审批框
    // 此前只收到原始 params → 用户在 default 模式盲批文件编辑。这里在批准前把 before/after
    // 纯计算出来随 input 下发,PermissionsPrompt 复用 ToolLines 的红/绿 diff 渲染,让编辑
    // 在写入前被看清。决不触盘、fail-soft——门控关或任何异常 → 不附带预览,与今日字节等价。
    try {
      const _dp = require('./editDiffPreview').computeEditDiffPreview(toolName, params, {});
      if (_dp) _ctrlInput = { ..._ctrlInput, diffPreview: _dp };
    } catch { /* fail-soft:无预览,绝不阻断审批 */ }
    let ctrlResp = null;
    try {
      ctrlResp = await onControlRequest({
        requestId: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        request: {
          subtype: 'can_use_tool',
          tool_name: toolName,
          input: _ctrlInput,
        },
      });
    } catch { ctrlResp = null; }
    const decision = _decisionFromControl(ctrlResp);
    // Mirror the classic dialog's persistence so subsequent calls short-circuit.
    const _permMeta = { risk: tool?.risk };
    if (decision === 'allow-always') {
      approveTool(permissionKey, true);
      try { require('./permissionStore').approve(permissionKey, 'forever', _permMeta); } catch { /* best effort */ }
    } else if (decision === 'allow') {
      try { require('./permissionStore').approve(permissionKey, 'once', _permMeta); } catch { /* best effort */ }
    } else {
      try { require('./permissionStore').deny(permissionKey, 'session', _permMeta); } catch { /* best effort */ }
    }
    return decision;
  }

  // Enhanced permission dialog (if not legacy mode)
  if (process.env.KHY_LEGACY_PERMISSION_UI !== 'true') {
    try {
      // Dependency inversion (DESIGN-ARCH-057): the interactive dialog is
      // provided by cli/ui/permissionDialog via permissionPromptPort, never
      // required directly from the service layer. Null when headless → fall
      // through to the legacy text path below.
      const _prompter = require('./permissionPromptPort').getPermissionPrompter();
      const formatPermissionDialog = _prompter && _prompter.prompt;
      if (!formatPermissionDialog) throw new Error('no interactive prompter registered');
      const riskInfo = getToolRisk(toolName);
      const reasoning = params._reasoning || '';

      // Build diff info for write/edit operations
      let diffInfo;
      try {
        const _name = String(toolName).toLowerCase().replace(/[\s_-]/g, '');
        const _filePath = params?.file_path || params?.filePath || params?.path || '';
        if (_filePath && (_name === 'write' || _name === 'writefile' || _name === 'createfile')) {
          // Write: oldContent is existing file (or empty for new files), newContent is params.content
          let oldContent = '';
          try { oldContent = require('fs').readFileSync(_filePath, 'utf8'); } catch { /* new file */ }
          const newContent = params?.content || '';
          if (newContent) {
            diffInfo = { oldContent, newContent, filePath: _filePath };
          }
        } else if (_filePath && (_name === 'edit' || _name === 'editfile' || _name === 'multiedit')) {
          // Edit: apply old_string→new_string to the file content
          const oldStr = params?.old_string || params?.oldString || '';
          const newStr = params?.new_string || params?.newString || '';
          if (oldStr && _filePath) {
            let fileContent = '';
            try { fileContent = require('fs').readFileSync(_filePath, 'utf8'); } catch { /* skip */ }
            if (fileContent && fileContent.includes(oldStr)) {
              const newContent = fileContent.replace(oldStr, newStr);
              diffInfo = { oldContent: fileContent, newContent, filePath: _filePath };
            }
          }
        }
      } catch { /* graceful degradation — skip diff */ }

      const result = await formatPermissionDialog(toolName, params, riskInfo, reasoning, diffInfo);

      // Map result to legacy approval storage + permissionStore
      const _dlgMeta = { risk: tool?.risk };
      if (result === 'allow-always') {
        approveTool(permissionKey, true);
        try {
          const permStore = require('./permissionStore');
          permStore.approve(permissionKey, 'forever', _dlgMeta);
        } catch { /* best effort */ }
      } else if (result === 'allow') {
        try {
          const permStore = require('./permissionStore');
          permStore.approve(permissionKey, 'once', _dlgMeta);
        } catch { /* best effort */ }
      } else if (result === 'deny') {
        try {
          const permStore = require('./permissionStore');
          permStore.deny(permissionKey, 'session', _dlgMeta);
        } catch { /* best effort */ }
      }
      return result;
    } catch { /* dialog not available — fall through to legacy */ }
  }

  // Legacy text-based approval (original code)
  console.log('');
  console.log(formatToolCall(toolName, params));

  // Show reasoning if available
  if (params._reasoning) {
    console.log(chalk().dim('  💭 AI 思考:'));
    console.log(chalk().dim(`     ${params._reasoning}`));
    console.log('');
  }

  // Interactive selection (Claude Code style)
  const riskInfo = getToolRisk(toolName);
  const question = chalk().yellow(`  Do you want to execute `) + chalk().bold(toolName) + chalk().yellow('?');
  console.log(question);
  console.log(`  ${chalk().white('❯ 1.')} ${chalk().green('Yes')}`);
  console.log(`    ${chalk().white('2.')} ${chalk().blue('Yes always')}`);
  console.log(`    ${chalk().white('3.')} ${chalk().red('No')}`);
  console.log('');
  console.log(chalk().dim('  Esc to cancel · Tab to amend'));

  const answer = await askUser(chalk().dim('  > '));
  const normalized = answer.trim().toLowerCase();

  switch (normalized) {
    case '1':
    case 'y':
    case 'yes':
    case '':
      return 'allow';

    case '2':
    case 'a':
    case 'always':
    case 'trust':
      approveTool(toolName, true); // Persist to disk
      console.log(chalk().green(`  ✓ Permanently trusted "${toolName}"`));
      return 'allow-always';

    case '3':
    case 'n':
    case 'no':
    case 'deny':
      console.log(chalk().red(`  ✗ Denied "${toolName}"`));
      return 'deny';

    // Backward-compatible aliases for previous "session trust" input
    case 's':
    case 'session':
      return 'allow';

    default: {
      // Before falling back to deny, consult the natural-language reply
      // recognizer (SSOT, gated) so typed affirmatives the literal cases miss —
      // CJK 是/好/可以/同意/批准/允许/确认, English approve/ok/sure — are honored
      // instead of being silently denied. Fail-soft + gate-off → null → original
      // "Unrecognized input, denied" byte-fallback below.
      let _nlDecision = null;
      try {
        const { classifyPermissionReply } = require('../cli/permissionReply');
        _nlDecision = classifyPermissionReply(normalized);
      } catch { _nlDecision = null; }

      if (_nlDecision === 'allow') return 'allow';
      if (_nlDecision === 'allow-always') {
        approveTool(toolName, true); // Persist to disk
        console.log(chalk().green(`  ✓ Permanently trusted "${toolName}"`));
        return 'allow-always';
      }
      if (_nlDecision === 'deny') {
        console.log(chalk().red(`  ✗ Denied "${toolName}"`));
        return 'deny';
      }

      // Unknown input = deny for safety
      console.log(chalk().red(`  ✗ Unrecognized input, denied`));
      return 'deny';
    }
  }
}

// ── Helper ──

// External readline provider — injected by REPL so permission prompts
// don't conflict with the active readline interface
let _rlProvider = null;

// Preflight context — set of tool names pre-approved in batch
let _preflightContext = null;

function setPreflightContext(approvedSet) { _preflightContext = approvedSet; }
function clearPreflightContext() { _preflightContext = null; }

function setReadlineProvider(rlOrFn) {
  _rlProvider = rlOrFn;
}

function getReadlineProvider() {
  return _rlProvider;
}

function askUser(prompt) {
  return new Promise((resolve) => {
    // If a REPL readline is active, use it directly (avoids stdin conflict)
    const rl = typeof _rlProvider === 'function' ? _rlProvider() : _rlProvider;
    if (rl && typeof rl.question === 'function') {
      rl.question(prompt, (answer) => {
        resolve(answer);
      });
      return;
    }

    // Fallback: create a temporary readline (works in standalone/non-REPL context)
    const tempRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    tempRl.question(prompt, (answer) => {
      tempRl.close();
      resolve(answer);
    });
  });
}


module.exports = {
  // Permission modes & profile
  PERMISSION_MODES,
  permissionModeToProfile,
  setPermissionMode,
  getPermissionMode,
  // Dangerous mode
  enableDangerousMode,
  acknowledgeDangerousMode,
  isDangerousMode,
  disableDangerousMode,
  // Approval persistence
  isApproved,
  approveTool,
  loadPermissions,
  savePermissions,
  // Risk & display
  getToolRisk,
  formatToolCall,
  // Decision chain
  _decisionFromControl,
  _resolveToolBehavior,
  requestPermission,
  _ACCEPT_EDITS_TOOLS,
  // readline / preflight injection
  setPreflightContext,
  clearPreflightContext,
  setReadlineProvider,
  getReadlineProvider,
  askUser,
  // Host resolver injection (breaks the two reverse edges without a cycle)
  setPermissionResolvers,
};
