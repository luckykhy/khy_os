'use strict';

/**
 * Vim operator functions (delete / change / yank, x, r, ~, J, p/P, >>, o/O, …).
 * Ported from Claude Code's src/vim/operators.ts; CC's Cursor/intl/stringUtils
 * deps are replaced by the local VimCursor adapter and its grapheme helpers.
 *
 * OperatorContext (built by useVimInput) supplies:
 *   { cursor, text, setText, setOffset, enterInsert, getRegister, setRegister,
 *     getLastFind, setLastFind, recordChange }
 */
const { VimCursor, firstGrapheme, lastGrapheme, countCharInString } = require('./cursor');
const { isInclusiveMotion, isLinewiseMotion, resolveMotion } = require('./motions');
const { findTextObject } = require('./textObjects');

// ── Paste blow-up guard (p / P) ────────────────────────────────────
//
// The vim count prefix is capped at MAX_VIM_COUNT (10000, types.js), but the
// paste register is raw pasted human text — unbounded. `content.repeat(count)`
// (charwise) or the `count × contentLines` push loop (linewise) multiplies the
// two: a single ~54 KB paste yanked then `10000p` builds a 540 M-char string →
// `RangeError: Invalid string length`, and the dispatch in useVimInput
// (result.execute()) has no try/catch, so that RangeError tears down the Ink
// render loop = TUI crash. The linewise branch instead freezes the event loop
// (10000 × 5000 lines = 5·10⁷ pushes, multi-second) then OOMs on join.
//
// MAX_PASTE_OUTPUT bounds the *product* (total chars charwise / total lines
// linewise). It sits far above any realistic interactive paste-repeat yet well
// below V8's ~536 M string limit and the multi-second freeze zone, so normal
// pastes are byte-identical. Gated by KHY_VIM_PASTE_CAP (default on); off →
// legacy unbounded multiply.
const _PASTE_CAP_OFF = ['0', 'false', 'off', 'no'];
const MAX_PASTE_OUTPUT = 10_000_000;
function _pasteCapEnabled() {
  return !_PASTE_CAP_OFF.includes(
    String((process.env && process.env.KHY_VIM_PASTE_CAP) || '').trim().toLowerCase());
}
// Largest repeat count that keeps `unit * count` within MAX_PASTE_OUTPUT
// (always ≥ 1 so a single paste is never suppressed). `unit` is the per-repeat
// cost: content.length charwise, contentLines.length linewise.
function _clampPasteCount(count, unit) {
  if (!_pasteCapEnabled()) return count;
  if (!Number.isFinite(count) || count <= 1 || !unit) return count;
  if (unit * count <= MAX_PASTE_OUTPUT) return count;
  return Math.max(1, Math.floor(MAX_PASTE_OUTPUT / unit));
}

function executeOperatorMotion(op, motion, count, ctx) {
  const target = resolveMotion(motion, ctx.cursor, count);
  if (target.equals(ctx.cursor)) return;

  const range = getOperatorRange(ctx.cursor, target, motion, op, count);
  applyOperator(op, range.from, range.to, ctx, range.linewise);
  ctx.recordChange({ type: 'operator', op, motion, count });
}

function executeOperatorFind(op, findType, char, count, ctx) {
  const targetOffset = ctx.cursor.findCharacter(char, findType, count);
  if (targetOffset === null) return;

  const target = new VimCursor(ctx.cursor.text, targetOffset);
  const range = getOperatorRangeForFind(ctx.cursor, target, findType);

  applyOperator(op, range.from, range.to, ctx);
  ctx.setLastFind(findType, char);
  ctx.recordChange({ type: 'operatorFind', op, find: findType, char, count });
}

function executeOperatorTextObj(op, scope, objType, count, ctx) {
  const range = findTextObject(ctx.text, ctx.cursor.offset, objType, scope === 'inner');
  if (!range) return;

  applyOperator(op, range.start, range.end, ctx);
  ctx.recordChange({ type: 'operatorTextObj', op, objType, scope, count });
}

