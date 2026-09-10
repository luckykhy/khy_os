'use strict';

/**
 * Containers service — container management for code execution.
 * Supports Docker containers for isolated environments.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function _env(name) {
  return String(process.env[`KHY_CONTAINER_${name}`] || '').trim();
}

// ── Docker Operations ──
async function dockerBuild(imageName, dockerfilePath, contextPath = '.') {
  return new Promise((resolve) => {
    const child = spawn('docker', ['build', '-t', imageName, '-f', dockerfilePath, contextPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, image: imageName, output: stdout });
      } else {
        resolve({ success: false, error: stderr || `Exit code: ${code}` });
      }
    });

    child.on('error', (e) => resolve({ success: false, error: e.message }));
  });
}

async function dockerRun(imageName, options = {}) {
  const containerName = options.name || `khy-container-${crypto.randomBytes(4).toString('hex')}`;
  const args = ['run', '--name', containerName];

  if (options.detached) args.push('-d');
  if (options.interactive) args.push('-it');
  if (options.remove) args.push('--rm');
  if (options.network) args.push('--network', options.network);
  if (options.memory) args.push('-m', options.memory);
  if (options.cpus) args.push('--cpus', String(options.cpus));

  // Volume mounts
  if (options.volumes) {
    for (const vol of options.volumes) {
      args.push('-v', vol);
    }
  }

  // Environment variables
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  args.push(imageName);

  if (options.command) {
    args.push(options.command);
  }

  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, container: containerName, output: stdout });
      } else {
        resolve({ success: false, error: stderr || `Exit code: ${code}` });
      }
    });

    child.on('error', (e) => resolve({ success: false, error: e.message }));
  });
}

async function dockerStop(containerName) {
  return new Promise((resolve) => {
    try {
      execSync(`docker stop ${containerName}`, { stdio: 'ignore' });
      resolve({ success: true, container: containerName, stopped: true });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

async function dockerRemove(containerName) {
  return new Promise((resolve) => {
    try {
      execSync(`docker rm ${containerName}`, { stdio: 'ignore' });
      resolve({ success: true, container: containerName, removed: true });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

async function dockerListContainers(all = false) {
  return new Promise((resolve) => {
    try {
      const args = ['ps', '--format', '{{.ID}}|{{.Image}}|{{.Status}}|{{.Names}}'];
      if (all) args.splice(1, 0, '-a');

      const output = execSync(args.join(' '), { encoding: 'utf-8' });
      const containers = output.trim().split('\n').filter(Boolean).map((line) => {
        const [id, image, status, names] = line.split('|');
        return { id, image, status, names };
      });
      resolve({ success: true, containers });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

async function dockerExec(containerName, command) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', containerName, 'sh', '-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, error: stderr || `Exit code: ${code}` });
      }
    });

    child.on('error', (e) => resolve({ success: false, error: e.message }));
  });
}

async function dockerLogs(containerName, tail = 100) {
  return new Promise((resolve) => {
    try {
      const output = execSync(`docker logs --tail ${tail} ${containerName}`, { encoding: 'utf-8' });
      resolve({ success: true, logs: output });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// ── Container Registry ──
const PROVIDERS = [
  { id: 'docker', name: 'Docker' },
  { id: 'podman', name: 'Podman' },
];

function listProviders() {
  return PROVIDERS;
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'docker':
      try { execSync('docker --version', { stdio: 'ignore' }); return true; } catch { return false; }
    case 'podman':
      try { execSync('podman --version', { stdio: 'ignore' }); return true; } catch { return false; }
    default: return false;
  }
}

module.exports = {
  dockerBuild,
  dockerRun,
  dockerStop,
  dockerRemove,
  dockerListContainers,
  dockerExec,
  dockerLogs,
  listProviders,
  isProviderConfigured,
  PROVIDERS,
};
