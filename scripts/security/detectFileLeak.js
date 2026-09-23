#!/usr/bin/env node
'use strict';

/**
 * detectFileLeak.js — PreToolUse command hook: block secrets written to disk.
 *
 * Reads the event context JSON on stdin ({ toolName, params }) and exits 2 when
 * a file-writing tool is about to persist content matching a secret pattern.
 * A hook .js file is invoked directly (`cmd /c node <file>` / `sh -c node
 * <file>`), so exit code 2 propagates on BOTH Linux and Windows — unlike an
 * inline `node -e "..."` whose nested quoting cmd.exe swallows.
 *
 * The detection regexes are deliberately conservative (high-precision,
 * low-recall): a false positive merely asks the user to confirm a write, a
 * false negative leaks a key. Patterns mirror common provider key shapes plus
 * the literal strings that signal a key is being embedded.
 *
 * @module scripts/security/detectFileLeak
 */

// Tools that can write file content to disk (khyos tool names; see
// src/tools/* — writeFile/editFile/create_file/patch/multiedit).
const FILE_WRITE_TOOLS = new Set([
  'writeFile',
  'write_file',
  'FileWriteTool',
  'editFile',
  'edit_file',
  'FileEditTool',
  'create_file',
  'CreateFileTool',
  'patch',
  'ApplyPatchTool',
  'multiedit',
  'MultiEditTool',
]);

// Conservative secret patterns (high-precision). Each is a {re, label} pair;
// on a hit we report the label, not the matched value (do not echo the secret).
const SECRET_PATTERNS = [
  // OpenAI / Anthropic / generic provider key shapes
  { re: /\bsk-[a-zA-Z0-9_-]{20,}\b/, label: 'provider API key (sk-…)' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key ID' },
  { re: /\bxoxb-[a-zA-Z0-9-]{20,}\b/, label: 'Slack bot token' },
  { re: /\bghp_[a-zA-Z0-9]{36}\b/, label: 'GitHub personal access token' },
  // Key material embedded in a config-looking context (literal assignment)
  {
    re: /["']?(api[-_]?key|secret|token|passwd|password|authorization|bearer)["']?\s*[:=]\s*["'][a-zA-Z0-9+/=_-]{12,}["']/i,
    label: 'assigned credential literal',
  },
  // Private key headers (PEM / SSH)
  { re: /-----BEGIN (RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/, label: 'private key block' },
];

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

function extractContent(params) {
  if (!params || typeof params !== 'object') {
    return '';
  }
  // File-write tools carry the payload under content / text / patch / value.
  const candidates = [params.content, params.text, params.patch, params.value, params.fileContent];
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
  if (!FILE_WRITE_TOOLS.has(toolName)) {
    process.exit(0); // not a file-write tool — nothing to inspect
  }

  const content = extractContent(ctx.params);
  if (!content) {
    process.exit(0);
  }

  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(content)) {
      // Report the label only, never the matched value.
      process.stderr.write(
        `[khy:SecretLeakGuard] blocked ${toolName}: content matches "${label}". ` +
          'Strip the secret before writing; keys live in ~/.khyquant/config.json, not in files.'
      );
      process.exit(2);
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(0)); // fail-open on unexpected errors: never block on our own crash
