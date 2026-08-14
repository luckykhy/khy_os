/**
 * Shell Classifier — semantic analysis of shell commands.
 *
 * Classifies shell commands (including pipelines) as search, read, write,
 * or list operations. Used by shellCommand tool for dynamic isReadOnly
 * checks and by the permission system for smarter auto-approval.
 *
 * Also provides device path blocking to prevent reads of infinite or
 * blocking device files.
 */

// ── Command Classification Sets ────────────────────────────────────

const SEARCH_COMMANDS = new Set([
  'find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis',
]);

const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'wc', 'stat', 'file', 'strings',
  'jq', 'awk', 'cut', 'sort', 'uniq', 'tr',
  // Cross-platform read-only diagnostics whose base command name has no
  // mutating form — purely report system/host state, never change it.
  'systeminfo', 'hostname', 'whoami', 'ver', 'uname', 'id',
  'arch', 'date', 'uptime', 'getconf', 'lscpu', 'nproc',
]);

const LIST_COMMANDS = new Set([
  'ls', 'dir', 'tree', 'du', 'df',
  // Read-only enumerations of processes / block devices.
  'tasklist', 'ps', 'lsblk',
]);

const NEUTRAL_COMMANDS = new Set([
  'echo', 'printf', 'true', 'false', ':',
]);

// ── Verb-gated read-only commands ──────────────────────────────────
//
// Some commands are read-only ONLY with a query subcommand and otherwise
// mutate state (e.g. `wmic ... get` reads, `wmic ... call create` runs a
// method). We must never whitelist the base name outright. Each predicate
// receives the lowercased token list of a single command part (no pipes)
// and returns true ONLY when that invocation is read-only.
const READONLY_VERB_GATED = new Map([
  // `wmic <alias> get ...` / `wmic <alias> list ...` read; reject any
  // method/mutation verb regardless of position.
  ['wmic', (tokens) => {
    const t = tokens.slice(1); // drop the leading "wmic"
    const mutating = ['call', 'create', 'delete', 'set', 'terminate', 'assoc'];
    if (t.some((x) => mutating.includes(x))) return false;
    return t.includes('get') || t.includes('list');
  }],
  // `reg query ...` reads; `reg add|delete|import|...` mutate.
  ['reg', (tokens) => tokens[1] === 'query'],
  // `sc query|queryex ...` reads; `sc create|delete|config|start|stop` mutate.
  ['sc', (tokens) => tokens[1] === 'query' || tokens[1] === 'queryex'],
  // `systemctl status|show|is-active|...` read; `start|stop|enable|...` mutate.
  ['systemctl', (tokens) => [
    'status', 'show', 'is-active', 'is-enabled',
    'list-units', 'list-unit-files', 'cat', 'get-default',
  ].includes(tokens[1])],
]);

const SILENT_COMMANDS = new Set([
  'mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown',
  'ln', 'touch', 'install',
]);

// ── Device Path Blocking ───────────────────────────────────────────

const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',       // infinite output
  '/dev/random',     // infinite output / blocks
  '/dev/urandom',    // infinite output
  '/dev/full',       // infinite output
  '/dev/stdin',      // blocks waiting for input
  '/dev/tty',        // blocks waiting for input
  '/dev/console',    // blocks waiting for input
  '/dev/stdout',     // meaningless read
  '/dev/stderr',     // meaningless read
  '/dev/fd/0',       // fd alias (stdin)
  '/dev/fd/1',       // fd alias (stdout)
  '/dev/fd/2',       // fd alias (stderr)
]);

/**
 * Check if a file path is a blocked device path.
 * @param {string} filePath
 * @returns {boolean}
 */
function isBlockedDevicePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\/+$/, '');
  return BLOCKED_DEVICE_PATHS.has(normalized);
}

// ── Pipeline Semantic Analysis ─────────────────────────────────────

const OPERATORS = new Set(['|', '||', '&&', ';']);
const REDIRECT_OPS = new Set(['>', '>>', '2>', '2>>', '&>', '&>>']);

/**
 * Split a shell command string into parts preserving operators.
 * @param {string} command
 * @returns {string[]}
 */
function splitCommandWithOperators(command) {
  if (!command || typeof command !== 'string') return [];

  const parts = [];
  let current = '';
  let inQuote = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Handle quotes
    if ((ch === '"' || ch === "'") && (i === 0 || command[i - 1] !== '\\')) {
      if (inQuote === ch) { inQuote = null; }
      else if (!inQuote) { inQuote = ch; }
      current += ch;
      continue;
    }

    if (inQuote) {
      current += ch;
      continue;
    }

    // Handle operators
    if (ch === '|' || ch === '&' || ch === ';') {
      if (current.trim()) parts.push(current.trim());
      current = '';

      // Check for || or &&
      if (i + 1 < command.length && command[i + 1] === ch && (ch === '|' || ch === '&')) {
        parts.push(ch + ch);
        i++;
      } else {
        parts.push(ch);
      }
      continue;
    }

    // Handle redirects
    if (ch === '>' || (ch === '2' && i + 1 < command.length && command[i + 1] === '>')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      let op = ch;
      while (i + 1 < command.length && (command[i + 1] === '>' || command[i + 1] === '&')) {
        op += command[++i];
      }
      parts.push(op);
      continue;
    }

    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  return parts;
}

