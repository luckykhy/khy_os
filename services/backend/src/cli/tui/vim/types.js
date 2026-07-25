'use strict';

/**
 * Vim state-machine constants and factories (ported from Claude Code's
 * src/vim/types.ts, stripped of TypeScript types). The runtime values — key
 * groups and initial-state factories — are what the engine actually uses.
 *
 * State shapes (documented, since JS can't enforce them):
 *   VimState   = { mode:'INSERT', insertedText } | { mode:'NORMAL', command }
 *   CommandState =
 *     | { type:'idle' }
 *     | { type:'count', digits }
 *     | { type:'operator', op, count }
 *     | { type:'operatorCount', op, count, digits }
 *     | { type:'operatorFind', op, count, find }
 *     | { type:'operatorTextObj', op, count, scope }
 *     | { type:'find', find, count }
 *     | { type:'g', count }
 *     | { type:'operatorG', op, count }
 *     | { type:'replace', count }
 *     | { type:'indent', dir, count }
 */

const OPERATORS = { d: 'delete', c: 'change', y: 'yank' };

function isOperatorKey(key) {
  return Object.prototype.hasOwnProperty.call(OPERATORS, key);
}

const SIMPLE_MOTIONS = new Set([
  'h', 'l', 'j', 'k',          // basic movement
  'w', 'b', 'e', 'W', 'B', 'E', // word motions
  '0', '^', '$',               // line positions
]);

const FIND_KEYS = new Set(['f', 'F', 't', 'T']);

const TEXT_OBJ_SCOPES = { i: 'inner', a: 'around' };

function isTextObjScopeKey(key) {
  return Object.prototype.hasOwnProperty.call(TEXT_OBJ_SCOPES, key);
}

const TEXT_OBJ_TYPES = new Set([
  'w', 'W',            // word / WORD
  '"', "'", '`',       // quotes
  '(', ')', 'b',       // parens
  '[', ']',            // brackets
  '{', '}', 'B',       // braces
  '<', '>',            // angle brackets
]);

const MAX_VIM_COUNT = 10000;

function createInitialVimState() {
  return { mode: 'INSERT', insertedText: '' };
}

function createInitialPersistentState() {
  return {
    lastChange: null,
    lastFind: null,
    register: '',
    registerIsLinewise: false,
  };
}

module.exports = {
  OPERATORS,
  isOperatorKey,
  SIMPLE_MOTIONS,
  FIND_KEYS,
  TEXT_OBJ_SCOPES,
  isTextObjScopeKey,
  TEXT_OBJ_TYPES,
  MAX_VIM_COUNT,
  createInitialVimState,
  createInitialPersistentState,
};
