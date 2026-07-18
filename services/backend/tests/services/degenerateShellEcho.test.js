'use strict';

// Unit tests for degenerateShellEcho — dropping no-op "echo of prose" shell
// dispatches before they run. Pure + env-explicit, so no loop/network needed.

const test = require('node:test');
const assert = require('node:assert');
const leaf = require('../../src/services/degenerateShellEcho');

const ON = {}; // empty env → gate default ON

test('the exact transcript case is degenerate', () => {
  assert.strictEqual(leaf.isDegenerateProseEcho('echo "好的，给你讲个笑话："'), true);
});

test('CJK prose echoes (quoted and bare) are degenerate', () => {
  assert.strictEqual(leaf.isDegenerateProseEcho('echo "这是一句话"'), true);
  assert.strictEqual(leaf.isDegenerateProseEcho("echo '再来一个笑话'"), true);
  assert.strictEqual(leaf.isDegenerateProseEcho('echo 讲个笑话'), true);
});

test('multi-word latin prose echo is degenerate', () => {
  assert.strictEqual(leaf.isDegenerateProseEcho('echo "here is a joke"'), true);
  assert.strictEqual(leaf.isDegenerateProseEcho('echo hello world'), true);
});

test('echo flags (-e/-n/-E) are stripped before judging', () => {
  assert.strictEqual(leaf.isDegenerateProseEcho('echo -n "好的"'), true);
  assert.strictEqual(leaf.isDegenerateProseEcho('echo -e "a b"'), true);
});

test('echo with ANY shell operator is KEPT (has real purpose)', () => {
  const kept = [
    'echo "hello" > out.txt',        // redirection
    'echo "x" >> log',               // append
    'echo "y" | grep y',             // pipe
    'echo $HOME',                    // variable expansion
    'echo "$(date)"',                // command substitution
    'echo "${VAR}"',                 // brace expansion
    'echo `whoami`',                 // backtick
    'echo "a" && ls',                // chaining
    'echo "a"; ls',                  // sequencing
    'echo -e "a\\nb"',               // escape sequence (backslash)
    'echo "read" < in.txt',          // input redirection
  ];
  for (const cmd of kept) {
    assert.strictEqual(leaf.isDegenerateProseEcho(cmd), false, cmd);
  }
});

test('bare single-token echo is KEPT (sentinel marker, conservative)', () => {
  assert.strictEqual(leaf.isDegenerateProseEcho('echo done'), false);
  assert.strictEqual(leaf.isDegenerateProseEcho('echo OK'), false);
  assert.strictEqual(leaf.isDegenerateProseEcho('echo'), false);
});

test('non-echo commands are never degenerate', () => {
  assert.strictEqual(leaf.isDegenerateProseEcho('ls -la'), false);
  assert.strictEqual(leaf.isDegenerateProseEcho('printf "hi"'), false);
  assert.strictEqual(leaf.isDegenerateProseEcho('echofoo bar'), false); // word boundary
});

test('filterDegenerateEchoCalls removes only degenerate shell echoes', () => {
  const calls = [
    { name: 'shell_command', params: { command: 'echo "好的，给你讲个笑话："' } },
    { name: 'shell_command', params: { command: 'ls ~/Desktop' } },
    { name: 'bash', params: { command: 'echo "log" > f.txt' } }, // kept: redirection
    { name: 'read_file', params: { path: 'echo "not a shell echo"' } }, // non-shell: kept
  ];
  const res = leaf.filterDegenerateEchoCalls(calls, ON);
  assert.strictEqual(res.dropped, 1);
  assert.strictEqual(res.toolCalls.length, 3);
  assert.ok(!res.toolCalls.some((c) => c.params.command === 'echo "好的，给你讲个笑话："'));
});

test('dropping the only call yields an empty array (loop delivers text reply)', () => {
  const calls = [{ name: 'shell_command', params: { command: 'echo "讲个笑话"' } }];
  const res = leaf.filterDegenerateEchoCalls(calls, ON);
  assert.strictEqual(res.dropped, 1);
  assert.deepStrictEqual(res.toolCalls, []);
});

test('no degenerate calls → SAME array reference returned (byte-revert, no realloc)', () => {
  const calls = [{ name: 'shell_command', params: { command: 'ls' } }];
  const res = leaf.filterDegenerateEchoCalls(calls, ON);
  assert.strictEqual(res.toolCalls, calls);
  assert.strictEqual(res.dropped, 0);
});

test('KHY_DROP_DEGENERATE_ECHO=0 byte-reverts (degenerate echo kept)', () => {
  const calls = [{ name: 'shell_command', params: { command: 'echo "讲个笑话"' } }];
  const res = leaf.filterDegenerateEchoCalls(calls, { KHY_DROP_DEGENERATE_ECHO: '0' });
  assert.strictEqual(res.toolCalls, calls);
  assert.strictEqual(res.dropped, 0);
});

test('fail-soft: non-array / bad input never throws', () => {
  assert.doesNotThrow(() => leaf.filterDegenerateEchoCalls(null, ON));
  assert.doesNotThrow(() => leaf.filterDegenerateEchoCalls(undefined, ON));
  assert.strictEqual(leaf.isDegenerateProseEcho(null), false);
  assert.strictEqual(leaf.isDegenerateProseEcho(undefined), false);
  assert.strictEqual(leaf.isDegenerateProseEcho(''), false);
});

