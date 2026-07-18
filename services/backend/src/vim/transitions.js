/**
 * Vim state machine transitions — routes keystrokes in NORMAL mode
 * through the CommandState phases, producing executable actions.
 */

const { Mode, CommandState, Operator, createCommandContext } = require('./types');
const { resolveMotion, firstNonBlank } = require('./motions');
const { resolveTextObject } = require('./textObjects');
const { executeOperator, executeStandalone } = require('./operators');

// ── Operator keys ──────────────────────────────────────────────────
const OPERATOR_KEYS = new Set(['d', 'c', 'y']);
const MOTION_KEYS = new Set(['h', 'l', 'w', 'b', 'e', 'W', 'B', 'E', '0', '^', '$']);
const FIND_KEYS = new Set(['f', 'F', 't', 'T']);
const REPEAT_FIND_KEYS = new Set([';', ',']);
const TEXT_OBJ_MODS = new Set(['i', 'a']);
const TEXT_OBJ_TYPES = new Set(['w', 'W', '"', "'", '`', '(', ')', '[', ']', '{', '}', '<', '>', 'b', 'B']);

// ── Count clamp (freeze guard) ─────────────────────────────────────
// A typed numeric prefix (e.g. "999999999w") flows into O(count) motion
// loops and O(count) paste/toggle string builders. Without a cap a user
// can freeze the single-threaded event loop from the keyboard. Mirror the
// TUI vim implementation's MAX_VIM_COUNT clamp (cli/tui/vim/types.js:53).
// Gated by KHY_VIM_COUNT_CLAMP (default on); disabling restores the
// unbounded legacy behavior byte-for-byte.
const MAX_VIM_COUNT = 10000;

function _vimCountClampEnabled() {
  return !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_VIM_COUNT_CLAMP || '').trim().toLowerCase());
}

function _clampCount(n) {
  if (!_vimCountClampEnabled()) return n;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= MAX_VIM_COUNT) return n;
  return MAX_VIM_COUNT;
}

// ── Helpers ────────────────────────────────────────────────────────

function getEffectiveCount(cmd) {
  const c1 = cmd.count || 1;
  const c2 = cmd.operatorCount || 1;
  return _clampCount(c1 * c2);
}

function isDigit(key) {
  return key >= '1' && key <= '9';
}

function isDigitOrZero(key) {
  return key >= '0' && key <= '9';
}

// ── Main transition function ───────────────────────────────────────

/**
 * Process a keystroke in NORMAL mode.
 *
 * @param {object} state - Full vim state { mode, cmd, persistent }
 * @param {string} key - The keystroke
 * @param {{ line: string, cursor: number }} ctx - Current line context
 * @returns {{
 *   state: object,         // Updated state
 *   result: { line: string, cursor: number, switchToInsert: boolean }|null,
 *   modeSwitch: string|null,  // 'INSERT' if should switch
 *   bell: boolean,         // True if invalid keystroke
 * }}
 */
