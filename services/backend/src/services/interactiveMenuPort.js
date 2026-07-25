'use strict';

// interactiveMenuPort.js — neutral port for interactive single/multi choice menus.
//
// Breaks a service-to-cli reverse edge (REQ-2026-001 / DESIGN-ARCH-057): the
// service layer (inputPreprocessor.clarifyIntent) needs an interactive menu, but
// must not reach up into cli/ui/inkComponents. The cli renderer self-registers its
// selectMenu here on load (legit cli->service); the service asks via this port and
// degrades (inquirer, then first candidate) when no prompter is registered
// (headless / non-interactive). Zero deps (leaf).
//
// Prompter contract: selectMenu({ message, choices, multi?, allowOther?, fuzzy? }) -> picked

let _menu = null;

function registerMenuPrompter(impl) {
  _menu = (typeof impl === 'function') ? impl : null;
}

function getMenuPrompter() {
  return _menu;
}

function _resetForTest() { _menu = null; }

module.exports = { registerMenuPrompter, getMenuPrompter, _resetForTest };
