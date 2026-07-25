/**
 * Vim input handler — dual-mode input layer for the REPL.
 *
 * When enabled, pauses readline, takes raw mode on stdin, handles all
 * keystrokes through the vim state machine, and emits synthetic 'line'
 * events to the existing readline on Enter.
 *
 * Escape disambiguation: 50ms timeout — bare \x1b = Escape (NORMAL mode),
 * \x1b[ + letter = arrow/special key sequence.
 */

const { Mode, createVimState, createCommandContext } = require('./types');
const { transition } = require('./transitions');
const { firstNonBlank } = require('./motions');

const ESC_TIMEOUT_MS = 50;

/**
 * Create a vim input handler wrapping an existing readline interface.
 *
 * @param {readline.Interface} rl - The REPL's readline interface
 * @param {object} [options]
 * @param {boolean} [options.enabled=false] - Start with vim enabled
 * @param {string} [options.prompt='> '] - Prompt string
 * @param {Function} [options.onModeChange] - Callback when mode changes
 * @returns {{ enable, disable, suspend, resume, getMode, isActive, setPrompt, destroy }}
 */
function createVimInputHandler(rl, options = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  let active = false;
  let suspended = false;
  let vimState = createVimState();
  let lineBuffer = '';
  let cursorPos = 0;
  let prompt = options.prompt || '> ';
  let onModeChange = options.onModeChange || null;
  let escTimer = null;
  let escBuffer = '';
  let historyIndex = -1;
  let historySnapshot = '';  // Save current line when entering history
  let onDataHandler = null;

  // ── History access ───────────────────────────────────────────────
  // readline stores history internally; we access it for up/down navigation

  function getHistory() {
    if (rl && rl.history) return rl.history;
    return [];
  }

  // ── Rendering ────────────────────────────────────────────────────

  function render() {
    if (!active || suspended) return;

    // Clear current line and redraw
    const cols = stdout.columns || 80;
    stdout.write('\r\x1b[K');

    // Mode indicator
    const modeTag = vimState.mode === Mode.NORMAL
      ? '\x1b[48;5;240m\x1b[97m NORMAL \x1b[0m '
      : '\x1b[48;5;22m\x1b[97m INSERT \x1b[0m ';

    stdout.write(modeTag + prompt + lineBuffer);

    // Position cursor
    const promptLen = stripAnsi(modeTag).length + stripAnsi(prompt).length;
    const cursorCol = promptLen + cursorPos;
    stdout.write(`\r\x1b[${cursorCol + 1}G`);
  }

  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  }

  // ── Mode switching ───────────────────────────────────────────────

  function setMode(mode) {
    if (vimState.mode === mode) return;
    vimState.mode = mode;
    if (mode === Mode.NORMAL) {
      // In NORMAL mode, cursor can't be past end of text
      if (lineBuffer.length > 0 && cursorPos >= lineBuffer.length) {
        cursorPos = lineBuffer.length - 1;
      }
    }
    Object.assign(vimState.cmd, createCommandContext());
    if (onModeChange) onModeChange(mode);
    render();
  }

  // ── Insert mode key handling ─────────────────────────────────────

  function handleInsertKey(key) {
    // Enter — submit line
    if (key === '\r' || key === '\n') {
      submitLine();
      return;
    }

    // Backspace
    if (key === '\x7f' || key === '\b' || key === '\x08') {
      if (cursorPos > 0) {
        lineBuffer = lineBuffer.slice(0, cursorPos - 1) + lineBuffer.slice(cursorPos);
        cursorPos--;
      }
      render();
      return;
    }

    // Delete
    if (key === '\x1b[3~') {
      if (cursorPos < lineBuffer.length) {
        lineBuffer = lineBuffer.slice(0, cursorPos) + lineBuffer.slice(cursorPos + 1);
      }
      render();
      return;
    }

    // Arrow keys
    if (key === '\x1b[D') { // Left
      cursorPos = Math.max(0, cursorPos - 1);
      render();
      return;
    }
    if (key === '\x1b[C') { // Right
      cursorPos = Math.min(lineBuffer.length, cursorPos + 1);
      render();
      return;
    }
    if (key === '\x1b[A') { // Up — history
      navigateHistory(-1);
      return;
    }
    if (key === '\x1b[B') { // Down — history
      navigateHistory(1);
      return;
    }

    // Home
    if (key === '\x1b[H' || key === '\x01') { // Ctrl+A
      cursorPos = 0;
      render();
      return;
    }

    // End
    if (key === '\x1b[F' || key === '\x05') { // Ctrl+E
      cursorPos = lineBuffer.length;
      render();
      return;
    }

    // Ctrl+K — kill to end
    if (key === '\x0b') {
      lineBuffer = lineBuffer.slice(0, cursorPos);
      render();
      return;
    }

    // Ctrl+U — kill to start
    if (key === '\x15') {
      lineBuffer = lineBuffer.slice(cursorPos);
      cursorPos = 0;
      render();
      return;
    }

    // Ctrl+W — kill word back
    if (key === '\x17') {
      if (cursorPos > 0) {
        let p = cursorPos - 1;
        while (p > 0 && lineBuffer[p - 1] === ' ') p--;
        while (p > 0 && lineBuffer[p - 1] !== ' ') p--;
        lineBuffer = lineBuffer.slice(0, p) + lineBuffer.slice(cursorPos);
        cursorPos = p;
      }
      render();
      return;
    }

    // Printable character
    if (key.length === 1 && key >= ' ') {
      lineBuffer = lineBuffer.slice(0, cursorPos) + key + lineBuffer.slice(cursorPos);
      cursorPos++;
      render();
      return;
    }

    // Multi-byte UTF-8 character
    if (key.length > 1 && !key.startsWith('\x1b')) {
      lineBuffer = lineBuffer.slice(0, cursorPos) + key + lineBuffer.slice(cursorPos);
      cursorPos += key.length;
      render();
    }
  }

  // ── Normal mode key handling ─────────────────────────────────────

  function handleNormalKey(key) {
    // Enter — submit line
    if (key === '\r' || key === '\n') {
      submitLine();
      return;
    }

    // j/k — history navigation in NORMAL mode
    if (key === 'j') {
      navigateHistory(1);
      return;
    }
    if (key === 'k') {
      navigateHistory(-1);
      return;
    }

    // Arrow keys — cursor movement or history
    if (key === '\x1b[D') { // Left = h
      handleNormalKey('h');
      return;
    }
    if (key === '\x1b[C') { // Right = l
      handleNormalKey('l');
      return;
    }
    if (key === '\x1b[A') { // Up = k
      navigateHistory(-1);
      return;
    }
    if (key === '\x1b[B') { // Down = j
      navigateHistory(1);
      return;
    }

    // G — go to end of line (single-line mode)
    if (key === 'G') {
      cursorPos = Math.max(0, lineBuffer.length - 1);
      render();
      return;
    }

    // Route through state machine
    const result = transition(vimState, key, { line: lineBuffer, cursor: cursorPos });

    if (result.result) {
      lineBuffer = result.result.line;
      cursorPos = result.result.cursor;
      // Clamp cursor
      if (vimState.mode === Mode.NORMAL && lineBuffer.length > 0) {
        cursorPos = Math.min(cursorPos, lineBuffer.length - 1);
      }
      cursorPos = Math.max(0, cursorPos);
    }

    if (result.modeSwitch === Mode.INSERT) {
      setMode(Mode.INSERT);
      return;
    }

    if (result.bell) {
      stdout.write('\x07'); // Terminal bell
    }

    render();
  }

  // ── History navigation ───────────────────────────────────────────

  function navigateHistory(direction) {
    const history = getHistory();
    if (history.length === 0) return;

    if (historyIndex === -1) {
      historySnapshot = lineBuffer;
    }

    const newIndex = historyIndex + direction;

    if (direction < 0) {
      // Going back in history
      if (newIndex < 0) {
        historyIndex = 0;
      } else if (newIndex >= history.length) {
        return;
      } else {
        historyIndex = newIndex;
      }
      lineBuffer = history[historyIndex] || '';
    } else {
      // Going forward in history
      if (historyIndex === -1) return;
      if (newIndex >= history.length) {
        // Back to current input
        historyIndex = -1;
        lineBuffer = historySnapshot;
      } else {
        historyIndex = newIndex;
        lineBuffer = history[historyIndex] || '';
      }
    }

    cursorPos = lineBuffer.length;
    if (vimState.mode === Mode.NORMAL && lineBuffer.length > 0) {
      cursorPos = lineBuffer.length - 1;
    }
    render();
  }

  // ── Line submission ──────────────────────────────────────────────

  function submitLine() {
    const submittedLine = lineBuffer;
    stdout.write('\n');
    lineBuffer = '';
    cursorPos = 0;
    historyIndex = -1;
    historySnapshot = '';
    setMode(Mode.INSERT);

    // Emit synthetic 'line' event to readline
    rl.emit('line', submittedLine);
  }

  // ── Escape handling with disambiguation ──────────────────────────

  function processEscapeSequence(data) {
    escBuffer += data;

    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }

    // Check if we have a complete escape sequence
    if (escBuffer.length >= 3 && escBuffer[1] === '[') {
      const seq = escBuffer;
      escBuffer = '';
      // Process each recognized sequence
      processKey(seq.slice(0, 3));
      // Any remaining chars processed separately
      if (seq.length > 3) {
        for (let i = 3; i < seq.length; i++) {
          processKey(seq[i]);
        }
      }
      return;
    }

    // If just ESC, wait for more data or timeout
    if (escBuffer === '\x1b') {
      escTimer = setTimeout(() => {
        escTimer = null;
        const buf = escBuffer;
        escBuffer = '';
        // Bare escape — switch to NORMAL mode
        if (vimState.mode === Mode.INSERT) {
          setMode(Mode.NORMAL);
        } else {
          // In NORMAL mode, ESC cancels pending command
          Object.assign(vimState.cmd, createCommandContext());
          render();
        }
        // Process any remaining chars (shouldn't happen, but safe)
        if (buf.length > 1) {
          for (let i = 1; i < buf.length; i++) {
            processKey(buf[i]);
          }
        }
      }, ESC_TIMEOUT_MS);
      return;
    }

    // Multi-char escape but not [, flush
    const buf = escBuffer;
    escBuffer = '';
    for (let i = 0; i < buf.length; i++) {
      processKey(buf[i]);
    }
  }

  // ── Key routing ──────────────────────────────────────────────────

  function processKey(key) {
    if (vimState.mode === Mode.INSERT) {
      handleInsertKey(key);
    } else {
      handleNormalKey(key);
    }
  }

  // ── Raw stdin data handler ───────────────────────────────────────

  function onData(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

    // Ctrl+C — always exit
    if (data === '\x03') {
      if (lineBuffer.length > 0) {
        lineBuffer = '';
        cursorPos = 0;
        setMode(Mode.INSERT);
        render();
      } else {
        // Propagate SIGINT
        process.emit('SIGINT');
      }
      return;
    }

    // Ctrl+D on empty line — EOF
    if (data === '\x04' && lineBuffer.length === 0) {
      rl.emit('close');
      return;
    }

    // Handle escape sequences
    if (data.startsWith('\x1b') || escBuffer.length > 0) {
      processEscapeSequence(data);
      return;
    }

    // Regular keys
    processKey(data);
  }

  // ── Public API ───────────────────────────────────────────────────

  function enable() {
    if (active) return;
    active = true;
    suspended = false;
    vimState = createVimState();
    lineBuffer = '';
    cursorPos = 0;
    historyIndex = -1;

    // Pause readline so it doesn't consume stdin
    if (rl && typeof rl.pause === 'function') {
      try { rl.pause(); } catch { /* ignore */ }
    }

    // Take raw mode
    onDataHandler = onData;
    try { stdin.resume(); } catch { /* ignore */ }
    if (typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(true); } catch { /* ignore */ }
    }
    stdin.on('data', onDataHandler);

    render();
  }

  function disable() {
    if (!active) return;
    active = false;
    suspended = false;

    // Remove our data handler
    if (onDataHandler) {
      stdin.removeListener('data', onDataHandler);
      onDataHandler = null;
    }

    // Release raw mode
    if (typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
    }

    // Clear escape timer
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    escBuffer = '';

    // Clear mode indicator from line
    stdout.write('\r\x1b[K');

    // Resume readline
    if (rl && typeof rl.resume === 'function') {
      try { rl.resume(); } catch { /* ignore */ }
    }
    try { stdin.resume(); } catch { /* ignore */ }
  }

  function suspend() {
    if (!active || suspended) return;
    suspended = true;

    // Remove data handler and release raw mode
    if (onDataHandler) {
      stdin.removeListener('data', onDataHandler);
    }
    if (typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
    }

    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    escBuffer = '';

    // Let readline or permission dialogs take over stdin
    try { stdin.resume(); } catch { /* ignore */ }
  }

  function resume() {
    if (!active || !suspended) return;
    suspended = false;

    // Re-take raw mode and data handler
    if (rl && typeof rl.pause === 'function') {
      try { rl.pause(); } catch { /* ignore */ }
    }
    try { stdin.resume(); } catch { /* ignore */ }
    if (typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(true); } catch { /* ignore */ }
    }
    if (onDataHandler) {
      stdin.on('data', onDataHandler);
    }

    render();
  }

  function getMode() {
    if (!active) return null;
    return vimState.mode;
  }

  function isActive() {
    return active && !suspended;
  }

  function setPrompt(newPrompt) {
    prompt = newPrompt;
    if (active && !suspended) render();
  }

  function setLine(text) {
    lineBuffer = text || '';
    cursorPos = lineBuffer.length;
    if (vimState.mode === Mode.NORMAL && lineBuffer.length > 0) {
      cursorPos = lineBuffer.length - 1;
    }
    if (active && !suspended) render();
  }

  function destroy() {
    disable();
    onModeChange = null;
  }

  // Auto-enable if configured
  if (options.enabled) {
    enable();
  }

  return {
    enable,
    disable,
    suspend,
    resume,
    getMode,
    isActive,
    setPrompt,
    setLine,
    destroy,
    setOnModeChange(cb) { onModeChange = cb; },
  };
}

module.exports = { createVimInputHandler };
