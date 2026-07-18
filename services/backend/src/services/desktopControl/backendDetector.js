'use strict';

/**
 * desktopControl/backendDetector.js — 本机「眼/手/耳/嘴」能力探测（DESIGN-ARCH-056）。
 *
 * 只回答一个问题：在当前宿主上，桌面操控的每条感官各自有没有可用的后端、用哪一个。
 * 它消费 backendRegistry 的登记表，对每个后端探活（which），选出第一个可用者。
 *
 * 探活分两级：
 *   - 浅探：可执行文件在 PATH 中（searchExecutable）。
 *   - 深探：对声明了 importProbe 的后端（如 pyautogui）额外跑 `python3 -c "import pyautogui"`，
 *           因为「有 python3」不等于「装了 pyautogui」。
 *
 * 全部可注入（which / importRun / voiceCaps）便于无副作用单测；结果缓存，可显式 reset。
 */

const { execFileSync } = require('child_process');
const registry = require('./backendRegistry');

let _searchExecutable = null;
function _which(name) {
  if (!_searchExecutable) {
    // 复用既有跨平台 which/where 实现，避免重复。
    _searchExecutable = require('../../tools/platformUtils').searchExecutable;
  }
  return _searchExecutable(name);
}

/** 深探：某 import 在 python3 里是否可用。任何失败都判否（fail-closed）。 */
function _defaultImportRun(importStmt) {
  try {
    execFileSync('python3', ['-c', importStmt], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

let _cache = null;

/**
 * 在给定平台上，为某类后端挑出第一个可用者。
 * @returns {{available:boolean, backend:string|null, candidates:string[], installHints:object[]}}
 */
function _selectBackend(platform, kind, deps) {
  const which = deps.which || _which;
  const importRun = deps.importRun || _defaultImportRun;
  const backends = registry.backendsFor(platform, kind);
  const candidates = backends.map((b) => b.id);
  const installHints = [];

  for (const b of backends) {
    const path = which(b.probe);
    if (!path) {
      if (b.optionalDep) installHints.push({ backend: b.id, ...b.optionalDep });
      continue;
    }
    // 深探：声明 importProbe 的后端需运行期 import 成功。
    if (b.importProbe && !importRun(b.importProbe)) {
      if (b.optionalDep) installHints.push({ backend: b.id, ...b.optionalDep });
      continue;
    }
    return { available: true, backend: b.id, candidates, installHints };
  }
  return { available: false, backend: null, candidates, installHints };
}

/** 取某类后端的解析对象（含 ops），供 capture/input 使用。 */
function resolveBackend(platform, kind, backendId) {
  return registry.backendsFor(platform, kind).find((b) => b.id === backendId) || null;
}

/**
 * 全量探测。返回能力图：
 *   { platform, eyes:{...}, hands:{...}, voice:{tts, stt}, summary }
 * @param {object} [deps] { which, importRun, voiceCaps, platform, force }
 */
function detect(deps = {}) {
  const platform = deps.platform || registry.PLATFORM;
  if (_cache && !deps.force && !deps.which && !deps.platform) return _cache;

  const eyes = _selectBackend(platform, 'capture', deps);
  const hands = _selectBackend(platform, 'input', deps);
  // 感知（结构化「看清」）：无障碍树后端。缺它仍可截屏，但拿不到可点击元素清单。
  const perception = _selectBackend(platform, 'inspect', deps);

  // 嘴/耳复用 voiceService 的能力探测（可注入）。
  let voice = { tts: { available: false, provider: null }, stt: { available: false, provider: null } };
  try {
    // voiceService.getCapabilities() → { tts, stt, platform }，tts/stt 为 provider 串或 null/false。
    const caps = deps.voiceCaps || require('../voiceService').getCapabilities();
    voice = {
      tts: { available: !!(caps && caps.tts), provider: (caps && caps.tts) || null },
      stt: { available: !!(caps && caps.stt), provider: (caps && caps.stt) || null },
    };
  } catch { /* voiceService 不可用时保持默认 false */ }

  const result = {
    platform,
    eyes,
    hands,
    perception,
    voice,
    summary: {
      canSee: eyes.available,
      canPerceive: perception.available,
      canActuate: hands.available,
      canSpeak: voice.tts.available,
      canHear: voice.stt.available,
    },
  };

  if (!deps.which && !deps.platform) _cache = result;
  return result;
}

function reset() { _cache = null; _searchExecutable = null; }

module.exports = {
  detect,
  reset,
  resolveBackend,
  // 测试种子
  _selectBackend,
  _defaultImportRun,
};
