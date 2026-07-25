'use strict';

/**
 * FormFlow — native Ink sequential-form overlay.
 *
 * A small reusable multi-step prompt that collects a series of typed/selected
 * answers without ever touching inquirer or readline. inquirer cannot coexist
 * with ink's managed raw-mode input (it fights ink for stdin and the alternate
 * frame), which is why inquirer-driven handlers — `/login`, `/register`,
 * `/passwd`, … — exited the whole TUI the moment they ran. This component owns
 * its own keystrokes via ink's useInput (the same self-contained pattern as
 * QuestionPrompt / ModelPicker), so no other input handler competes while it is
 * mounted (App.js yields its top-level useInput while a form is open).
 *
 * Props:
 *   fields    — ordered field specs. Each:
 *     { name, label, type?, mask?, defaultValue?, choices?, validate?, multi? }
 *       type:        'input' (default) | 'password' | 'select'
 *       mask:        masking char for 'password' (default '*')
 *       choices:     [{ name, value }] — required for 'select'
 *       multi:       'select' only — multi-select (checkbox). Space toggles,
 *                    Enter commits the array of selected values.
 *       validate:    (value, answersSoFar) => true | string(errorMessage)
 *   title     — heading shown above the field.
 *   onResolve — (answers | null) => void. Called with the collected
 *               { [name]: value } map on completion, or null on Esc/cancel.
 *
 * Navigation: text fields accept printable input + Backspace; Enter validates
 * and advances. Single-select uses ↑/↓ (and 1-9) + Enter. Multi-select uses
 * ↑/↓ to move, Space (or 1-9) to toggle, Enter to commit. Esc cancels the whole
 * form at any step. Already-answered fields are shown above the active one
 * (password values masked).
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

const MARKER = '❯';

function FormFlow({ fields = [], title, onResolve }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const list = Array.isArray(fields) ? fields.filter(Boolean) : [];

  const [stepIdx, setStepIdx] = React.useState(0);
  const [value, setValue] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const [checked, setChecked] = React.useState(() => new Set());
  const [error, setError] = React.useState('');
  const answersRef = React.useRef({});

  const field = list[stepIdx] || null;
  const type = field ? (field.type || 'input') : 'input';
  const isSelect = type === 'select';
  const isMulti = isSelect && !!field.multi;
  const isPassword = type === 'password';
  const choices = (field && Array.isArray(field.choices)) ? field.choices : [];

  // Nothing to collect → resolve immediately so the caller is not left hanging.
  React.useEffect(() => {
    if (list.length === 0) onResolve({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  // Reset the transient editing state whenever we move to a new field, seeding
  // text fields with any default value and multi-select with its default set.
  React.useEffect(() => {
    if (!field) return;
    setValue(field.defaultValue != null ? String(field.defaultValue) : '');
    setCursor(0);
    setError('');
    if ((field.type || 'input') === 'select' && field.multi) {
      const def = Array.isArray(field.defaultValue) ? field.defaultValue : [];
      setChecked(new Set(def));
    } else {
      setChecked(new Set());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIdx]);

  const finish = (answers) => onResolve(answers);
  const cancel = () => onResolve(null);

  const commit = (rawValue) => {
    if (!field) return;
    const validate = typeof field.validate === 'function' ? field.validate : null;
    if (validate) {
      const verdict = validate(rawValue, answersRef.current);
      if (verdict !== true) {
        setError(typeof verdict === 'string' ? verdict : '输入无效');
        return;
      }
    }
    answersRef.current[field.name] = rawValue;
    if (stepIdx + 1 < list.length) {
      setStepIdx(stepIdx + 1);
    } else {
      finish({ ...answersRef.current });
    }
  };

  const moveCursor = (dir) => {
    if (choices.length === 0) return;
    setCursor((c) => (c + dir + choices.length) % choices.length);
  };

  useInput((ch, key) => {
    if (!field) return;
    if (key.escape) { cancel(); return; }

    if (isSelect) {
      if (key.upArrow) { moveCursor(-1); return; }
      if (key.downArrow || key.tab) { moveCursor(1); return; }
      // 全角(CJK IME)数字/空格折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
      const _fw = require('../../fullWidthInput');
      const navCh = _fw.foldDigits(ch, process.env);
      if (isMulti) {
        // Space (or a digit) toggles the row under the cursor; Enter commits the
        // collected value array (inquirer checkbox semantics).
        const toggle = (idx) => {
          if (idx < 0 || idx >= choices.length) return;
          setChecked((cur) => {
            const next = new Set(cur);
            const v = choices[idx].value;
            if (next.has(v)) next.delete(v); else next.add(v);
            return next;
          });
        };
        if (_fw.foldSpace(ch, process.env) === ' ') { toggle(cursor); return; }
        if (navCh && navCh >= '1' && navCh <= '9') { toggle(parseInt(navCh, 10) - 1); return; }
        if (key.return) {
          // Preserve choice order in the committed array.
          commit(choices.filter((c) => checked.has(c.value)).map((c) => c.value));
          return;
        }
        return;
      }
      if (navCh && navCh >= '1' && navCh <= '9') {
        const idx = parseInt(navCh, 10) - 1;
        if (idx >= 0 && idx < choices.length) commit(choices[idx].value);
        return;
      }
      if (key.return) {
        const picked = choices[cursor];
        if (picked) commit(picked.value);
        return;
      }
      return;
    }

    // Text / password field editing.
    if (key.return) { commit(value); return; }
    if (key.backspace || key.delete) { setValue((v) => v.slice(0, -1)); return; }
    if (ch && !key.ctrl && !key.meta) { setValue((v) => v + ch); }
  });

  if (!field) return null;

  // Recap of already-answered fields (passwords masked).
  const recap = [];
  for (let i = 0; i < stepIdx; i++) {
    const f = list[i];
    const ans = answersRef.current[f.name];
    let shown;
    if ((f.type || 'input') === 'password') {
      shown = '*'.repeat(String(ans || '').length);
    } else if ((f.type || 'input') === 'select' && f.multi) {
      const arr = Array.isArray(ans) ? ans : [];
      const names = arr.map((v) => {
        const c = (f.choices || []).find((ch) => ch.value === v);
        return c ? c.name : String(v);
      });
      shown = names.length ? names.join(', ') : '（无）';
    } else if ((f.type || 'input') === 'select') {
      const picked = (f.choices || []).find((c) => c.value === ans);
      shown = picked ? picked.name : String(ans);
    } else {
      shown = String(ans);
    }
    recap.push(h(Text, { key: `recap-${i}`, dimColor: true }, `   ✓ ${f.label} ${shown}`));
  }

  // Active field body.
  let body;
  if (isSelect) {
    const rows = choices.map((c, i) => {
      const active = i === cursor;
      const box = isMulti ? (checked.has(c.value) ? '[x] ' : '[ ] ') : '';
      return h(Text, { key: `c-${i}`, color: active ? 'cyan' : undefined, bold: active },
        `   ${active ? MARKER : ' '} ${box}${i + 1}. ${c.name}`);
    });
    body = h(Box, { flexDirection: 'column' }, rows);
  } else {
    const shown = isPassword ? '*'.repeat(value.length) : value;
    body = h(Text, { color: 'cyan' }, `   ${MARKER} ${shown}█`);
  }

  let footer;
  if (isMulti) footer = 'Space 选中/取消 · ↑/↓ 导航 · 数字键切换 · Enter 提交 · Esc 取消';
  else if (isSelect) footer = 'Enter 选择 · ↑/↓ 导航 · 数字键快选 · Esc 取消';
  else footer = 'Enter 确认 · Backspace 删除 · Esc 取消';

  const progress = list.length > 1 ? `（${stepIdx + 1}/${list.length}）` : '';

  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    title ? h(Text, { color: 'cyan', bold: true }, `${title} ${progress}`) : null,
    recap.length ? h(Box, { flexDirection: 'column' }, recap) : null,
    h(Text, { color: 'yellow', bold: true }, `? ${field.label}`),
    body,
    error ? h(Text, { color: 'red' }, `   ✗ ${error}`) : null,
    h(Text, { dimColor: true }, `  ${footer}`)
  );
}

module.exports = FormFlow;
