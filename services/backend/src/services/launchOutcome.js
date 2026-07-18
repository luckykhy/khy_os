'use strict';

// Launch-outcome wording — pure leaf (zero IO, zero business require,
// deterministic, env-gated).
//
// WHY THIS EXISTS (the real defect it fixes):
//   On win32 the launcher spawns the app detached. A clean spawn (the `'spawn'`
//   event fired, no `'error'`) means the OS HAS started the process. But the old
//   `_formatLaunchOutput` ignores that fact and instead reports the result of a
//   2-second `tasklist` poll: if the image name can't be inferred, or the poll
//   races past the new PID, `verified:false` → the user-facing line reads
//   「未验证:未检测到新进程 quark.exe」. That phrasing READS LIKE A FAILURE even
//   though `success` is in fact always `true` — so the model second-guesses
//   itself and retries the same launch in circles.
//
//   Every non-Windows platform already trusts the spawn (`{verified:true,
//   mode:'spawn'}`). Windows is the lone outlier. This leaf converges the wording
//   so a successful spawn is honestly reported as 已启动, with the window-confirm
//   poll demoted to best-effort context — WITHOUT touching the poll algorithm or
//   the `success`/`verified` fields (out of scope by design).
//
// Gate: KHY_LAUNCH_TRUST_SPAWN (default ON). Off → wording falls back
// byte-identically to the legacy `_formatLaunchOutput` four-branch strings.

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const raw = env && env.KHY_LAUNCH_TRUST_SPAWN;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// Byte-identical reproduction of the legacy `_formatLaunchOutput` in
// toolCalling.js. Kept here so the gate-off path is provably the old behavior;
// the shell still retains its own copy as the require-failure fallback.
function _legacyFormat(displayName, execHint, verification) {
  if (verification && verification.verified) {
    return `已启动并验证: ${displayName} (${execHint})`;
  }
  if (!verification) {
    return `已发送启动请求: ${displayName} (${execHint})（未验证）`;
  }
  if (verification.mode === 'unverifiable') {
    return `已发送启动请求: ${displayName} (${execHint})（未验证：无法识别目标进程）`;
  }
  if (verification.reason === 'no-new-process-detected' && verification.imageName) {
    return `已发送启动请求: ${displayName} (${execHint})（未验证：未检测到新进程 ${verification.imageName}）`;
  }
  return `已发送启动请求: ${displayName} (${execHint})（未验证）`;
}

/**
 * Format the user-facing launch line.
 *
 * Gate ON:
 *   - verified              → 「已启动并验证: X (hint)」  (unchanged)
 *   - spawned, not verified → 「已启动: X (hint)（启动命令已成功返回；
 *                              2s 内未捕捉到新进程,窗口确认为尽力而为,
 *                              不代表启动失败）」
 *   - verification missing  → same honest "已启动" line (spawn returned cleanly,
 *                              we simply ran no window check)
 *
 * Gate OFF: byte-identical to the legacy four-branch wording.
 *
 * Note: this is only ever reached AFTER `_spawnDetached` resolved without error,
 * i.e. the OS accepted the launch — which is exactly why "已启动" is honest.
 */
function formatLaunchOutput(displayName, execHint, verification, env) {
  if (!isEnabled(env)) {
    return _legacyFormat(displayName, execHint, verification);
  }
  if (verification && verification.verified) {
    return `已启动并验证: ${displayName} (${execHint})`;
  }
  return `已启动: ${displayName} (${execHint})`
    + `（启动命令已成功返回；2s 内未捕捉到新进程,窗口确认为尽力而为,不代表启动失败）`;
}

module.exports = {
  isEnabled,
  formatLaunchOutput,
  _legacyFormat,
};
