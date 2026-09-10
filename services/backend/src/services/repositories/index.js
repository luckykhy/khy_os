'use strict';

/**
 * Repositories service — code repository operations.
 * Supports Git operations across multiple platforms.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function _env(name) {
  return String(process.env[`KHY_REPO_${name}`] || '').trim();
}

// ── Git Operations ──
async function gitClone(url, targetPath, options = {}) {
  return new Promise((resolve) => {
    const args = ['clone', url, targetPath];
    if (options.depth) args.push('--depth', String(options.depth));
    if (options.branch) args.push('--branch', options.branch);

    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, path: targetPath, output: stdout });
      } else {
        resolve({ success: false, error: stderr || `Exit code: ${code}` });
      }
    });

    child.on('error', (e) => resolve({ success: false, error: e.message }));
  });
}

async function gitCommit(repoPath, message, options = {}) {
  return new Promise((resolve) => {
    try {
      execSync('git add .', { cwd: repoPath, stdio: 'ignore' });
      execSync(`git commit -m "${message}"`, { cwd: repoPath, stdio: 'ignore' });
      resolve({ success: true, message: 'Committed successfully' });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

async function gitPush(repoPath, remote = 'origin', branch = 'main') {
  return new Promise((resolve) => {
    const child = spawn('git', ['push', remote, branch], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function gitPull(repoPath, remote = 'origin', branch = 'main') {
  return new Promise((resolve) => {
    const child = spawn('git', ['pull', remote, branch], { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function gitStatus(repoPath) {
  return new Promise((resolve) => {
    try {
      const output = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8' });
      const lines = output.trim().split('\n').filter(Boolean);
      const status = {
        modified: [],
        added: [],
        deleted: [],
        untracked: [],
      };

      for (const line of lines) {
        const [statusCode, ...fileParts] = line.split(/\s+/);
        const file = fileParts.join(' ');
        if (statusCode.includes('M')) status.modified.push(file);
        if (statusCode.includes('A')) status.added.push(file);
        if (statusCode.includes('D')) status.deleted.push(file);
        if (statusCode.includes('??')) status.untracked.push(file);
      }

      resolve({ success: true, status });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

async function gitLog(repoPath, count = 10) {
  return new Promise((resolve) => {
    try {
      const output = execSync(`git log --oneline -${count}`, { cwd: repoPath, encoding: 'utf-8' });
      const commits = output.trim().split('\n').filter(Boolean).map((line) => {
        const [hash, ...msgParts] = line.split(/\s+/);
        return { hash, message: msgParts.join(' ') };
      });
      resolve({ success: true, commits });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

async function gitDiff(repoPath, options = {}) {
  return new Promise((resolve) => {
    try {
      const args = ['diff'];
      if (options.staged) args.push('--staged');
      if (options.file) args.push(options.file);

      const output = execSync(args.join(' '), { cwd: repoPath, encoding: 'utf-8' });
      resolve({ success: true, diff: output });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// ── GitHub API ──
async function githubCreatePullRequest(owner, repo, title, head, base = 'main', body = '') {
  const token = _env('GITHUB_TOKEN') || process.env.GITHUB_TOKEN;
  if (!token) return { error: 'GitHub token not configured.' };

  const https = require('https');
  return new Promise((resolve) => {
    const data = JSON.stringify({ title, head, base, body });
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/pulls`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'khy-os',
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (c) => { responseBody += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(responseBody) }); }
        catch { resolve({ status: res.statusCode, error: responseBody }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(data);
    req.end();
  });
}

async function githubListPullRequests(owner, repo, state = 'open') {
  const token = _env('GITHUB_TOKEN') || process.env.GITHUB_TOKEN;
  if (!token) return { error: 'GitHub token not configured.' };

  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/pulls?state=${state}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'khy-os',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, error: body }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'git', name: 'Git (Local)' },
  { id: 'github', name: 'GitHub' },
  { id: 'gitlab', name: 'GitLab' },
  { id: 'gitea', name: 'Gitea' },
];

function listProviders() {
  return PROVIDERS;
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'git': return true;
    case 'github': return !!(_env('GITHUB_TOKEN') || process.env.GITHUB_TOKEN);
    case 'gitlab': return !!(_env('GITLAB_TOKEN') || process.env.GITLAB_TOKEN);
    case 'gitea': return !!(_env('GITEA_TOKEN') || process.env.GITEA_TOKEN);
    default: return false;
  }
}

module.exports = {
  gitClone,
  gitCommit,
  gitPush,
  gitPull,
  gitStatus,
  gitLog,
  gitDiff,
  githubCreatePullRequest,
  githubListPullRequests,
  listProviders,
  isProviderConfigured,
  PROVIDERS,
};
