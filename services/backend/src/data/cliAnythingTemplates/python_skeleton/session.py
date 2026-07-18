import copy

class SessionManager:
    """Deep-copy undo/redo session manager."""
    _instance = None

    def __init__(self):
        self._state = {}
        self._undo_stack = []
        self._redo_stack = []

    @classmethod
    def get_current(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def state(self):
        return self._state

    def snapshot(self):
        """Take a deep copy of current state and push to undo stack."""
        self._undo_stack.append(copy.deepcopy(self._state))
        self._redo_stack.clear()

    def update(self, key, value):
        """Update state with automatic snapshot."""
        self.snapshot()
        self._state[key] = value

    def undo(self):
        if not self._undo_stack:
            return {'status': 'error', 'message': 'Nothing to undo'}
        self._redo_stack.append(copy.deepcopy(self._state))
        self._state = self._undo_stack.pop()
        return {'status': 'success', 'message': 'Undo successful'}

    def redo(self):
        if not self._redo_stack:
            return {'status': 'error', 'message': 'Nothing to redo'}
        self._undo_stack.append(copy.deepcopy(self._state))
        self._state = self._redo_stack.pop()
        return {'status': 'success', 'message': 'Redo successful'}

    def reset(self):
        self._state = {}
        self._undo_stack.clear()
        self._redo_stack.clear()