/**
 * Extract the base command name from a command string.
 * Handles env prefixes, sudo, path prefixes.
 *
 * @param {string} cmd - Single command (no pipes/operators)
 * @returns {string} Base command name
 */
function getBaseCommand(cmd) {
  if (!cmd) return '';
  const tokens = cmd.trim().split(/\s+/);

  let i = 0;
  // Skip environment variable assignments (FOO=bar cmd)
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  // Skip sudo/env prefixes
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'env')) i++;

  if (i >= tokens.length) return '';

  // Extract basename from path (e.g., /usr/bin/grep → grep)
  const full = tokens[i];
  const slash = full.lastIndexOf('/');
  return slash >= 0 ? full.slice(slash + 1) : full;
}

/**
 * Return the lowercased token list of a single command part, starting at the
 * real command (env assignments + sudo/env prefixes skipped, path basename
 * applied to the command). Used by verb-gated read-only predicates.
 *
 * @param {string} cmd - Single command (no pipes/operators)
 * @returns {string[]}
 */
function getCommandTokens(cmd) {
  if (!cmd) return [];
  const tokens = cmd.trim().split(/\s+/);

  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'env')) i++;
  if (i >= tokens.length) return [];

  const rest = tokens.slice(i).map((t) => t.toLowerCase());
  const slash = rest[0].lastIndexOf('/');
  if (slash >= 0) rest[0] = rest[0].slice(slash + 1);
  return rest;
}

/**
 * Analyze a shell command (including pipelines) for its semantic nature.
 *
 * Rules:
 * - All non-neutral commands in the pipeline must be search/read/list
 *   for the whole pipeline to be classified as such.
 * - Redirect targets (> file) cause the pipeline to NOT be read-only.
 * - A single write command makes the whole pipeline non-read.
 *
 * @param {string} command - Full shell command (may include pipes)
 * @returns {{ isSearch: boolean, isRead: boolean, isList: boolean }}
 */
function isSearchOrReadCommand(command) {
  if (!command || typeof command !== 'string') {
    return { isSearch: false, isRead: false, isList: false };
  }

  const parts = splitCommandWithOperators(command);
  if (parts.length === 0) {
    return { isSearch: false, isRead: false, isList: false };
  }

  let hasSearch = false;
  let hasRead = false;
  let hasList = false;
  let skipNext = false;

  for (const part of parts) {
    // Skip redirect targets
    if (skipNext) {
      skipNext = false;
      continue;
    }

    // Redirect operators → next part is a target, and this is a write
    if (REDIRECT_OPS.has(part)) {
      return { isSearch: false, isRead: false, isList: false };
    }

    // Skip pipeline/logic operators
    if (OPERATORS.has(part)) continue;

    const base = getBaseCommand(part);
    if (!base) continue;

    // Neutral commands don't affect classification
    if (NEUTRAL_COMMANDS.has(base)) continue;

    // Verb-gated commands: read-only only with a query subcommand. The
    // predicate decides per-invocation; a mutating form falls through to the
    // non-read return below (whole pipeline is not read-only).
    if (READONLY_VERB_GATED.has(base)) {
      if (READONLY_VERB_GATED.get(base)(getCommandTokens(part))) {
        hasRead = true;
        continue;
      }
      return { isSearch: false, isRead: false, isList: false };
    }

    // Check classification
    const isPartSearch = SEARCH_COMMANDS.has(base);
    const isPartRead = READ_COMMANDS.has(base);
    const isPartList = LIST_COMMANDS.has(base);

    if (!isPartSearch && !isPartRead && !isPartList) {
      // Non-neutral, non-read/search command → whole pipeline is not read-only
      return { isSearch: false, isRead: false, isList: false };
    }

    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
    if (isPartList) hasList = true;
  }

  return { isSearch: hasSearch, isRead: hasRead, isList: hasList };
}

module.exports = {
  isSearchOrReadCommand,
  isBlockedDevicePath,
  getBaseCommand,
  getCommandTokens,
  splitCommandWithOperators,
  SEARCH_COMMANDS,
  READ_COMMANDS,
  LIST_COMMANDS,
  NEUTRAL_COMMANDS,
  SILENT_COMMANDS,
  READONLY_VERB_GATED,
  BLOCKED_DEVICE_PATHS,
};
