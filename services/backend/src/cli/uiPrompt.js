'use strict';

/**
 * uiPrompt — a single bridge that lets inquirer-style command handlers collect
 * input through the native Ink form (FormFlow) when the Ink TUI owns the
 * terminal, and fall through to real inquirer otherwise.
 *
 * Why this exists
 * ---------------
 * inquirer spins up its own readline and grabs stdin in cooked mode. The Ink
 * TUI already owns stdin in raw mode, so any handler that calls `inquirer.prompt`
 * while Ink is mounted topples the entire UI (the "/model quits KHY" crash
 * class — stdin.isTTY is still true, so the classic non-TTY guard never fires).
 *
 * Rather than rewrite every dropped-to-classic command, handlers swap
 *   const inquirer = require('inquirer');         // ← old
 *   const { promptCompat } = require('../uiPrompt'); // ← new
 * and call `promptCompat(questions)` with the SAME inquirer question array.
 * When Ink is active and registered, the questions are translated to a FormFlow
 * spec and collected natively; otherwise the real inquirer is invoked, so the
 * classic REPL behaves exactly as before (zero behavioural change off-TUI).
 *
 * Registration lifecycle
 * -----------------------
 * <App/> calls `register(askForm)` on mount and `unregister()` on unmount, so
 * `isTuiActive()` is true only while a live FormFlow host exists. `register`
 * also mirrors `KHY_INK_TUI_ACTIVE` (set by startInkApp) — both must hold for a
 * native prompt: the env flag means "Ink owns the terminal", the registered
 * askForm means "a host is mounted to render the overlay".
 *
 * Reliable fallback
 * -----------------
 * inquirer features FormFlow cannot honour (when/filter/transformer/editor/
 * expand/rawlist/pageSize-driven scrolling, async choices, …) make a question
 * UNSUPPORTED. `promptCompat` then falls back to real inquirer rather than
 * silently dropping the feature — correctness over native rendering. The pure
 * translation core (`inquirerToFormSpec`) is exported for unit testing without
 * mounting React.
 */

// The mounted FormFlow opener: (spec) => Promise<answers|null>. Null until <App/>
// registers it; cleared on unmount so a stale closure is never called.
let _askForm = null;

/**
 * Register the native form opener. Called by <App/> on mount.
 * @param {(spec: object) => Promise<object|null>} askForm
 */
function register(askForm) {
  _askForm = typeof askForm === 'function' ? askForm : null;
}

/** Clear the registration. Called by <App/> on unmount. */
function unregister() {
  _askForm = null;
}

/**
 * True when a native prompt can be rendered RIGHT NOW: Ink owns the terminal
 * (env flag set by startInkApp) AND a FormFlow host is mounted (registered).
 * Both are required — either alone would mean a prompt that cannot be shown.
 */
function isTuiActive() {
  return _askForm !== null && process.env.KHY_INK_TUI_ACTIVE === '1';
}

// Inquirer prompt types FormFlow can render natively. Anything else (editor,
// expand, rawlist, number with custom step, …) routes to real inquirer.
const SUPPORTED_TYPES = new Set(['input', 'password', 'list', 'confirm', 'checkbox', 'number']);

// Inquirer features with no FormFlow equivalent that also change the RESULT
// (whether a question is asked, or the value it returns). A question carrying
// any of these cannot be faithfully reproduced, so the whole batch falls back
// to real inquirer. Cosmetic-only keys (pageSize scroll-window, loop wrap,
// suffix/prefix message decoration) are deliberately NOT here: they never alter
// the collected answer, so under the TUI they are simply ignored rather than
// forcing a fallback that would topple the managed UI. inquirer still honours
// them on the classic path (which receives the original question objects).
const UNSUPPORTED_KEYS = ['when', 'filter', 'transformer'];

// Normalize an inquirer choice (string | {name,value} | {name,value,short}) into
// FormFlow's { name, value } shape. Separators (inquirer.Separator instances or
// {type:'separator'}) are dropped — FormFlow has no separator row.
function _normalizeChoice(choice) {
  if (choice == null) return null;
  if (typeof choice === 'string' || typeof choice === 'number') {
    return { name: String(choice), value: choice };
  }
  if (typeof choice === 'object') {
    if (choice.type === 'separator' || choice.constructor?.name === 'Separator') return null;
    const value = 'value' in choice ? choice.value : choice.name;
    const name = choice.name != null ? String(choice.name) : String(value);
    return { name, value };
  }
  return null;
}

// Resolve a (possibly function) inquirer field to a plain value, given answers
// so far. FormFlow has no async/dynamic resolution, so functional message/
// default/choices are evaluated once against the answers collected up to here.
function _resolve(maybeFn, answers) {
  return typeof maybeFn === 'function' ? maybeFn(answers) : maybeFn;
}

/**
 * Translate one inquirer question into a FormFlow field spec, or report why it
 * cannot be translated. Pure; no React, no inquirer.
 *
 * confirm → a 是/否 select whose value is coerced back to a boolean.
 * checkbox → marked multi:true (FormFlow multi-select); value list preserved.
 * list → select. input/password → same, mask preserved. number → input with a
 *   numeric-coercing validate wrapper.
 *
 * @returns {{ ok: true, field: object } | { ok: false, reason: string }}
 */