function executeLineOp(op, count, ctx) {
  const text = ctx.text;
  const lines = text.split('\n');
  const currentLine = countCharInString(text.slice(0, ctx.cursor.offset), '\n');
  const linesToAffect = Math.min(count, lines.length - currentLine);
  const lineStart = ctx.cursor.startOfLogicalLine().offset;
  let lineEnd = lineStart;
  for (let i = 0; i < linesToAffect; i++) {
    const nextNewline = text.indexOf('\n', lineEnd);
    lineEnd = nextNewline === -1 ? text.length : nextNewline + 1;
  }

  let content = text.slice(lineStart, lineEnd);
  if (!content.endsWith('\n')) content = content + '\n';
  ctx.setRegister(content, true);

  if (op === 'yank') {
    ctx.setOffset(lineStart);
  } else if (op === 'delete') {
    let deleteStart = lineStart;
    const deleteEnd = lineEnd;
    if (deleteEnd === text.length && deleteStart > 0 && text[deleteStart - 1] === '\n') {
      deleteStart -= 1;
    }
    const newText = text.slice(0, deleteStart) + text.slice(deleteEnd);
    ctx.setText(newText || '');
    const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1));
    ctx.setOffset(Math.min(deleteStart, maxOff));
  } else if (op === 'change') {
    if (lines.length === 1) {
      ctx.setText('');
      ctx.enterInsert(0);
    } else {
      const beforeLines = lines.slice(0, currentLine);
      const afterLines = lines.slice(currentLine + linesToAffect);
      const newText = [...beforeLines, '', ...afterLines].join('\n');
      ctx.setText(newText);
      ctx.enterInsert(lineStart);
    }
  }

  ctx.recordChange({ type: 'operator', op, motion: op[0], count });
}

function executeX(count, ctx) {
  const from = ctx.cursor.offset;
  if (from >= ctx.text.length) return;

  let endCursor = ctx.cursor;
  for (let i = 0; i < count && !endCursor.isAtEnd(); i++) {
    endCursor = endCursor.right();
  }
  const to = endCursor.offset;

  const deleted = ctx.text.slice(from, to);
  const newText = ctx.text.slice(0, from) + ctx.text.slice(to);

  ctx.setRegister(deleted, false);
  ctx.setText(newText);
  const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1));
  ctx.setOffset(Math.min(from, maxOff));
  ctx.recordChange({ type: 'x', count });
}

function executeReplace(char, count, ctx) {
  let offset = ctx.cursor.offset;
  let newText = ctx.text;

  for (let i = 0; i < count && offset < newText.length; i++) {
    const graphemeLen = firstGrapheme(newText.slice(offset)).length || 1;
    newText = newText.slice(0, offset) + char + newText.slice(offset + graphemeLen);
    offset += char.length;
  }

  ctx.setText(newText);
  ctx.setOffset(Math.max(0, offset - char.length));
  ctx.recordChange({ type: 'replace', char, count });
}

function executeToggleCase(count, ctx) {
  const startOffset = ctx.cursor.offset;
  if (startOffset >= ctx.text.length) return;

  let newText = ctx.text;
  let offset = startOffset;
  let toggled = 0;

  while (offset < newText.length && toggled < count) {
    const grapheme = firstGrapheme(newText.slice(offset));
    const graphemeLen = grapheme.length;
    const toggledGrapheme = grapheme === grapheme.toUpperCase()
      ? grapheme.toLowerCase()
      : grapheme.toUpperCase();
    newText = newText.slice(0, offset) + toggledGrapheme + newText.slice(offset + graphemeLen);
    offset += toggledGrapheme.length;
    toggled++;
  }

  ctx.setText(newText);
  ctx.setOffset(offset);
  ctx.recordChange({ type: 'toggleCase', count });
}

