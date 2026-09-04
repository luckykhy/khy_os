'use strict';

function _allowedWorkspacePrefixes() {
  const raw = process.env.KHY_REMOTE_WORKSPACE_ALLOWLIST || '';
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function _validateWorkspaceValue(workspace) {
  if (workspace.includes('\0')) {
    const error = new Error('Workspace contains a null byte, which is not allowed.');
    error.code = 'workspace_contains_null_byte';
    throw error;
  }
  if (workspace.length > 4096) {
    const error = new Error('Workspace path is too long.');
    error.code = 'workspace_too_long';
    throw error;
  }
}

function resolveWorkspace({ requestedWorkspace, hostEntry }) {
  const fallbackWorkspace = (hostEntry && hostEntry.remoteWorkspace) || '~';
  const selectedWorkspace = String(requestedWorkspace || fallbackWorkspace).trim();

  if (!selectedWorkspace) {
    const error = new Error('Workspace cannot be empty.');
    error.code = 'workspace_empty';
    throw error;
  }

  _validateWorkspaceValue(selectedWorkspace);

  const allowlist = _allowedWorkspacePrefixes();
  if (allowlist.length > 0) {
    const allowed = allowlist.some((prefix) => selectedWorkspace.startsWith(prefix));
    if (!allowed) {
      const error = new Error(`Workspace is outside allowlist prefixes: ${allowlist.join(', ')}`);
      error.code = 'workspace_not_allowed';
      throw error;
    }
  }

  return selectedWorkspace;
}

module.exports = {
  resolveWorkspace,
};
