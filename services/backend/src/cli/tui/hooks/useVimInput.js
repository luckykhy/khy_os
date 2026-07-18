'use strict';

/**
 * useVimInput — full modal vim wrapper around useTextInput. Ported from Claude
 * Code's hooks/useVimInput.ts, adapted to KHY's *uncontrolled* useTextInput
 * (CC's is controlled via value/onChange props).
 *
 * Key adaptation: CC's OperatorContext.setText maps to props.onChange (the
 * parent owns the buffer). KHY's buffer lives inside useTextInput, so setText
 * maps to textInput.setText and setOffset to the newly-added textInput.setOffset.
 * Every operator does setText → setOffset/enterInsert, and KHY's setText leaves
 * the offset at end, so the following setOffset corrects it — order-safe.
 *
 * Hooks can't be conditional, so this is always called; the `enabled` flag
 * gates behaviour. When disabled, every key passes straight through to
 * textInput.onInput and the mode is pinned to INSERT.
 */
const React = require('react');
const { useCallback, useState, useEffect, useRef } = React;

const { VimCursor, lastGrapheme } = require('../vim/cursor');
const {
  executeIndent,
  executeJoin,
  executeOpenLine,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executeReplace,
  executeToggleCase,
  executeX,
} = require('../vim/operators');
const { transition } = require('../vim/transitions');
const {
  createInitialPersistentState,
  createInitialVimState,
} = require('../vim/types');
const { useTextInput } = require('./useTextInput');

