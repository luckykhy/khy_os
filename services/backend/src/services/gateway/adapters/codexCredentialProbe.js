'use strict';

/**
 * Codex CLI credential probe — file-based login/credential validation consumed
 * by codexAdapter.detect()/detectAsync(), so an installed-but-logged-out codex
 * CLI is no longer reported as an available gateway channel (which previously
 * let its config.toml default model, e.g. an unusable review model, become the
 * startup model for the whole gateway).
 *
 * Why file-based (zero spawn): the codex CLI persists its login state in
 * <CODEX_HOME>/auth.json — `OPENAI_API_KEY` for API-key auth, a non-empty
 * `tokens` object for ChatGPT OAuth login. This is the exact file the
 * adapter's own upstream writer (setCodexUpstream) manages, so reading it is a
 * cheap, deterministic check that never blocks gateway init on a child
 * process (no `codex login status` spawn needed; a spawn probe would also be
 * subject to the ≤10s short-I/O timeout exception, but the file check makes
 * it unnecessary altogether).
 *
 * Conservative policy (backward compatible): whenever credential state cannot
 * be POSITIVELY determined as missing (fs/parse error, unreadable auth.json),
 * the CLI stays available — strict gating must never produce false negatives
 * on exotic setups. The entire gate can be disabled with
 * KHY_CODEX_STRICT_DETECT=0 (default: strict mode ON).
 *
 * Pure leaf: no imports from the adapter (avoids require cycles); all state
 * derived from env + filesystem at call time.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Stable marker prefix so callers (getStatus detail builder) can distinguish
// "CLI missing" from "CLI installed but credentials missing".
const CREDENTIAL_ERROR_PREFIX = 'codex_credentials_missing';

function _isStrictDetectEnabled(env = process.env) {
  const raw = String(env.KHY_CODEX_STRICT_DETECT == null ? '' : env.KHY_CODEX_STRICT_DETECT)
    .trim()
    .toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/**
 * Candidate codex config directories, in the same order the codex CLI itself
 * resolves them: explicit CODEX_HOME first, then ~/.codex, then the XDG-style
 * ~/.config/codex (mirrors codexAdapter.readCodexConfig / resolveCodexConfigPaths).
 */
function resolveCodexConfigDirs(env = process.env) {
  const dirs = [];
  const codexHome = String(env.CODEX_HOME || '').trim();
  if (codexHome) {
    dirs.push(codexHome);
  }
  const homeDir = os.homedir();
  dirs.push(path.join(homeDir, '.codex'));
  dirs.push(path.join(homeDir, '.config', 'codex'));
  return dirs;
}

/**
 * Determine whether the codex CLI has a usable credential.
 * @returns {{ok: boolean, state: 'valid'|'missing'|'unknown', source?: string, reason?: string}}
 */
function checkCodexCredentials(env = process.env) {
  // 1. Environment API keys work without any login file.
  if (String(env.CODEX_API_KEY || '').trim() || String(env.OPENAI_API_KEY || '').trim()) {
    return { ok: true, state: 'valid', source: 'env' };
  }

  const dirs = resolveCodexConfigDirs(env);
  let sawUnreadable = false;
  for (const dir of dirs) {
    const authPath = path.join(dir, 'auth.json');
    try {
      if (fs.existsSync(authPath)) {
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
        } catch {
          // Present but unparseable → indeterminate, not provably missing.
          sawUnreadable = true;
          continue;
        }
        const hasApiKey = !!String((parsed && parsed.OPENAI_API_KEY) || '').trim();
        const tokens = parsed && parsed.tokens;
        const hasTokens = !!(
          tokens &&
          typeof tokens === 'object' &&
          Object.keys(tokens).length > 0
        );
        if (hasApiKey || hasTokens) {
          return { ok: true, state: 'valid', source: authPath };
        }
        // auth.json exists but holds no usable credential → logged out; keep
        // scanning remaining candidate dirs before concluding "missing".
        continue;
      }
      // No auth.json — a custom provider in config.toml may declare
      // env_key = "SOME_VAR"; a set env var of that name is a valid credential.
      const configPath = path.join(dir, 'config.toml');
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        for (const m of content.matchAll(/env_key\s*=\s*"([^"]+)"/g)) {
          const varName = String(m[1] || '').trim();
          if (varName && String(env[varName] || '').trim()) {
            return { ok: true, state: 'valid', source: `env:${varName}` };
          }
        }
      }
    } catch {
      sawUnreadable = true;
    }
  }

  if (sawUnreadable) {
    // Could not read the auth state → conservative: do not gate.
    return { ok: true, state: 'unknown', source: 'unreadable' };
  }
  return {
    ok: false,
    state: 'missing',
    reason: `未发现有效登录态（已检查 ${dirs.length}/${dirs.length} 个 codex 配置目录的 auth.json 与 API key 环境变量）`,
  };
}

/**
 * Single-line gate for detect()/detectAsync(): downgrade an "installed" codex
 * CLI to unavailable when strict mode is on and credentials are provably
 * missing. Never throws — a probe failure keeps the previous availability.
 *
 * @param {boolean} available  CLI-existence detection outcome
 * @param {(msg: string) => void} setDetectError  sink for _lastDetectError
 * @returns {boolean} gated availability
 */
function applyCodexCredentialGate(available, setDetectError, env = process.env) {
  if (!available) {
    return available;
  }
  if (!_isStrictDetectEnabled(env)) {
    return available;
  }
  try {
    const verdict = checkCodexCredentials(env);
    if (verdict.ok) {
      return available;
    }
    if (typeof setDetectError === 'function') {
      try {
        setDetectError(`${CREDENTIAL_ERROR_PREFIX}: ${verdict.reason}`);
      } catch {
        /* sink is best-effort */
      }
    }
    return false;
  } catch {
    // The gate itself failed → conservative: keep the CLI available.
    return available;
  }
}

/**
 * User-facing unavailable detail for codexAdapter.getStatus(): distinguishes
 * "credentials missing" (CLI installed, login required) from the historical
 * "CLI not found" message.
 */
function buildCodexUnavailableDetail(lastDetectError = '') {
  const err = String(lastDetectError || '');
  if (err.startsWith(CREDENTIAL_ERROR_PREFIX)) {
    const why = err.slice(CREDENTIAL_ERROR_PREFIX.length + 2) || '凭证校验失败';
    return `codex CLI 已安装但凭证未就绪 (${why}) · 运行 codex login 登录，或设置 KHY_CODEX_STRICT_DETECT=0 关闭严格校验`;
  }
  return `未检测到 codex 命令${err ? ` (${err})` : ''} · 可运行 khy tools install codex 安装便携版`;
}

module.exports = {
  CREDENTIAL_ERROR_PREFIX,
  resolveCodexConfigDirs,
  checkCodexCredentials,
  applyCodexCredentialGate,
  buildCodexUnavailableDetail,
  _isStrictDetectEnabled,
};