test('multiple degenerate echoes (the retry-loop shape) all dropped', () => {
  const same = 'echo "好的，给你讲个笑话："';
  const calls = [
    { name: 'shell_command', params: { command: same } },
    { name: 'shell_command', params: { command: same } },
    { name: 'shell_command', params: { command: same } },
  ];
  const res = leaf.filterDegenerateEchoCalls(calls, ON);
  assert.strictEqual(res.dropped, 3);
  assert.deepStrictEqual(res.toolCalls, []);
});

// #4 linkage: the transcript's duplicate joke render was iteration-1 (streamed
// text + echo call) → echo ran → iteration-2 restated the whole reply. Emptying
// toolCalls is what makes the loop conclude in iteration 1 (toolUseLoop.js:3884
// `if (toolCalls.length === 0)`), so there is no second iteration and no restate.
// This asserts the precondition for that conclusion: a text turn whose ONLY tool
// call is a degenerate echo yields zero calls after filtering.
test('#4: a joke turn with only a degenerate echo → zero calls (loop concludes, no restate)', () => {
  const jokeTurn = [{ name: 'shell_command', params: { command: 'echo "好的，给你讲个笑话："' } }];
  const res = leaf.filterDegenerateEchoCalls(jokeTurn, ON);
  assert.strictEqual(res.toolCalls.length, 0, 'loop will see length===0 and take the streamed reply as final');
});

// Streaming-path (R2) linkage: filterDegenerateEchoCalls only runs at the
// non-streaming toolCalls-array seam (toolUseLoop.js). The TUI adapter-native
// `tool_use` chunk path (useQueryBridge.js) never reaches that seam — the echo
// still executes there — but its turn-ack / preface / progress narration must be
// suppressed by the SAME predicate + SAME gate. The predicate is the SSOT both
// paths consume; this asserts the exact value the streaming handler branches on.
test('R2: isDegenerateProseEcho is the streaming-path SSOT (true for joke echo, false for meaningful)', () => {
  // the streaming handler reads chunk.input.command / .cmd, mirror that shape
  const jokeCmd = 'echo "好的，给你讲个笑话："';
  const meaningfulCmd = 'echo "log line" >> run.log';
  assert.strictEqual(leaf.isDegenerateProseEcho(jokeCmd), true, 'narration suppressed on the joke turn');
  assert.strictEqual(leaf.isDegenerateProseEcho(meaningfulCmd), false, 'redirecting echo keeps its narration');
});

// R3: bare whole-command no-ops (`true`, `:`, bare `cat`) are degenerate too.
test('bare no-op builtins true / : / cat are degenerate', () => {
  assert.strictEqual(leaf.isDegenerateNoOp('true'), true);
  assert.strictEqual(leaf.isDegenerateNoOp(':'), true);
  assert.strictEqual(leaf.isDegenerateNoOp('cat'), true);
  assert.strictEqual(leaf.isDegenerateNoOp('  true  '), true); // trimmed
});

test('no-op builtins WITH any shell operator are KEPT (real purpose)', () => {
  const kept = [
    'true > flag.txt',     // truncates a file
    'true && ls',          // chains
    ': > empty.log',       // idiomatic file truncation
    'cat << EOF',          // heredoc
    'cat file.txt',        // reads a real file (has an arg → not bare)
    'cat | grep x',        // pipe
    'true; ls',            // sequencing
  ];
  for (const cmd of kept) {
    assert.strictEqual(leaf.isDegenerateNoOp(cmd), false, cmd);
  }
});

test('no-op detection is exact-token (truthy/catalog/: substrings are not matched)', () => {
  const kept = ['truthy', 'truecolor', 'catalog', 'category', 'catnip', 'true false', ':: double'];
  for (const cmd of kept) {
    assert.strictEqual(leaf.isDegenerateNoOp(cmd), false, cmd);
  }
});

test('isDegenerateNoOp is the union: prose echo OR bare no-op', () => {
  assert.strictEqual(leaf.isDegenerateNoOp('echo "讲个笑话"'), true, 'prose echo branch');
  assert.strictEqual(leaf.isDegenerateNoOp('true'), true, 'bare no-op branch');
  assert.strictEqual(leaf.isDegenerateNoOp('ls -la'), false, 'neither');
});

test('filterDegenerateEchoCalls drops bare no-op shell calls too', () => {
  const calls = [
    { name: 'shell_command', params: { command: 'true' } },
    { name: 'bash', params: { command: ':' } },
    { name: 'shell_command', params: { command: 'cat' } },
    { name: 'shell_command', params: { command: 'cat report.txt' } }, // has arg → kept
    { name: 'shell_command', params: { command: 'true > f' } },       // redirection → kept
  ];
  const res = leaf.filterDegenerateEchoCalls(calls, ON);
  assert.strictEqual(res.dropped, 3);
  assert.strictEqual(res.toolCalls.length, 2);
});

test('R3 fail-soft: isDegenerateNoOp never throws on bad input', () => {
  assert.strictEqual(leaf.isDegenerateNoOp(null), false);
  assert.strictEqual(leaf.isDegenerateNoOp(undefined), false);
  assert.strictEqual(leaf.isDegenerateNoOp(''), false);
});

