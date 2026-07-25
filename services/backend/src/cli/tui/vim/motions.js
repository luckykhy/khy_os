'use strict';

/**
 * Vim motion functions — pure resolution of a motion key to a target cursor.
 * Ported from Claude Code's src/vim/motions.ts; operates on VimCursor.
 */

function resolveMotion(key, cursor, count) {
  let result = cursor;
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result);
    if (next.equals(result)) break;
    result = next;
  }
  return result;
}

function applySingleMotion(key, cursor) {
  switch (key) {
    case 'h': return cursor.left();
    case 'l': return cursor.right();
    case 'j': return cursor.downLogicalLine();
    case 'k': return cursor.upLogicalLine();
    case 'gj': return cursor.down();
    case 'gk': return cursor.up();
    case 'w': return cursor.nextVimWord();
    case 'b': return cursor.prevVimWord();
    case 'e': return cursor.endOfVimWord();
    case 'W': return cursor.nextWORD();
    case 'B': return cursor.prevWORD();
    case 'E': return cursor.endOfWORD();
    case '0': return cursor.startOfLogicalLine();
    case '^': return cursor.firstNonBlankInLogicalLine();
    case '$': return cursor.endOfLogicalLine();
    case 'G': return cursor.startOfLastLine();
    default: return cursor;
  }
}

/** Inclusive motions include the character at the destination. */
function isInclusiveMotion(key) {
  return 'eE$'.includes(key);
}

/** Linewise motions operate on full lines when paired with an operator. */
function isLinewiseMotion(key) {
  return 'jkG'.includes(key) || key === 'gg';
}

module.exports = { resolveMotion, isInclusiveMotion, isLinewiseMotion };
