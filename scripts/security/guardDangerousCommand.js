#!/usr/bin/env node
'use strict';

/**
 * guardDangerousCommand.js — PreToolUse command hook: block destructive shell
 * invocations before they run.
 *
 * Reads the event context JSON on stdin ({ toolName, params }) and exits 2 when
 * a shell-exec tool is about to run a destructive command. A hook .js file is
 * invoked directly (`cmd /c node <file>` / `sh -c node <file>`), so exit code
 * 2 propagates on BOTH Linux and Windows — unlike an inline `node -e "..."`
 * whose nested quoting cmd.exe swallows.
 *
 * Conservative, high-precision: only clearly destructive forms block; anything
 * else passes. The matched command is echoed so the user sees what was stopped.
 *
 * @module scripts/security/guardDangerousCommand
 */

const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'exec',
  'execute',
  'run',
  'terminal',
  'shellExec',
  'BashTool',
  'ShellTool',
  'ExecuteTool',
]);

function isShellTool(name) {
  if (SHELL_TOOLS.has(name)) {
    return true;
  }
  return /bash|shell|exec|terminal|command/i.test(String(name || ''));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (d) => {
      data += d;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function extractCommand(params, toolName) {
  if (!params || typeof params !== 'object') {
    return '';
  }
  // Shell tools carry the command under command / cmd / script / input / code.
  const candidates = [params.command, params.cmd, params.script, params.input, params.code];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return c;
    }
  }
  return '';
}

async function main() {
  const raw = await readStdin();
  let ctx = {};
  try {
    ctx = JSON.parse(raw || '{}');
  } catch {
    ctx = {};
  }

  const toolName = String(ctx.toolName || '');
  if (!isShellTool(toolName)) {
    process.exit(0);
  }

  const cmd = extractCommand(ctx.params, toolName);
  if (!cmd) {
    process.exit(0);
  }

  // High-precision destructive forms. Escaped so the patterns are read as
  // intended inside a JS string; the command is a single line here.
  const DESTRUCTIVE = [
    /rm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+\//, // rm -rf /
    /rm\s+(-[a-z]*r[a-z]*f[a-z]*f[a-z]*)\s+~?\/?(Users|home|Program\s+Files|C:\\\s*$)/i,
    /rm\s+(-[a-z]*r[a-z]*f[a-z]*)\s+\.(khy|khyquant|claude)(\s|$)/, // wipe config dirs
    /format\s+[A-Z]:/i, // format C:
    /del\s+\/[sfq]\s+[A-Z]:\\/i,
    /Remove-Item\s+.*-Recurse\s+.*-Force/i,
  ];

  for (const re of DESTRUCTIVE) {
    if (re.test(cmd)) {
      const snippet = cmd.replace(/\s+/g, ' ').slice(0, 80);
      process.stderr.write(`[khy:DangerousCommandGuard] blocked ${toolName}: "${snippet}"`);
      process.exit(2);
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(0)); // fail-open on unexpected errors: never block on our own crash
