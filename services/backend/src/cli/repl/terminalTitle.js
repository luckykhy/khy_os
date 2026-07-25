/**
 * Terminal title control (ANSI OSC escapes) + work-phase spinner.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. This is the ONLY extracted cluster with shared mutable
 * state. That state (_currentTopic, _titleSpinnerTimer, _titleSpinnerIdx)
 * stays here as module-private singletons: Node's require cache makes this
 * module a single shared instance, so the topic-fallback memory and the
 * single-timer guard behave exactly as they did when these were file-level
 * `let`s in repl.js. Moving the state into function parameters would change
 * the topic-fallback semantics, so it must remain module-scoped.
 *
 * The spinner setInterval keeps its .unref() so it never holds the event
 * loop open.
 */

function setTerminalTitle(title) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}

// Track the current conversation topic for dynamic title updates
let _currentTopic = '';

function updateTitleFromConversation(userMessage) {
  const topic = (userMessage || '').replace(/\n/g, ' ').slice(0, 30).trim();
  _currentTopic = topic || _currentTopic;
  setTerminalTitle(_currentTopic ? `✧ ${_currentTopic}` : 'khy OS');
}

const _titleSpinnerFrames = ['✦', '✧', '⊹', '✧', '✦', '·', '⊹', '·'];
let _titleSpinnerTimer = null;
let _titleSpinnerIdx = 0;

function _startTitleSpinner() {
  if (_titleSpinnerTimer) return;
  _titleSpinnerIdx = 0;
  _titleSpinnerTimer = setInterval(() => {
    const frame = _titleSpinnerFrames[_titleSpinnerIdx % _titleSpinnerFrames.length];
    _titleSpinnerIdx++;
    setTerminalTitle(`${frame} ${_currentTopic || 'khy OS'}`);
  }, 200);
  if (_titleSpinnerTimer.unref) _titleSpinnerTimer.unref();
}

function _stopTitleSpinner() {
  if (_titleSpinnerTimer) {
    clearInterval(_titleSpinnerTimer);
    _titleSpinnerTimer = null;
  }
  setTerminalTitle(`✧ ${_currentTopic || 'khy OS'}`);
}

/**
 * Update terminal title to reflect current work phase.
 * Working phases show an animated spinner; idle shows a static dot.
 * @param {'thinking'|'tool'|'generating'|'idle'} phase
 * @param {string} [detail] - tool name or phase detail
 */
function updateTitlePhase(phase, detail = '') {
  if (phase === 'idle') {
    _stopTitleSpinner();
  } else {
    _startTitleSpinner();
  }
}

module.exports = {
  setTerminalTitle,
  updateTitleFromConversation,
  updateTitlePhase,
};