function executeJoin(count, ctx) {
  const text = ctx.text;
  const lines = text.split('\n');
  const { line: currentLine } = ctx.cursor.getPosition();
  if (currentLine >= lines.length - 1) return;

  const linesToJoin = Math.min(count, lines.length - currentLine - 1);
  let joinedLine = lines[currentLine];
  const cursorPos = joinedLine.length;

  for (let i = 1; i <= linesToJoin; i++) {
    const nextLine = (lines[currentLine + i] || '').trimStart();
    if (nextLine.length > 0) {
      if (!joinedLine.endsWith(' ') && joinedLine.length > 0) joinedLine += ' ';
      joinedLine += nextLine;
    }
  }

  const newLines = [
    ...lines.slice(0, currentLine),
    joinedLine,
    ...lines.slice(currentLine + linesToJoin + 1),
  ];

  const newText = newLines.join('\n');
  ctx.setText(newText);
  ctx.setOffset(getLineStartOffset(newLines, currentLine) + cursorPos);
  ctx.recordChange({ type: 'join', count });
}

function executePaste(after, count, ctx) {
  const register = ctx.getRegister();
  if (!register) return;

  const isLinewise = register.endsWith('\n');
  const content = isLinewise ? register.slice(0, -1) : register;

  if (isLinewise) {
    const text = ctx.text;
    const lines = text.split('\n');
    const { line: currentLine } = ctx.cursor.getPosition();

    const insertLine = after ? currentLine + 1 : currentLine;
    const contentLines = content.split('\n');
    const safeCount = _clampPasteCount(count, contentLines.length);
    const repeatedLines = [];
    for (let i = 0; i < safeCount; i++) repeatedLines.push(...contentLines);

    const newLines = [
      ...lines.slice(0, insertLine),
      ...repeatedLines,
      ...lines.slice(insertLine),
    ];

    const newText = newLines.join('\n');
    ctx.setText(newText);
    ctx.setOffset(getLineStartOffset(newLines, insertLine));
  } else {
    const safeCount = _clampPasteCount(count, content.length);
    const textToInsert = content.repeat(safeCount);
    const insertPoint = after && ctx.cursor.offset < ctx.text.length
      ? ctx.cursor.measuredText.nextOffset(ctx.cursor.offset)
      : ctx.cursor.offset;

    const newText = ctx.text.slice(0, insertPoint) + textToInsert + ctx.text.slice(insertPoint);
    const lastGr = lastGrapheme(textToInsert);
    const newOffset = insertPoint + textToInsert.length - (lastGr.length || 1);

    ctx.setText(newText);
    ctx.setOffset(Math.max(insertPoint, newOffset));
  }
}

function executeIndent(dir, count, ctx) {
  const text = ctx.text;
  const lines = text.split('\n');
  const { line: currentLine } = ctx.cursor.getPosition();
  const linesToAffect = Math.min(count, lines.length - currentLine);
  const indent = '  ';

  for (let i = 0; i < linesToAffect; i++) {
    const lineIdx = currentLine + i;
    const line = lines[lineIdx] || '';
    if (dir === '>') {
      lines[lineIdx] = indent + line;
    } else if (line.startsWith(indent)) {
      lines[lineIdx] = line.slice(indent.length);
    } else if (line.startsWith('\t')) {
      lines[lineIdx] = line.slice(1);
    } else {
      let removed = 0;
      let idx = 0;
      while (idx < line.length && removed < indent.length && /\s/.test(line[idx])) {
        removed++;
        idx++;
      }
      lines[lineIdx] = line.slice(idx);
    }
  }

  const newText = lines.join('\n');
  const currentLineText = lines[currentLine] || '';
  const firstNonBlank = ((currentLineText.match(/^\s*/) || [''])[0]).length;

  ctx.setText(newText);
  ctx.setOffset(getLineStartOffset(lines, currentLine) + firstNonBlank);
  ctx.recordChange({ type: 'indent', dir, count });
}

