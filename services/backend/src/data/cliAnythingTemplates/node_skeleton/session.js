'use strict';

class SessionManager {
  static _instance = null;

  constructor() {
    this._state = {};
    this._undoStack = [];
    this._redoStack = [];
  }

  static getCurrent() {
    if (!SessionManager._instance) {
      SessionManager._instance = new SessionManager();
    }
    return SessionManager._instance;
  }

  get state() { return this._state; }

  snapshot() {
    this._undoStack.push(structuredClone(this._state));
    this._redoStack.length = 0;
  }

  update(key, value) {
    this.snapshot();
    this._state[key] = value;
  }

  undo() {
    if (!this._undoStack.length) {
      return { status: 'error', message: 'Nothing to undo' };
    }
    this._redoStack.push(structuredClone(this._state));
    this._state = this._undoStack.pop();
    return { status: 'success', message: 'Undo successful' };
  }

  redo() {
    if (!this._redoStack.length) {
      return { status: 'error', message: 'Nothing to redo' };
    }
    this._undoStack.push(structuredClone(this._state));
    this._state = this._redoStack.pop();
    return { status: 'success', message: 'Redo successful' };
  }

  reset() {
    this._state = {};
    this._undoStack.length = 0;
    this._redoStack.length = 0;
  }
}

module.exports = { SessionManager };
