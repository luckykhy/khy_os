'use strict';

/**
 * QuestionPrompt — interactive single/multi/multi-card selection overlay.
 *
 * Renders an AskUserQuestion control request (subtype `can_use_tool`,
 * tool_name `AskUserQuestion`) as a navigable menu, aligned with Claude Code's
 * AskUserQuestion tool specification, and extended to「体察人的惰性」:
 *
 * - **多张选项卡(可左右切换)**: when there are 2-4 questions, ←/→ moves between
 *   cards freely (no forced sequential commit); each card keeps its own
 *   selection state, so going back and forth never loses what was picked.
 * - **卡内上下多选 + 一个「可讨论」选项**: every card deterministically grows a
 *   「可讨论」row (user's "let's discuss this / you decide" escape) and a free-text
 *   "Other" row — present even if the model forgot to include them.
 * - Single-select and multi-select modes, header labels, side-by-side preview.
 *
 * It owns its own keystrokes via ink's useInput. App.js routes question
 * requests here (returning early from its own useInput) and mounts this only
 * while a question is pending, so there is no competing input handler.
 *
 * The `request` prop is the INNER gateway request: { subtype, tool_name,
 * input: { questions: [{ question, header, options, multiSelect }] } }. On completion
 * it resolves with an SDK payload that normalizeControlResponse accepts:
 *   allow → { behavior:'allow', updatedInput:{ ...input, answers } }
 *   cancel → { behavior:'deny', message:'User declined to answer questions' }
 * `answers` is keyed by question text; multi-select values are joined with
 * ", " — identical to the legacy behavior repl.js handleControlRequest expects.
 *
 * All deterministic row/answer logic lives in the pure `questionCardModel`
 * single source (unit-tested without rendering ink); this file stays thin.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
const model = require('./questionCardModel');
const { Cursor } = require('../utils/Cursor');

const {
  DISCUSS_LABEL,
  DISCUSS_HINT,
  OTHER_LABEL,
  optLabel,
  optDesc,
  optPreview,
  rowLayout,
  wrapIndex,
  nextCard,
  prevCard,
  moveCursor,
  rowKind,
  multiSelection,
  singleSelection,
  collectAllAnswers,
  effectiveMulti,
  questionTextCursorEnabled,
  questionMultipickEnabled,
} = model;

const MARKER = '❯'; // ❯

function QuestionPrompt({ request, onResolve }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const input = (request && request.input) || {};
  const questions = Array.isArray(input.questions) ? input.questions.slice(0, 4) : [];
  const cardCount = questions.length;

  const [qIdx, setQIdx] = React.useState(0);
  // Per-card persistent state — left/right switching never loses a card's picks.
  const [cursors, setCursors] = React.useState(() => questions.map(() => 0));
  const [checkedSets, setCheckedSets] = React.useState(() => questions.map(() => new Set()));
  const [discussChecked, setDiscussChecked] = React.useState(() => questions.map(() => false));
  const [otherVals, setOtherVals] = React.useState(() => questions.map(() => ''));
  const [typing, setTyping] = React.useState(false);
  // Fix 2 — 自由输入用不可变 Cursor(文本 + caret offset),支持左右移动。读者用 .text。
  const [typedCursor, setTypedCursor] = React.useState(() => new Cursor('', 0));
  // Fix 3 — 每张卡是否被用户按 Space 临时提升为多选(与模型声明的 multiSelect 独立叠加)。
  const [promotedMulti, setPromotedMulti] = React.useState(() => questions.map(() => false));

  const q = questions[qIdx] || null;
  const qText = q ? (String(q.question || '').trim() || 'Please choose an option') : '';
  const qHeader = q ? (String(q.header || '').trim().slice(0, 12) || '') : '';
  const options = q && Array.isArray(q.options) ? q.options : [];
  const rawMulti = !!(q && q.multiSelect);
  const multi = effectiveMulti({ multiSelect: rawMulti, promoted: !!promotedMulti[qIdx], env: process.env });
  const hasPreview = options.some((opt) => optPreview(opt));
  const { discussRow, otherRow, rowCount } = rowLayout(options.length);

  const cursor = wrapIndex(cursors[qIdx] || 0, rowCount);
  const checked = checkedSets[qIdx] instanceof Set ? checkedSets[qIdx] : new Set();
  const discussOn = !!discussChecked[qIdx];
  const otherValue = otherVals[qIdx] || '';

  // Guard: nothing to ask → decline so the loop/gateway is not left hanging.
  React.useEffect(() => {
    if (!q) onResolve({ behavior: 'deny', message: 'User declined to answer questions' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const setCursorAt = (i, v) => setCursors((prev) => { const n = prev.slice(); n[i] = v; return n; });
  const setOtherAt = (i, v) => setOtherVals((prev) => { const n = prev.slice(); n[i] = v; return n; });
  const setDiscussAt = (i, v) => setDiscussChecked((prev) => { const n = prev.slice(); n[i] = v; return n; });
  const setPromotedAt = (i, v) => setPromotedMulti((prev) => { const n = prev.slice(); n[i] = v; return n; });
  const toggleCheckedAt = (i, idx) => setCheckedSets((prev) => {
    const n = prev.slice();
    const s = new Set(n[i] instanceof Set ? n[i] : []);
    if (s.has(idx)) s.delete(idx); else s.add(idx);
    n[i] = s;
    return n;
  });

  const cancel = () => onResolve({ behavior: 'deny', message: 'User declined to answer questions' });

  // Resolve with every card's answer. `collectAllAnswers` reads each card's
  // persistent state; we overlay the just-committed active card to dodge the
  // setState-not-yet-applied staleness of the triggering keypress's closure.
  const submitWith = (overrideAnswer) => {
    const base = collectAllAnswers(questions, { cursors, checkedSets, discussChecked, otherVals, promotedMulti }, process.env);
    if (overrideAnswer != null && qText) base[qText] = overrideAnswer;
    onResolve({ behavior: 'allow', updatedInput: { ...input, answers: base } });
  };

  // Commit the active card's answer, then advance to the next card or submit.
  const commitCardAnswer = (answerString) => {
    if (qIdx + 1 < cardCount) setQIdx(qIdx + 1);
    else submitWith(answerString);
  };

  const commitOther = () => {
    const value = typedCursor.text.trim();
    setTyping(false);
    setTypedCursor(new Cursor('', 0));
    if (!value) return;
    setOtherAt(qIdx, value);
    if (multi) {
      commitCardAnswer(multiSelection({ options, checked, discussChecked: discussOn, otherValue: value }).join(', '));
    } else {
      commitCardAnswer(value);
    }
  };

  useInput((ch, key) => {
    if (!q) return;

    // Free-text "Other" capture mode.
    if (typing) {
      if (key.escape) { setTyping(false); setTypedCursor(new Cursor('', 0)); return; }
      if (key.return) { commitOther(); return; }
      // Fix 2 — 门控开:全套光标移动/插入/删除;关:逐字节 legacy(行尾追加/退格,方向键吞掉)。
      if (questionTextCursorEnabled(process.env)) {
        if (key.leftArrow) { setTypedCursor((c) => c.left()); return; }
        if (key.rightArrow) { setTypedCursor((c) => c.right()); return; }
        if (key.upArrow || (key.ctrl && ch === 'a')) { setTypedCursor((c) => c.startOfLine()); return; }
        if (key.downArrow || (key.ctrl && ch === 'e')) { setTypedCursor((c) => c.endOfLine()); return; }
        if (key.backspace) { setTypedCursor((c) => c.backspace()); return; }
        if (key.delete) { setTypedCursor((c) => c.del()); return; }
        if (ch && !key.ctrl && !key.meta) { setTypedCursor((c) => c.insert(ch)); return; }
        return;
      }
      // Legacy(门控关):追加到尾 / 尾部退格,方向键无 ch → no-op(与今日逐字节一致)。
      if (key.backspace || key.delete) { setTypedCursor((c) => new Cursor(c.text.slice(0, -1), Math.max(0, c.text.length - 1))); return; }
      if (ch && !key.ctrl && !key.meta) { setTypedCursor((c) => new Cursor(c.text + ch, c.text.length + ch.length)); return; }
      return;
    }

    if (key.escape) { cancel(); return; }

    // 多张选项卡:←/→ 自由切换,不强制顺序提交;每张卡状态独立持久。
    if (cardCount > 1 && key.leftArrow) { setQIdx(prevCard(qIdx, cardCount)); return; }
    if (cardCount > 1 && key.rightArrow) { setQIdx(nextCard(qIdx, cardCount)); return; }

    // 卡内上下选择(环绕)。
    if (key.upArrow) { setCursorAt(qIdx, moveCursor(cursor, -1, rowCount)); return; }
    if (key.downArrow || key.tab) { setCursorAt(qIdx, moveCursor(cursor, +1, rowCount)); return; }

    // Number keys jump to a row; single-select commits, multi toggles.
    // 全角(CJK IME)数字折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
    const _fw = require('../../fullWidthInput');
    const navCh = _fw.foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9') {
      const idx = parseInt(navCh, 10) - 1;
      if (idx >= 0 && idx < rowCount) {
        setCursorAt(qIdx, idx);
        const kind = rowKind(idx, options.length);
        if (kind === 'other') { setTyping(true); setTypedCursor(new Cursor(otherValue, otherValue.length)); return; }
        if (multi) {
          if (kind === 'discuss') setDiscussAt(qIdx, !discussOn);
          else toggleCheckedAt(qIdx, idx);
          return;
        }
        commitCardAnswer(kind === 'discuss' ? DISCUSS_LABEL : optLabel(options[idx]));
      }
      return;
    }

    // Space:多选卡切换;单选卡(门控开)→ 临时提升为多选并勾当前行(Fix 3);
    // 门控关且非多选 → no-op(=legacy 单选 Space 无效,逐字节一致)。全角空格折半角后判定。
    if (_fw.foldSpace(ch, process.env) === ' ') {
      const kind = rowKind(cursor, options.length);
      if (kind === 'other') { setTyping(true); setTypedCursor(new Cursor(otherValue, otherValue.length)); return; }
      if (multi) {
        if (kind === 'discuss') setDiscussAt(qIdx, !discussOn);
        else toggleCheckedAt(qIdx, cursor);
        return;
      }
      // 单选卡首次 Space:提升为多选(用户显式动作;不静默改变单选语义),并勾当前行。
      if (questionMultipickEnabled(process.env) && !rawMulti && !promotedMulti[qIdx]) {
        setPromotedAt(qIdx, true);
        if (kind === 'discuss') setDiscussAt(qIdx, !discussOn);
        else toggleCheckedAt(qIdx, cursor);
        return;
      }
      return; // 门控关 → no-op(legacy)
    }

    if (key.return) {
      const kind = rowKind(cursor, options.length);
      if (kind === 'other') { setTyping(true); setTypedCursor(new Cursor(otherValue, otherValue.length)); return; }
      if (multi) {
        // 惰性回退:一项未选时,multiSelection 自动落「可讨论」,不强求用户必须选。
        commitCardAnswer(multiSelection({ options, checked, discussChecked: discussOn, otherValue }).join(', '));
      } else {
        commitCardAnswer(singleSelection({ options, cursor, otherValue }));
      }
    }
  });

  if (!q) return null;

  // Build rows: real options → 「可讨论」 → 「Other」.
  const rows = [];
  for (let i = 0; i < options.length; i++) {
    const active = i === cursor;
    const marker = active ? MARKER : ' ';
    const box = multi ? (checked.has(i) ? '[x] ' : '[ ] ') : '';
    const desc = optDesc(options[i]);
    rows.push(
      h(Text, { key: `opt-${i}`, color: active ? 'cyan' : undefined, bold: active },
        `   ${marker} ${i + 1}. ${box}${optLabel(options[i])}${desc ? `  — ${desc}` : ''}`)
    );
  }
  // 「可讨论」row — always present; a deliberate "let's discuss / you decide" escape.
  const discussActive = cursor === discussRow;
  const discussBox = multi ? (discussOn ? '[x] ' : '[ ] ') : '';
  rows.push(
    h(Text, { key: 'opt-discuss', color: discussActive ? 'cyan' : 'magenta', bold: discussActive },
      `   ${discussActive ? MARKER : ' '} ${discussRow + 1}. ${discussBox}${DISCUSS_LABEL}  — ${DISCUSS_HINT}`)
  );
  // "Other (free input)" row.
  const otherActive = cursor === otherRow;
  rows.push(
    h(Text, { key: 'opt-other', color: otherActive ? 'cyan' : undefined, bold: otherActive, dimColor: !otherActive },
      `   ${otherActive ? MARKER : ' '} ${otherRow + 1}. ${OTHER_LABEL}${otherValue ? `: ${otherValue}` : ''}`)
  );

  const navHint = cardCount > 1 ? '←/→ 切换卡片 · ' : '';
  // Fix 3 — 单选卡(未提升、门控开)提示可按 Space 转多选。
  const multipickHint = (!multi && !rawMulti && questionMultipickEnabled(process.env)) ? 'Space 可多选 · ' : '';
  const footer = multi
    ? `Enter 确认本卡 · Space 多选 · ↑/↓ 导航 · ${navHint}数字键选择 · Esc 取消`
    : `Enter 选择 · ${multipickHint}↑/↓ 导航 · ${navHint}数字键选择 · Esc 取消`;

  // Fix 2 — 自由输入行渲染:门控开显示内部反色 caret(before + 反色当前字 + after),
  // 门控关逐字节 legacy `✎ <text>█`(offset 恒在尾,与今日一致)。
  const renderTyping = () => {
    if (!typing) return null;
    const t = typedCursor.text;
    if (!questionTextCursorEnabled(process.env)) {
      return h(Text, { color: 'cyan' }, `  ✎ ${t}█`);
    }
    const off = typedCursor.offset;
    const before = t.slice(0, off);
    const cursorChar = off < t.length ? t[off] : ' ';
    const after = off < t.length ? t.slice(off + 1) : '';
    return h(Text, { color: 'cyan' }, '  ✎ ',
      h(Text, null, before),
      h(Text, { inverse: true }, cursorChar),
      h(Text, null, after));
  };

  // Build question header with chip/tag if present.
  const headerLine = qHeader
    ? h(Text, null,
        h(Text, { color: 'cyan', bold: true, inverse: true }, ` ${qHeader} `),
        ' ',
        h(Text, { color: 'yellow', bold: true }, qText)
      )
    : h(Text, { color: 'yellow', bold: true }, `? ${qText}`);

  const progressLine = cardCount > 1
    ? h(Text, { dimColor: true }, `选项卡 ${qIdx + 1}/${cardCount}（←/→ 可左右切换）`)
    : null;

  // Side-by-side layout when any option has preview (single-select only).
  if (hasPreview && !multi && cursor < options.length) {
    const preview = optPreview(options[cursor]);
    const leftPanel = h(Box, { flexDirection: 'column', width: '50%', marginRight: 2 },
      progressLine,
      headerLine,
      h(Box, { flexDirection: 'column' }, rows),
      renderTyping(),
      h(Text, { dimColor: true }, `  ${footer}`)
    );
    const rightPanel = preview
      ? h(Box, { flexDirection: 'column', width: '50%', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
          h(Text, { dimColor: true }, 'Preview:'),
          h(Text, null, preview)
        )
      : null;
    return h(Box, { flexDirection: 'row', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
      leftPanel,
      rightPanel
    );
  }

  // Standard vertical layout (no preview or multi-select).
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
    progressLine,
    headerLine,
    h(Box, { flexDirection: 'column' }, rows),
    renderTyping(),
    h(Text, { dimColor: true }, `  ${footer}`)
  );
}

module.exports = QuestionPrompt;
