/**
 * Vim mode type definitions — Mode, CommandState, PersistentState.
 *
 * Matches Claude Code's src/vim/ state machine architecture.
 */

// ── Editing modes ──────────────────────────────────────────────────
const Mode = Object.freeze({
  INSERT: 'INSERT',
  NORMAL: 'NORMAL',
});

// ── State machine phases within NORMAL mode ────────────────────────
const CommandState = Object.freeze({
  idle:            'idle',
  count:           'count',           // accumulating count prefix (e.g. "3")
  operator:        'operator',        // operator pending motion (e.g. "d")
  operatorCount:   'operatorCount',   // count inside operator (e.g. "d3")
  operatorFind:    'operatorFind',    // operator + find pending char (e.g. "dt")
  operatorTextObj: 'operatorTextObj', // operator + i/a pending type (e.g. "di")
  find:            'find',            // standalone find pending char (e.g. "f")
  g:               'g',              // g-prefix pending second key
  operatorG:       'operatorG',       // operator + g pending (e.g. "dg")
  replace:         'replace',         // r pending replacement char
  indent:          'indent',          // > or < pending second > or <
});

// ── Operator types ─────────────────────────────────────────────────
const Operator = Object.freeze({
  delete: 'd',
  change: 'c',
  yank:   'y',
  indent: '>',
  dedent: '<',
});

// ── Factory for fresh command state ────────────────────────────────
function createCommandContext() {
  return {
    phase:          CommandState.idle,
    count:          0,        // accumulated count prefix
    operator:       null,     // pending operator (d/c/y/>/<)
    operatorCount:  0,        // count after operator
    findDirection:  null,     // 'f' | 'F' | 't' | 'T'
    textObjMod:     null,     // 'i' | 'a'
  };
}

// ── Persistent state across commands ───────────────────────────────
function createPersistentState() {
  return {
    register:   '',           // yank register (single register, not bank)
    lastChange: null,         // { keys, line, cursor } for dot-repeat
    lastFind:   null,         // { direction, char } for ;/, repeat
  };
}

// ── Full vim state ─────────────────────────────────────────────────
function createVimState() {
  return {
    mode:       Mode.INSERT,
    cmd:        createCommandContext(),
    persistent: createPersistentState(),
  };
}

module.exports = {
  Mode,
  CommandState,
  Operator,
  createCommandContext,
  createPersistentState,
  createVimState,
};
