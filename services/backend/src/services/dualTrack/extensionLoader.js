'use strict';

/**
 * extensionLoader.js — 用户扩展轨装载 + 沙箱边界（任务三 · 合并策略 + 红线5）。
 *
 * 启动时以官方核心为基座，动态扫描用户扩展轨（默认 `user_patch/`），把其中声明的
 * 覆写 / 钩子 / 新增动作执行器注入注册表。两条铁律：
 *   - 单个扩展加载失败（manifest 损坏 / require 抛错）**绝不**让基座崩溃，记录后跳过
 *     （base runtime 永远先活下来）。
 *   - 沙箱边界（红线5）：用户/模型只能在用户扩展轨内落地代码；任何指向官方核心轨或轨外
 *     的路径解析一律抛 CorePollutionError——**绝不**允许污染官方核心源文件。
 *
 * 纯副作用注入：fs / requireImpl / path / logger 全部可注入，便于测试与跨平台。
 */

const nodePath = require('path');
const { CorePollutionError } = require('./actionRegistry');

// 受保护的用户轨目录名：官方更新与污染检查统一以这两个名字识别用户领地（红线4/5）。
const USER_TRACK_PROTECTED_NAMES = Object.freeze(['user_patch', 'extensions']);

/**
 * 断言目标路径解析后落在用户扩展轨内。否则即越界，抛 CorePollutionError（红线5）。
 * 用 path.relative 判定包含关系，免受 `..` / 符号路径绕过。
 */
function assertWithinUserTrack(targetPath, userTrackRoot, pathImpl = nodePath) {
  const root = pathImpl.resolve(userTrackRoot);
  const abs = pathImpl.resolve(root, targetPath);
  const rel = pathImpl.relative(root, abs);
  const escapes = rel === '..' || rel.startsWith('..' + pathImpl.sep) || pathImpl.isAbsolute(rel);
  if (escapes) {
    throw new CorePollutionError(`路径越出用户扩展轨，严禁污染核心或轨外: ${targetPath}`);
  }
  return abs;
}

/**
 * 装载用户扩展轨。
 *
 * manifest.json 形如：
 *   {
 *     "name": "my-patch",
 *     "overrides": [ { "actionType": "say", "module": "./overrides/say.js" } ],
 *     "actions":   [ { "actionType": "speak_v2", "module": "./actions/speak_v2.js" } ]
 *   }
 * 每个 module 默认导出一个 handler 函数（或 { handler }）。
 *
 * @returns {{ loaded:Array, skipped:Array, errors:Array }}
 */
function loadUserTrack(opts = {}) {
  const {
    userTrackRoot,
    registry,
    fs = require('fs'),
    requireImpl = require,
    pathImpl = nodePath,
    logger,
  } = opts;

  const result = { loaded: [], skipped: [], errors: [] };
  if (!userTrackRoot || !registry) {
    result.skipped.push({ name: '<all>', reason: '缺少 userTrackRoot 或 registry' });
    return result;
  }

  let manifestRaw;
  const manifestPath = pathImpl.join(userTrackRoot, 'manifest.json');
  try {
    if (!fs.existsSync(userTrackRoot) || !fs.existsSync(manifestPath)) {
      // 无扩展轨 = 纯净官方基座，正常态，不算错误。
      result.skipped.push({ name: '<manifest>', reason: '用户扩展轨不存在或无 manifest.json' });
      return result;
    }
    manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    result.errors.push({ name: '<manifest>', reason: `读取失败: ${e.message}` });
    return result; // 基座照常存活
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (e) {
    result.errors.push({ name: '<manifest>', reason: `manifest.json 解析失败: ${e.message}（基座照常运行）` });
    if (logger && logger.warn) logger.warn(`[dualTrack:loader] manifest 解析失败，跳过用户轨: ${e.message}`);
    return result;
  }

  const entries = []
    .concat((manifest.overrides || []).map((o) => ({ ...o, kind: 'override' })))
    .concat((manifest.actions || []).map((a) => ({ ...a, kind: 'action' })));

  for (const entry of entries) {
    const label = `${entry.kind}:${entry.actionType}`;
    try {
      if (!entry.actionType || !entry.module) {
        result.skipped.push({ name: label, reason: '缺少 actionType 或 module' });
        continue;
      }
      // 沙箱边界：module 必须落在用户轨内（红线5）。
      const modAbs = assertWithinUserTrack(entry.module, userTrackRoot, pathImpl);
      const mod = requireImpl(modAbs);
      const handler = typeof mod === 'function' ? mod
        : (mod && typeof mod.handler === 'function' ? mod.handler : null);
      if (!handler) {
        result.skipped.push({ name: label, reason: '模块未导出 handler 函数' });
        continue;
      }
      registry.registerOverride(entry.actionType, handler, { source: `user_track:${manifest.name || 'unnamed'}` });
      result.loaded.push({ name: label, actionType: entry.actionType, kind: entry.kind });
    } catch (e) {
      // 单个扩展坏掉绝不拖垮基座（graceful）。
      result.errors.push({ name: label, reason: e.message });
      if (logger && logger.warn) logger.warn(`[dualTrack:loader] 扩展 ${label} 加载失败，已跳过: ${e.message}`);
    }
  }
  return result;
}

module.exports = { loadUserTrack, assertWithinUserTrack, USER_TRACK_PROTECTED_NAMES };
