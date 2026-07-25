'use strict';

/**
 * promptComposerService — /prompt 长提示词撰写的**IO 编排层**(移植自 Hermes v0.18.0 /prompt)。
 *
 * 职责:在 $EDITOR 里让用户从容撰写多行长提示词,再把正文原样交回调用方发给 AI。
 *   1) 建临时 markdown 文件,写入种子内容(纯叶子 promptComposer.buildComposerSeed:顶部 #! 指引行 + 初始正文);
 *   2) 拉起编辑器(VISUAL → EDITOR → 平台默认 notepad/nano),阻塞至用户保存关闭;
 *   3) 读回文件 → 纯叶子 stripComposerSentinels 剥掉 #! 指引行并 trim;
 *   4) 无论成败**用后即删**临时文件(finally);空正文 → reason:'empty' 不发送。
 *
 * 本层做副作用(fs/spawn);判定/文本处理全在纯叶子 promptComposer(零 IO、绝不抛、可离线单测)。
 * 所有外部依赖(fs / os / path / 编辑器执行器 / env)均可注入 → 无需真拉起编辑器即可测编排。
 *
 * 门控 KHY_PROMPT_COMPOSE(default-on):关 → composeInEditor 直接返回 {reason:'disabled'},
 * 能力惰性化(既有 prompt 库 save/list/use 不受影响)。绝不抛(内部 try/catch 兜底)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const flagRegistry = require('./flagRegistry');
const {
  buildComposerSeed,
  stripComposerSentinels,
  isBlankPrompt,
} = require('./promptComposer');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _off(v) {
  return v !== undefined && _FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 撰写门是否启用(默认开)。委托 flagRegistry('KHY_PROMPT_COMPOSE');注册表关时逐字节回退手写判定。
 * @param {object} [env]
 * @returns {boolean}
 */
function isPromptComposeEnabled(env) {
  const e = env || process.env || {};
  try {
    if (flagRegistry.isRegistryEnabled(e)) {
      return flagRegistry.isFlagEnabled('KHY_PROMPT_COMPOSE', e);
    }
  } catch { /* 注册表异常 → 回退手写判定 */ }
  return !_off(e.KHY_PROMPT_COMPOSE);
}

/** 解析要拉起的编辑器命令:VISUAL → EDITOR → 平台默认(win32 notepad,余 nano)。 */
function _resolveEditor(env, platform) {
  const e = env || {};
  const v = String(e.VISUAL || '').trim();
  if (v) return v;
  const ed = String(e.EDITOR || '').trim();
  if (ed) return ed;
  return (platform || process.platform) === 'win32' ? 'notepad' : 'nano';
}

/** 默认编辑器执行器:阻塞式 spawnSync,继承 stdio 让用户直接交互。返回 { status, error? }。 */
function _defaultRunEditor(editorCmd, file) {
  const { spawnSync } = require('child_process');
  const parts = String(editorCmd || '').trim().split(/\s+/).filter(Boolean);
  const bin = parts[0] || 'nano';
  const preArgs = parts.slice(1);
  const r = spawnSync(bin, [...preArgs, file], { stdio: 'inherit' });
  return { status: r.status, error: r.error ? String(r.error.message || r.error) : null };
}

/**
 * 在编辑器里撰写一段提示词。绝不抛;各类失败都返回结构化 reason。
 *
 * @param {object} [options]
 * @param {string} [options.initialText]  - 命令后附带的初始正文(种子)
 * @param {object} [options.env]          - 环境变量源(默认 process.env)
 * @param {object} [options.fs]           - 注入 fs(测试用)
 * @param {object} [options.os]           - 注入 os(测试用)
 * @param {object} [options.path]         - 注入 path(测试用)
 * @param {string} [options.platform]     - 注入平台(测试用)
 * @param {(cmd:string,file:string)=>{status?:number,error?:string}} [options.runEditor] - 注入编辑器执行器(测试用)
 * @returns {{ ok: boolean, empty: boolean, text: string, reason: string, detail?: string, editor?: string }}
 */
function composeInEditor(options = {}) {
  const opts = options || {};
  const env = opts.env || process.env || {};
  if (!isPromptComposeEnabled(env)) {
    return { ok: false, empty: true, text: '', reason: 'disabled' };
  }

  const fsImpl = opts.fs || fs;
  const osImpl = opts.os || os;
  const pathImpl = opts.path || path;
  const runEditor = opts.runEditor || _defaultRunEditor;
  const editorCmd = _resolveEditor(env, opts.platform);

  let tmpFile = null;
  let tmpDir = null;
  try {
    tmpDir = fsImpl.mkdtempSync(pathImpl.join(osImpl.tmpdir(), 'khy-prompt-'));
    tmpFile = pathImpl.join(tmpDir, 'prompt.md');
    fsImpl.writeFileSync(tmpFile, buildComposerSeed(opts.initialText), 'utf8');

    const run = runEditor(editorCmd, tmpFile, env) || {};
    if (run.error) {
      return { ok: false, empty: true, text: '', reason: 'editor-failed', detail: String(run.error), editor: editorCmd };
    }

    const raw = fsImpl.readFileSync(tmpFile, 'utf8');
    const text = stripComposerSentinels(raw);
    if (isBlankPrompt(text)) {
      return { ok: false, empty: true, text: '', reason: 'empty', editor: editorCmd };
    }
    return { ok: true, empty: false, text, reason: 'composed', editor: editorCmd };
  } catch (e) {
    return { ok: false, empty: true, text: '', reason: 'error', detail: String((e && e.message) || e) };
  } finally {
    // 用后即删:先删文件再删临时目录。清理失败绝不影响返回(双 try/catch)。
    try { if (tmpFile) fsImpl.unlinkSync(tmpFile); } catch { /* ignore */ }
    try { if (tmpDir) fsImpl.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

module.exports = {
  isPromptComposeEnabled,
  composeInEditor,
  // 供聚焦单测
  _resolveEditor,
};