function transition(state, key, ctx) {
  const { cmd, persistent } = state;
  const { line, cursor } = ctx;
  const noResult = { state, result: null, modeSwitch: null, bell: false };

  switch (cmd.phase) {
    // ── IDLE — waiting for first key ─────────────────────────────
    case CommandState.idle: {
      // Count prefix (1-9 starts count, 0 is a motion)
      if (isDigit(key)) {
        cmd.phase = CommandState.count;
        cmd.count = parseInt(key, 10);
        return noResult;
      }

      // Operator keys
      if (OPERATOR_KEYS.has(key)) {
        cmd.phase = CommandState.operator;
        cmd.operator = key;
        return noResult;
      }

      // Indent/dedent
      if (key === '>' || key === '<') {
        cmd.phase = CommandState.indent;
        cmd.operator = key;
        return noResult;
      }

      // Motion keys
      if (MOTION_KEYS.has(key)) {
        const motion = resolveMotion(key, line, cursor, 1, null, null, persistent.lastFind);
        if (motion) {
          const newCursor = key === 'b' || key === 'B' ? motion.start : motion.end;
          cmd.phase = CommandState.idle;
          return {
            state,
            result: { line, cursor: Math.max(0, Math.min(newCursor, Math.max(0, line.length - 1))), switchToInsert: false },
            modeSwitch: null,
            bell: false,
          };
        }
        return { ...noResult, bell: true };
      }

      // Find keys
      if (FIND_KEYS.has(key)) {
        cmd.phase = CommandState.find;
        cmd.findDirection = key;
        return noResult;
      }

      // Repeat find
      if (REPEAT_FIND_KEYS.has(key)) {
        if (!persistent.lastFind) return { ...noResult, bell: true };
        const motion = resolveMotion(key, line, cursor, 1, null, null, persistent.lastFind);
        if (motion) {
          const newCursor = motion.start <= cursor ? motion.start : motion.end;
          return {
            state,
            result: { line, cursor: Math.max(0, Math.min(newCursor, Math.max(0, line.length - 1))), switchToInsert: false },
            modeSwitch: null,
            bell: false,
          };
        }
        return { ...noResult, bell: true };
      }

      // g-prefix
      if (key === 'g') {
        cmd.phase = CommandState.g;
        return noResult;
      }

      // r — replace
      if (key === 'r') {
        cmd.phase = CommandState.replace;
        return noResult;
      }

      // Mode switch keys
      if (key === 'i') {
        return { state, result: null, modeSwitch: Mode.INSERT, bell: false };
      }
      if (key === 'I') {
        const pos = firstNonBlank(line);
        return {
          state,
          result: { line, cursor: pos, switchToInsert: true },
          modeSwitch: Mode.INSERT,
          bell: false,
        };
      }
      if (key === 'a') {
        const newCursor = Math.min(cursor + 1, line.length);
        return {
          state,
          result: { line, cursor: newCursor, switchToInsert: true },
          modeSwitch: Mode.INSERT,
          bell: false,
        };
      }
      if (key === 'A') {
        return {
          state,
          result: { line, cursor: line.length, switchToInsert: true },
          modeSwitch: Mode.INSERT,
          bell: false,
        };
      }
      if (key === 'o') {
        // In single-line mode, o appends newline-ish behavior: clear + insert
        return {
          state,
          result: { line, cursor: line.length, switchToInsert: true },
          modeSwitch: Mode.INSERT,
          bell: false,
        };
      }
      if (key === 'O') {
        return {
          state,
          result: { line, cursor: 0, switchToInsert: true },
          modeSwitch: Mode.INSERT,
          bell: false,
        };
      }

      // Standalone commands
      const standaloneKeys = new Set(['x', 'X', '~', 'p', 'P', 'D', 'C', 'Y', 's', 'S']);
      if (standaloneKeys.has(key)) {
        const result = executeStandalone(key, line, cursor, 1, persistent);
        if (result) {
          persistent.lastChange = { cmd: key, count: 1 };
          const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
          Object.assign(cmd, createCommandContext());
          return { state, result, modeSwitch, bell: false };
        }
        return { ...noResult, bell: true };
      }

      // Dot repeat
      if (key === '.') {
        if (persistent.lastChange) {
          // Re-execute last change — simplified: just replay the command
          const lc = persistent.lastChange;
          if (lc.cmd === 'dd' || lc.cmd === 'cc' || lc.cmd === 'yy' || lc.cmd === '>>' || lc.cmd === '<<') {
            const result = executeStandalone(lc.cmd, line, cursor, lc.count || 1, persistent);
            if (result) {
              const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
              return { state, result, modeSwitch, bell: false };
            }
          } else if (typeof lc.cmd === 'string' && lc.cmd.length === 1) {
            const result = executeStandalone(lc.cmd, line, cursor, lc.count || 1, persistent, lc.replaceChar);
            if (result) {
              const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
              return { state, result, modeSwitch, bell: false };
            }
          }
        }
        return { ...noResult, bell: true };
      }

      // u — undo (bell, not implemented for single-line)
      if (key === 'u') {
        return { ...noResult, bell: true };
      }

      return { ...noResult, bell: true };
    }

    // ── COUNT — accumulating count prefix ────────────────────────
    case CommandState.count: {
      if (isDigitOrZero(key)) {
        cmd.count = _clampCount(cmd.count * 10 + parseInt(key, 10));
        return noResult;
      }
      // Transition to appropriate next state
      cmd.phase = CommandState.idle;
      // Re-process this key with count set
      const result = transition(state, key, ctx);
      // Apply count to the result if it's a motion
      return result;
    }

    // ── OPERATOR — pending motion/text object ────────────────────
    case CommandState.operator: {
      // Double operator = line operation (dd, cc, yy)
      if (key === cmd.operator) {
        const doubleCmd = cmd.operator + cmd.operator;
        const result = executeStandalone(doubleCmd, line, cursor, getEffectiveCount(cmd), persistent);
        if (result) {
          persistent.lastChange = { cmd: doubleCmd, count: getEffectiveCount(cmd) };
          const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
          Object.assign(cmd, createCommandContext());
          return { state, result, modeSwitch, bell: false };
        }
        Object.assign(cmd, createCommandContext());
        return { ...noResult, bell: true };
      }

      // Count after operator
      if (isDigit(key)) {
        cmd.phase = CommandState.operatorCount;
        cmd.operatorCount = parseInt(key, 10);
        return noResult;
      }

      // Motion key
      if (MOTION_KEYS.has(key)) {
        const count = getEffectiveCount(cmd);
        const motion = resolveMotion(key, line, cursor, count, null, null, persistent.lastFind);
        if (motion) {
          const result = executeOperator(cmd.operator, motion, line, cursor, persistent);
          persistent.lastChange = { cmd: cmd.operator, motion: key, count };
          const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
          Object.assign(cmd, createCommandContext());
          return { state, result, modeSwitch, bell: false };
        }
        Object.assign(cmd, createCommandContext());
        return { ...noResult, bell: true };
      }

      // Find key
      if (FIND_KEYS.has(key)) {
        cmd.phase = CommandState.operatorFind;
        cmd.findDirection = key;
        return noResult;
      }

      // Text object modifier (i/a)
      if (TEXT_OBJ_MODS.has(key)) {
        cmd.phase = CommandState.operatorTextObj;
        cmd.textObjMod = key;
        return noResult;
      }

      // g-prefix inside operator
      if (key === 'g') {
        cmd.phase = CommandState.operatorG;
        return noResult;
      }

      // Escape cancels
      Object.assign(cmd, createCommandContext());
      return noResult;
    }

    // ── OPERATOR COUNT — count after operator ────────────────────
    case CommandState.operatorCount: {
      if (isDigitOrZero(key)) {
        cmd.operatorCount = _clampCount(cmd.operatorCount * 10 + parseInt(key, 10));
        return noResult;
      }
      // Transition back to operator state and re-process
      cmd.phase = CommandState.operator;
      return transition(state, key, ctx);
    }

    // ── OPERATOR FIND — operator + f/F/t/T pending char ──────────
    case CommandState.operatorFind: {
      const count = getEffectiveCount(cmd);
      const motion = resolveMotion(cmd.findDirection, line, cursor, count, key, cmd.findDirection, null);
      persistent.lastFind = { direction: cmd.findDirection, char: key };
      if (motion) {
        const result = executeOperator(cmd.operator, motion, line, cursor, persistent);
        persistent.lastChange = { cmd: cmd.operator, motion: cmd.findDirection, findChar: key, count };
        const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
        Object.assign(cmd, createCommandContext());
        return { state, result, modeSwitch, bell: false };
      }
      Object.assign(cmd, createCommandContext());
      return { ...noResult, bell: true };
    }

    // ── OPERATOR TEXT OBJ — operator + i/a pending type ──────────
    case CommandState.operatorTextObj: {
      if (TEXT_OBJ_TYPES.has(key)) {
        const range = resolveTextObject(key, cmd.textObjMod, line, cursor);
        if (range) {
          const count = getEffectiveCount(cmd);
          const result = executeOperator(cmd.operator, { ...range, inclusive: true }, line, cursor, persistent);
          persistent.lastChange = { cmd: cmd.operator, textObj: cmd.textObjMod + key, count };
          const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
          Object.assign(cmd, createCommandContext());
          return { state, result, modeSwitch, bell: false };
        }
      }
      Object.assign(cmd, createCommandContext());
      return { ...noResult, bell: true };
    }

    // ── FIND — standalone f/F/t/T pending char ───────────────────
    case CommandState.find: {
      const count = cmd.count || 1;
      const motion = resolveMotion(cmd.findDirection, line, cursor, count, key, cmd.findDirection, null);
      persistent.lastFind = { direction: cmd.findDirection, char: key };
      Object.assign(cmd, createCommandContext());
      if (motion) {
        const newCursor = motion.start <= cursor ? motion.start : motion.end;
        return {
          state,
          result: { line, cursor: Math.max(0, Math.min(newCursor, Math.max(0, line.length - 1))), switchToInsert: false },
          modeSwitch: null,
          bell: false,
        };
      }
      return { ...noResult, bell: true };
    }

    // ── G — g-prefix pending ─────────────────────────────────────
    case CommandState.g: {
      if (key === 'g') {
        // gg → go to start of line (single-line mode)
        Object.assign(cmd, createCommandContext());
        return {
          state,
          result: { line, cursor: 0, switchToInsert: false },
          modeSwitch: null,
          bell: false,
        };
      }
      if (key === 'e') {
        // ge — backward word end (simplified: same as b)
        const motion = resolveMotion('b', line, cursor, cmd.count || 1, null, null, null);
        Object.assign(cmd, createCommandContext());
        if (motion) {
          return {
            state,
            result: { line, cursor: motion.start, switchToInsert: false },
            modeSwitch: null,
            bell: false,
          };
        }
        return { ...noResult, bell: true };
      }
      Object.assign(cmd, createCommandContext());
      return { ...noResult, bell: true };
    }

    // ── OPERATOR G — operator + g pending ────────────────────────
    case CommandState.operatorG: {
      if (key === 'g') {
        // dgg, cgg, ygg — operate from cursor to start
        const range = { start: 0, end: cursor, inclusive: false };
        const result = executeOperator(cmd.operator, range, line, cursor, persistent);
        persistent.lastChange = { cmd: cmd.operator + 'gg', count: getEffectiveCount(cmd) };
        const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
        Object.assign(cmd, createCommandContext());
        return { state, result, modeSwitch, bell: false };
      }
      if (key === 'e') {
        // dge — delete backward word end
        const motion = resolveMotion('b', line, cursor, cmd.count || 1, null, null, null);
        if (motion) {
          const result = executeOperator(cmd.operator, { start: motion.start, end: cursor, inclusive: false }, line, cursor, persistent);
          const modeSwitch = result.switchToInsert ? Mode.INSERT : null;
          Object.assign(cmd, createCommandContext());
          return { state, result, modeSwitch, bell: false };
        }
      }
      Object.assign(cmd, createCommandContext());
      return { ...noResult, bell: true };
    }

    // ── REPLACE — r pending replacement char ─────────────────────
    case CommandState.replace: {
      const result = executeStandalone('r', line, cursor, 1, persistent, key);
      Object.assign(cmd, createCommandContext());
      if (result) {
        persistent.lastChange = { cmd: 'r', replaceChar: key, count: 1 };
        return { state, result, modeSwitch: null, bell: false };
      }
      return { ...noResult, bell: true };
    }

    // ── INDENT — > or < pending second >/< ───────────────────────
    case CommandState.indent: {
      if (key === cmd.operator) {
        const doubleCmd = cmd.operator + cmd.operator;
        const result = executeStandalone(doubleCmd, line, cursor, getEffectiveCount(cmd), persistent);
        persistent.lastChange = { cmd: doubleCmd, count: getEffectiveCount(cmd) };
        Object.assign(cmd, createCommandContext());
        if (result) {
          return { state, result, modeSwitch: null, bell: false };
        }
        return { ...noResult, bell: true };
      }
      // Escape or anything else cancels
      Object.assign(cmd, createCommandContext());
      return { ...noResult, bell: true };
    }

    default:
      Object.assign(cmd, createCommandContext());
      return { ...noResult, bell: true };
  }
}

module.exports = { transition, MAX_VIM_COUNT, _vimCountClampEnabled, _clampCount, getEffectiveCount };