function translateQuestion(q, answers = {}) {
  if (!q || typeof q !== 'object') return { ok: false, reason: 'empty question' };
  const type = q.type || 'input';
  if (!SUPPORTED_TYPES.has(type)) return { ok: false, reason: `unsupported type: ${type}` };
  for (const key of UNSUPPORTED_KEYS) {
    if (q[key] != null) return { ok: false, reason: `unsupported feature: ${key}` };
  }

  const name = q.name || 'value';
  const label = String(_resolve(q.message, answers) ?? name);
  const validate = typeof q.validate === 'function' ? q.validate : null;

  if (type === 'confirm') {
    const def = q.default !== false; // inquirer confirm defaults to true
    return {
      ok: true,
      field: {
        name,
        label,
        type: 'select',
        // 是 first when default-yes so Enter keeps the inquirer default.
        choices: def
          ? [{ name: '是', value: true }, { name: '否', value: false }]
          : [{ name: '否', value: false }, { name: '是', value: true }],
        __coerce: 'boolean',
      },
    };
  }

  if (type === 'list' || type === 'checkbox') {
    const rawChoices = _resolve(q.choices, answers);
    if (!Array.isArray(rawChoices)) return { ok: false, reason: 'choices not resolvable to an array' };
    const choices = rawChoices.map(_normalizeChoice).filter(Boolean);
    if (choices.length === 0) return { ok: false, reason: 'no renderable choices' };
    const field = { name, label, type: 'select', choices };
    if (type === 'checkbox') field.multi = true;
    if (q.default != null) field.defaultValue = q.default;
    return { ok: true, field };
  }

  // input / password / number
  const field = { name, label, type: type === 'password' ? 'password' : 'input' };
  if (type === 'password' && q.mask) field.mask = q.mask;
  const def = _resolve(q.default, answers);
  if (def != null) field.defaultValue = def;
  if (type === 'number') {
    field.validate = (v, a) => {
      if (String(v).trim() === '') return validate ? validate(v, a) : '请输入数字';
      if (Number.isNaN(Number(v))) return '请输入有效数字';
      return validate ? validate(Number(v), a) : true;
    };
    field.__coerce = 'number';
  } else if (validate) {
    field.validate = validate;
  }
  return { ok: true, field };
}

/**
 * Translate a whole inquirer question array into a single FormFlow spec.
 * All-or-nothing: if ANY question is unsupported the batch is rejected so the
 * caller falls back to real inquirer (a partial native form would silently lose
 * the unsupported question). Pure; unit-testable without React.
 *
 * @returns {{ ok: true, spec: { title?: string, fields: object[] }, coerce: object }
 *          | { ok: false, reason: string }}
 */
function inquirerToFormSpec(questions) {
  const list = Array.isArray(questions) ? questions : [questions];
  if (list.length === 0) return { ok: false, reason: 'no questions' };
  const fields = [];
  const coerce = {}; // name → 'boolean' | 'number', applied after collection
  for (const q of list) {
    const t = translateQuestion(q, {});
    if (!t.ok) return { ok: false, reason: t.reason };
    if (t.field.__coerce) {
      coerce[t.field.name] = t.field.__coerce;
      delete t.field.__coerce;
    }
    fields.push(t.field);
  }
  // A single question with a message but no shared title reads better with the
  // message as the field label only; a multi-step batch gets no synthetic title.
  return { ok: true, spec: { fields }, coerce };
}

// Coerce collected raw FormFlow answers back to the types inquirer would have
// produced (confirm→boolean, number→Number), leaving everything else untouched.
function _applyCoercion(answers, coerce) {
  if (!answers || !coerce) return answers;
  const out = { ...answers };
  for (const [name, kind] of Object.entries(coerce)) {
    if (!(name in out)) continue;
    if (kind === 'boolean') out[name] = !!out[name];
    else if (kind === 'number') out[name] = Number(out[name]);
  }
  return out;
}

/**
 * inquirer-compatible prompt. Drop-in for `inquirer.prompt(questions)`.
 *
 * When the Ink TUI is active AND every question is FormFlow-translatable, the
 * questions are collected through the native overlay and returned as the same
 * `{ [name]: value }` answer map inquirer yields. Otherwise (no TUI, or any
 * unsupported feature) the real inquirer is invoked, so classic-REPL behaviour
 * is byte-for-byte unchanged.
 *
 * A native cancel (Esc) resolves to `{}` — the same shape inquirer yields when
 * a `when:false` skips everything — so callers see "no answers" rather than a
 * throw. Handlers already treat an empty/absent answer as a cancel.
 *
 * @param {Array|object} questions inquirer question(s)
 * @returns {Promise<object>} answers map
 */
async function promptCompat(questions) {
  if (isTuiActive()) {
    const t = inquirerToFormSpec(questions);
    if (t.ok) {
      const answers = await _askForm(t.spec);
      if (answers == null) return {}; // Esc/cancel → empty answers (caller treats as cancel)
      return _applyCoercion(answers, t.coerce);
    }
    // Fall through to inquirer on any untranslatable question.
  }
  // Classic path: real inquirer (also the only path when Ink is not mounted).
  const inquirer = require('inquirer');
  return inquirer.prompt(questions);
}

module.exports = {
  register,
  unregister,
  isTuiActive,
  promptCompat,
  // Exported for unit tests (pure, no React/inquirer):
  translateQuestion,
  inquirerToFormSpec,
};