function executeOpenLine(direction, ctx) {
  const text = ctx.text;
  const lines = text.split('\n');
  const { line: currentLine } = ctx.cursor.getPosition();

  const insertLine = direction === 'below' ? currentLine + 1 : currentLine;
  const newLines = [...lines.slice(0, insertLine), '', ...lines.slice(insertLine)];

  const newText = newLines.join('\n');
  ctx.setText(newText);
  ctx.enterInsert(getLineStartOffset(newLines, insertLine));
  ctx.recordChange({ type: 'openLine', direction });
}

// ── Internal helpers ────────────────────────────────────────────────────────
function getLineStartOffset(lines, lineIndex) {
  return lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
}

function getOperatorRange(cursor, target, motion, op, count) {
  let from = Math.min(cursor.offset, target.offset);
  let to = Math.max(cursor.offset, target.offset);
  let linewise = false;

  if (op === 'change' && (motion === 'w' || motion === 'W')) {
    // cw/cW changes to end of word, not start of next word.
    let wordCursor = cursor;
    for (let i = 0; i < count - 1; i++) {
      wordCursor = motion === 'w' ? wordCursor.nextVimWord() : wordCursor.nextWORD();
    }
    const wordEnd = motion === 'w' ? wordCursor.endOfVimWord() : wordCursor.endOfWORD();
    to = cursor.measuredText.nextOffset(wordEnd.offset);
  } else if (isLinewiseMotion(motion)) {
    linewise = true;
    const text = cursor.text;
    const nextNewline = text.indexOf('\n', to);
    if (nextNewline === -1) {
      to = text.length;
      if (from > 0 && text[from - 1] === '\n') from -= 1;
    } else {
      to = nextNewline + 1;
    }
  } else if (isInclusiveMotion(motion) && cursor.offset <= target.offset) {
    to = cursor.measuredText.nextOffset(to);
  }

  from = cursor.snapOutOfImageRef(from, 'start');
  to = cursor.snapOutOfImageRef(to, 'end');

  return { from, to, linewise };
}

function getOperatorRangeForFind(cursor, target /*, findType */) {
  const from = Math.min(cursor.offset, target.offset);
  const maxOffset = Math.max(cursor.offset, target.offset);
  const to = cursor.measuredText.nextOffset(maxOffset);
  return { from, to };
}

function applyOperator(op, from, to, ctx, linewise = false) {
  let content = ctx.text.slice(from, to);
  if (linewise && !content.endsWith('\n')) content = content + '\n';
  ctx.setRegister(content, linewise);

  if (op === 'yank') {
    ctx.setOffset(from);
  } else if (op === 'delete') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to);
    ctx.setText(newText);
    const maxOff = Math.max(0, newText.length - (lastGrapheme(newText).length || 1));
    ctx.setOffset(Math.min(from, maxOff));
  } else if (op === 'change') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to);
    ctx.setText(newText);
    ctx.enterInsert(from);
  }
}

function executeOperatorG(op, count, ctx) {
  const target = count === 1 ? ctx.cursor.startOfLastLine() : ctx.cursor.goToLine(count);
  if (target.equals(ctx.cursor)) return;
  const range = getOperatorRange(ctx.cursor, target, 'G', op, count);
  applyOperator(op, range.from, range.to, ctx, range.linewise);
  ctx.recordChange({ type: 'operator', op, motion: 'G', count });
}

function executeOperatorGg(op, count, ctx) {
  const target = count === 1 ? ctx.cursor.startOfFirstLine() : ctx.cursor.goToLine(count);
  if (target.equals(ctx.cursor)) return;
  const range = getOperatorRange(ctx.cursor, target, 'gg', op, count);
  applyOperator(op, range.from, range.to, ctx, range.linewise);
  ctx.recordChange({ type: 'operator', op, motion: 'gg', count });
}

module.exports = {
  executeOperatorMotion,
  executeOperatorFind,
  executeOperatorTextObj,
  executeLineOp,
  executeX,
  executeReplace,
  executeToggleCase,
  executeJoin,
  executePaste,
  executeIndent,
  executeOpenLine,
  executeOperatorG,
  executeOperatorGg,
  _pasteCapEnabled,
  _clampPasteCount,
  MAX_PASTE_OUTPUT,
};
