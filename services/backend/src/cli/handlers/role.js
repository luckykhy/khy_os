'use strict';

/**
 * Role Command Handler — `khy role …`.
 *
 * The third capability-as-code instance (DESIGN-ARCH-059) and the first
 * *behavioral* one. One shared core, `runRole()`, is exposed as the `khy role`
 * CLI command, the `/role` slash command, the agent tool `tools/adoptRole.js`,
 * AND the in-chat auto-detection seam in cli/ai.js — so role synthesis, the
 * safety gates, the ephemeral session store and persistence all live in exactly
 * one place (mirroring the doc.js → docTitleStyle and convert.js → convertFile
 * patterns, but with roleService instead of a Python helper).
 *
 *   role <description> [--save] [--clear] [--show] [--preset key]
 *
 * "Correctly" adopting a role is a safety problem: a synthesized role only
 * shapes voice / expertise and is layered BELOW the hard prohibitions, project
 * rules and persona red-lines (see getRoleSection in constants/prompts.js).
 *
 * @module handlers/role
 */

/**
 * Core capability: set / clear / show the active role. Returns a structured
 * result; never throws. Called by the CLI handler, the agent tool, and the
 * in-chat auto-detect path.
 *
 * @param {object} opts
 * @param {string} [opts.role]   - The role description ("资深律师", "act as a poet").
 * @param {'set'|'clear'|'show'} [opts.action='set'] - What to do.
 * @param {'session'|'save'} [opts.scope='session']  - 'save' also persists to persona.md.
 * @param {string} [opts.preset] - Force a preset key (skips matching).
 * @param {string} [opts.cwd]    - Working dir for persistence (defaults to KHYQUANT_CWD/cwd).
 * @param {object} [deps]        - Test seam, forwarded to roleService.persistRole.
 * @returns {{success:boolean, action?:string, title?:string, notice?:string, error?:string, ...}}
 */
function runRole(opts = {}, deps = {}) {
  let roleService;
  try { roleService = require('../../services/roleService'); }
  catch (err) { return { success: false, error: `角色服务不可用：${err.message}` }; }

  const action = opts.action || (opts.clear ? 'clear' : opts.show ? 'show' : 'set');
  const cwd = opts.cwd || process.env.KHYQUANT_CWD || process.cwd();

  // ── clear ───────────────────────────────────────────────────────────────
  if (action === 'clear') {
    const had = roleService.clearActiveRole();
    let unpersisted = false;
    if (opts.scope === 'save') {
      try { unpersisted = !!(roleService.unpersistRole(cwd, deps) || {}).changed; } catch { /* best-effort */ }
    }
    return {
      success: true,
      action: 'clear',
      cleared: had,
      unpersisted,
      notice: had
        ? '已退出角色，恢复默认身份。'
        : '当前没有正在扮演的角色。',
    };
  }

  // ── show ────────────────────────────────────────────────────────────────
  if (action === 'show') {
    const active = roleService.getActiveRole();
    return {
      success: true,
      action: 'show',
      active: active ? { title: active.title } : null,
      title: active ? active.title : null,
      notice: active
        ? `当前角色：${active.title}（本次对话生效）。`
        : '当前没有正在扮演的角色。可用「角色: 资深律师」开始扮演。',
    };
  }

  // ── set ─────────────────────────────────────────────────────────────────
  const syn = roleService.synthesizeRole(opts.role, { preset: opts.preset });
  if (!syn.ok) return { success: false, action: 'set', error: syn.error };

  const active = roleService.setActiveRole(syn.role);
  const result = {
    success: true,
    action: 'set',
    title: syn.role.title,
    scope: opts.scope === 'save' ? 'save' : 'session',
    persisted: false,
  };

  if (opts.scope === 'save') {
    const saved = roleService.persistRole(syn.role, cwd, deps);
    if (saved.ok) {
      result.persisted = true;
      result.dest = saved.dest;
    } else {
      // Setting the session role still succeeded; surface the save failure softly.
      result.saveError = saved.error;
    }
  }

  result.notice = result.persisted
    ? `已扮演「${syn.role.title}」并保存到长期人格（${require('path').basename(result.dest || 'persona.md')}）。说「退出角色」可恢复。`
    : `已临时扮演「${syn.role.title}」（本次对话有效）。说「保存角色」可长期保留，说「退出角色」可恢复默认。`;
  if (result.saveError) result.notice += `（保存失败：${result.saveError}）`;
  return result;
}

/**
 * CLI entry: `khy role <description> [--save] [--clear] [--show] [--preset key]`.
 * The description is a positional argument; flags arrive in `options`.
 * @param {object} parsed - { subCommand, args, options }
 * @returns {Promise<boolean>}
 */
async function handleRole(parsed = {}) {
  const { printInfo, printError, printSuccess } = require('../formatters');
  const options = parsed.options || {};
  const args = Array.isArray(parsed.args) ? parsed.args : [];

  // Collect the positional description (parser may place the first token in
  // subCommand or args[0]); flags like --save/--clear/--show are NOT it.
  const positional = [];
  if (parsed.subCommand) positional.push(parsed.subCommand);
  positional.push(...args);
  const description = options.role || positional.join(' ').trim();

  const clear = !!options.clear || /^(clear|reset|off|退出|清除)$/i.test(description);
  const show = !!options.show || /^(show|status|当前)$/i.test(description);
  const save = !!options.save;

  if (!clear && !show && !description) {
    printError('用法: role <角色描述> [--save 长期保留] [--clear 退出角色] [--show 查看当前]');
    printInfo('例如: role 资深律师    /    role "act as a strict interviewer" --save');
    try {
      const { PRESETS } = require('../../services/roleService');
      printInfo(`内置预设: ${Object.keys(PRESETS).join('、')}`);
    } catch { /* ignore */ }
    return true;
  }

  const result = runRole({
    role: description,
    action: clear ? 'clear' : show ? 'show' : 'set',
    scope: save ? 'save' : 'session',
    preset: options.preset,
  });

  if (result.success) {
    printSuccess(result.notice);
  } else {
    printError(result.error || '角色设置失败');
  }
  return true;
}

module.exports = { runRole, handleRole };
