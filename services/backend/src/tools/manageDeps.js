const { defineTool } = require('./_baseTool');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { NULL_DEVICE } = require('./platformUtils');
const _execCompat = require('./_execCompat');

module.exports = defineTool({
  name: 'manageDeps',
  description:
    'Manage project dependencies. Actions: install, add, remove, outdated, audit. ' +
    'Auto-detects package manager (npm/yarn/pnpm/pip/cargo).',
  category: 'execution',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,

  inputSchema: {
    action: {
      type: 'string',
      required: true,
      description: 'Action to perform',
      enum: ['install', 'add', 'remove', 'outdated', 'audit', 'list'],
    },
    packages: {
      type: 'string',
      required: false,
      description: 'Space-separated package names (for add/remove)',
    },
    dev: {
      type: 'boolean',
      required: false,
      description: 'Install as dev dependency (default: false)',
    },
  },

  getActivityDescription(input) {
    return `管理依赖：${input.action || 'install'}`;
  },

  async execute(params) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const opts = { cwd, encoding: 'utf-8', timeout: 120000, maxBuffer: 1024 * 1024 };

    // Detect package manager
    const pm = _detectPM(cwd);
    if (!pm) {
      return { success: false, error: 'No recognized package manager detected (package.json, pyproject.toml, Cargo.toml, go.mod)' };
    }

    const action = params.action;
    const packages = params.packages || '';
    const isDev = params.dev || false;

    try {
      let cmd;
      switch (pm.type) {
        case 'npm':
        case 'yarn':
        case 'pnpm':
          cmd = _buildNodeCmd(pm.type, action, packages, isDev);
          break;
        case 'pip':
          cmd = _buildPipCmd(action, packages);
          break;
        case 'cargo':
          cmd = _buildCargoCmd(action, packages, isDev);
          break;
        case 'go':
          cmd = _buildGoCmd(action, packages);
          break;
        default:
          return { success: false, error: `Unsupported package manager: ${pm.type}` };
      }

      if (!cmd) {
        return { success: false, error: `Action "${action}" not supported for ${pm.type}` };
      }

      const output = _execCompat.isNonBlockingExecEnabled(process.env)
        ? await _execCompat.execAsync(cmd, opts)
        : execSync(cmd, opts);
      return {
        success: true,
        packageManager: pm.type,
        action,
        output: (output || '').slice(0, 10000),
      };
    } catch (err) {
      return {
        success: false,
        packageManager: pm.type,
        action,
        error: (err.stderr || err.message || '').slice(0, 5000),
      };
    }
  },
});

function _detectPM(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return { type: 'pnpm' };
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return { type: 'yarn' };
  if (fs.existsSync(path.join(cwd, 'package.json'))) return { type: 'npm' };
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return { type: 'cargo' };
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return { type: 'go' };
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) return { type: 'pip' };
  return null;
}

function _buildNodeCmd(pm, action, packages, isDev) {
  const devFlag = {
    npm: isDev ? '--save-dev' : '',
    yarn: isDev ? '--dev' : '',
    pnpm: isDev ? '--save-dev' : '',
  };
  switch (action) {
    case 'install': return `${pm} install`;
    case 'add': return packages ? `${pm} ${pm === 'npm' ? 'install' : 'add'} ${packages} ${devFlag[pm]}`.trim() : null;
    case 'remove': return packages ? `${pm} ${pm === 'npm' ? 'uninstall' : 'remove'} ${packages}` : null;
    case 'outdated': return `${pm} outdated`;
    case 'audit': return `${pm} audit`;
    case 'list': return `${pm} list --depth=0`;
    default: return null;
  }
}

function _buildPipCmd(action, packages) {
  switch (action) {
    case 'install': return 'pip install -r requirements.txt';
    case 'add': return packages ? `pip install ${packages}` : null;
    case 'remove': return packages ? `pip uninstall -y ${packages}` : null;
    case 'outdated': return 'pip list --outdated';
    case 'audit': return `pip-audit 2>${NULL_DEVICE} || echo "pip-audit not installed"`;
    case 'list': return 'pip list';
    default: return null;
  }
}

function _buildCargoCmd(action, packages, isDev) {
  switch (action) {
    case 'install': return 'cargo build';
    case 'add': return packages ? `cargo add ${packages} ${isDev ? '--dev' : ''}`.trim() : null;
    case 'remove': return packages ? `cargo remove ${packages}` : null;
    case 'outdated': return `cargo outdated 2>${NULL_DEVICE} || echo "cargo-outdated not installed"`;
    case 'audit': return `cargo audit 2>${NULL_DEVICE} || echo "cargo-audit not installed"`;
    case 'list': return 'cargo tree --depth=1';
    default: return null;
  }
}

function _buildGoCmd(action, packages) {
  switch (action) {
    case 'install': return 'go mod download';
    case 'add': return packages ? `go get ${packages}` : null;
    case 'remove': return packages ? `go get ${packages}@none && go mod tidy` : null;
    case 'outdated': return 'go list -u -m all';
    case 'audit': return 'go vet ./...';
    case 'list': return 'go list -m all';
    default: return null;
  }
}
