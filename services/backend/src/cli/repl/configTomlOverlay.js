/**
 * configTomlOverlay — ~/.khy/config.toml 只读覆盖层。
 *
 * 设计对齐 Y-code (xingyao-y-code) 的 config.toml > config.json 深合并:
 *   - 读取 ~/.khy/config.toml (若存在)
 *   - 解析为对象 (使用现有 tomlLite 零依赖解析器)
 *   - 优先级: config.toml > 所有 settings.json 层
 *   - 仅读取，绝不写回 TOML
 *
 * 优先级链 (低 → 高):
 *   1. user            ~/.khy/settings.json
 *   2. project-shared  <cwd>/.khy/settings.json
 *   3. project-local   <cwd>/.khy/settings.local.json
 *   4. managed         %PROGRAMDATA%\khy\managed-settings.json
 *   5. toml-overlay    ~/.khy/config.toml        ← 本模块
 *
 * 环境变量 KHY_CONFIG_TOML 可覆盖 TOML 路径 (测试/定制部署用)。
 *
 * 容错:
 *   - TOML 不存在 → 静默跳过
 *   - TOML 解析失败 → 警告并回退纯 JSON
 *   - TOML 值经一次写操作会固化进 settings.json，此后删除 TOML 不会回退
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 复用现有零依赖 TOML 解析器 (与 codex/reasonix adapter 同实现)
const { parse } = require('../../services/domain/network/externalApps/tomlLite');

/**
 * 解析 TOML 文本为对象。返回 { ok, data, error }。
 * @param {string} text
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
function safeParseToml(text) {
  if (!text || !text.trim()) {
    return { ok: true, data: {} };
  }
  try {
    const data = parse(text);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 解析 ~/.khy/config.toml。返回 { applied, data, error }。
 *
 * @param {object} [opts]
 * @param {string} [opts.tomlPath] 显式路径 (覆盖默认 ~/.khy/config.toml)
 * @returns {{ applied: boolean, data: object|null, error: string|null, file: string|null }}
 */
export function readConfigTomlOverlay(opts = {}) {
  const tomlPath =
    opts.tomlPath ||
    process.env.KHY_CONFIG_TOML ||
    path.join(_homeDir(), '.khy', 'config.toml');

  if (!fs.existsSync(tomlPath)) {
    return { applied: false, data: null, error: null, file: null };
  }

  let text;
  try {
    text = fs.readFileSync(tomlPath, 'utf-8');
  } catch (e) {
    return { applied: false, data: null, error: `读取失败: ${e.message}`, file: tomlPath };
  }

  const result = safeParseToml(text);
  if (!result.ok) {
    return { applied: false, data: null, error: result.error, file: tomlPath };
  }

  return { applied: true, data: result.data, error: null, file: tomlPath };
}

/**
 * 将 config.toml 覆盖到现有 settings 对象上。
 * 纯函数，不修改输入。
 *
 * @param {object} baseSettings — resolveKhySettings() 返回的合并结果
 * @param {object} tomlData — 解析后的 TOML 对象
 * @returns {object} 新的合并结果
 */
export function applyConfigTomlOverlay(baseSettings, tomlData) {
  if (!tomlData || typeof tomlData !== 'object') {
    return baseSettings;
  }
  return _deepMerge(baseSettings || {}, tomlData);
}

/**
 * 完整入口: 读取 TOML 并应用到 base settings。
 *
 * @param {object} baseSettings — resolveKhySettings() 返回的合并结果
 * @param {object} [opts] — 透传给 readConfigTomlOverlay
 * @returns {{ settings: object, overlay: { applied: boolean, data: object|null, error: string|null, file: string|null } }}
 */
export function resolveSettingsWithToml(baseSettings, opts = {}) {
  const overlay = readConfigTomlOverlay(opts);

  if (!overlay.applied) {
    return { settings: baseSettings, overlay };
  }

  const merged = applyConfigTomlOverlay(baseSettings, overlay.data);
  return { settings: merged, overlay };
}

// ── 内部工具 ────────────────────────────────────────────────

function _homeDir() {
  const override = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  if (override && String(override).trim()) {
    return String(override);
  }
  return os.homedir();
}

function _isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _deepMerge(base, override) {
  const out = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (_isPlainObject(val) && _isPlainObject(out[key])) {
      out[key] = _deepMerge(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}