function useVimInput(props = {}) {
  const { enabled = false, onModeChange, onUndo, inputFilter } = props;

  const vimStateRef = useRef(createInitialVimState());
  const [mode, setMode] = useState('INSERT');
  const persistentRef = useRef(createInitialPersistentState());

  // inputFilter is applied inside handleVimInput (not passed to useTextInput)
  // so vim-handled paths that return without calling textInput.onInput still
  // run the filter — mirrors CC.
  const textInput = useTextInput({
    onSubmit: props.onSubmit,
    onChange: props.onChange,
    onHistoryEmpty: props.onHistoryEmpty,
  });

  // Keep a live mirror of value/offset so operator context reads the latest
  // post-commit buffer within a single synchronous keystroke.
  const valueRef = useRef(textInput.value);
  const offsetRef = useRef(textInput.offset);
  valueRef.current = textInput.value;
  offsetRef.current = textInput.offset;

  // When vim is toggled off, snap back to INSERT so the buffer behaves plainly.
  useEffect(() => {
    if (!enabled) {
      vimStateRef.current = createInitialVimState();
      if (mode !== 'INSERT') setMode('INSERT');
    }
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchToInsertMode = useCallback((offset) => {
    if (offset !== undefined) textInput.setOffset(offset);
    vimStateRef.current = { mode: 'INSERT', insertedText: '' };
    setMode('INSERT');
    if (onModeChange) onModeChange('INSERT');
  }, [textInput, onModeChange]);

  const switchToNormalMode = useCallback(() => {
    const current = vimStateRef.current;
    if (current.mode === 'INSERT' && current.insertedText) {
      persistentRef.current.lastChange = {
        type: 'insert',
        text: current.insertedText,
      };
    }

    // Vim moves the cursor left by 1 when leaving INSERT (unless at line start
    // or offset 0).
    const offset = offsetRef.current;
    const value = valueRef.current;
    if (offset > 0 && value[offset - 1] !== '\n') {
      textInput.setOffset(offset - 1);
    }

    vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } };
    setMode('NORMAL');
    if (onModeChange) onModeChange('NORMAL');
  }, [textInput, onModeChange]);

  const createOperatorContext = useCallback((cursor, isReplay = false) => {
    return {
      cursor,
      text: valueRef.current,
      setText: (newText) => textInput.setText(newText),
      setOffset: (offset) => textInput.setOffset(offset),
      enterInsert: (offset) => switchToInsertMode(offset),
      getRegister: () => persistentRef.current.register,
      setRegister: (content, linewise) => {
        persistentRef.current.register = content;
        persistentRef.current.registerIsLinewise = linewise;
      },
      getLastFind: () => persistentRef.current.lastFind,
      setLastFind: (type, char) => {
        persistentRef.current.lastFind = { type, char };
      },
      recordChange: isReplay
        ? () => {}
        : (change) => { persistentRef.current.lastChange = change; },
    };
  }, [textInput, switchToInsertMode]);

  const replayLastChange = useCallback(() => {
    const change = persistentRef.current.lastChange;
    if (!change) return;

    const cursor = VimCursor.fromText(valueRef.current, offsetRef.current);
    const ctx = createOperatorContext(cursor, true);

    switch (change.type) {
      case 'insert':
        if (change.text) {
          const newCursor = cursor.insert(change.text);
          textInput.setText(newCursor.text, newCursor.offset);
        }
        break;
      case 'x': executeX(change.count, ctx); break;
      case 'replace': executeReplace(change.char, change.count, ctx); break;
      case 'toggleCase': executeToggleCase(change.count, ctx); break;
      case 'indent': executeIndent(change.dir, change.count, ctx); break;
      case 'join': executeJoin(change.count, ctx); break;
      case 'openLine': executeOpenLine(change.direction, ctx); break;
      case 'operator':
        executeOperatorMotion(change.op, change.motion, change.count, ctx);
        break;
      case 'operatorFind':
        executeOperatorFind(change.op, change.find, change.char, change.count, ctx);
        break;
      case 'operatorTextObj':
        executeOperatorTextObj(change.op, change.scope, change.objType, change.count, ctx);
        break;
      default: break;
    }
  }, [textInput, createOperatorContext]);

  const handleVimInput = useCallback((rawInput, key) => {
    // Disabled → plain text input, mode pinned to INSERT.
    if (!enabled) {
      textInput.onInput(rawInput, key);
      return;
    }

    const state = vimStateRef.current;
    // Run inputFilter in all modes so stateful filters disarm on any key, but
    // only apply the transformed input in INSERT — NORMAL command lookups
    // expect single chars.
    const filtered = inputFilter ? inputFilter(rawInput, key) : rawInput;
    const input = state.mode === 'INSERT' ? filtered : rawInput;
    const cursor = VimCursor.fromText(valueRef.current, offsetRef.current);

    if (key.ctrl) {
      textInput.onInput(input, key);
      return;
    }

    // Vim's standard INSERT→NORMAL switch. Deliberately not configurable.
    if (key.escape && state.mode === 'INSERT') {
      switchToNormalMode();
      return;
    }

    // Escape in NORMAL cancels any pending command (replace/operator/etc.).
    if (key.escape && state.mode === 'NORMAL') {
      vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } };
      return;
    }

    // Enter passes through in any mode (allows submit from NORMAL).
    if (key.return) {
      textInput.onInput(input, key);
      return;
    }

    if (state.mode === 'INSERT') {
      // Track inserted text for dot-repeat.
      if (key.backspace || key.delete) {
        if (state.insertedText.length > 0) {
          vimStateRef.current = {
            mode: 'INSERT',
            insertedText: state.insertedText.slice(
              0,
              -(lastGrapheme(state.insertedText).length || 1),
            ),
          };
        }
      } else {
        vimStateRef.current = {
          mode: 'INSERT',
          insertedText: state.insertedText + input,
        };
      }
      textInput.onInput(input, key);
      return;
    }

    if (state.mode !== 'NORMAL') return;

    // In idle NORMAL, arrow keys delegate to the base handler (movement +
    // history fallback).
    if (
      state.command.type === 'idle' &&
      (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
    ) {
      textInput.onInput(input, key);
      return;
    }

    const ctx = Object.assign(createOperatorContext(cursor, false), {
      onUndo,
      onDotRepeat: replayLastChange,
    });

    // Backspace/Delete only map to motions in motion-expecting states; in
    // literal-char states (replace/find/operatorFind) mapping would corrupt
    // the command.
    const expectsMotion =
      state.command.type === 'idle' ||
      state.command.type === 'count' ||
      state.command.type === 'operator' ||
      state.command.type === 'operatorCount';

    let vimInput = input;
    if (key.leftArrow) vimInput = 'h';
    else if (key.rightArrow) vimInput = 'l';
    else if (key.upArrow) vimInput = 'k';
    else if (key.downArrow) vimInput = 'j';
    else if (expectsMotion && key.backspace) vimInput = 'h';
    else if (expectsMotion && state.command.type !== 'count' && key.delete) vimInput = 'x';

    const result = transition(state.command, vimInput, ctx);

    if (result.execute) result.execute();

    // Update command state (only if execute didn't switch to INSERT).
    if (vimStateRef.current.mode === 'NORMAL') {
      if (result.next) {
        vimStateRef.current = { mode: 'NORMAL', command: result.next };
      } else if (result.execute) {
        vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } };
      }
    }
  }, [enabled, inputFilter, textInput, switchToNormalMode, createOperatorContext, replayLastChange, onUndo]);

  const setModeExternal = useCallback((newMode) => {
    if (newMode === 'INSERT') {
      vimStateRef.current = { mode: 'INSERT', insertedText: '' };
    } else {
      vimStateRef.current = { mode: 'NORMAL', command: { type: 'idle' } };
    }
    setMode(newMode);
    if (onModeChange) onModeChange(newMode);
  }, [onModeChange]);

  return {
    ...textInput,
    onInput: handleVimInput,
    mode: enabled ? mode : 'INSERT',
    setMode: setModeExternal,
  };
}

module.exports = { useVimInput };
