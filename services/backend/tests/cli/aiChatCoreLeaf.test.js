'use strict';

/**
 * Leaf-contract test for aiChatCore.js (the chat mega-construct isolated from cli/ai.js).
 *
 * Governance (god-file split, "isolation-as-goal" + user-approved Option C): cli/ai.js grew past the 2500-line
 * budget. `chat()` plus its task-classification / structured-message / capability / context-overflow cluster
 * (original ai.js lines 2239..5957) shares 12 reassigned module `let`s with the surrounding stateless helpers,
 * so it could NOT be split byte-identically. Per Option C the 12 shared bindings live in the required-once
 * ./aiChatState singleton, the chat band is relocated into aiChatCore.js, and the 40 host-defined names the
 * band calls are injected once at host load via setAiChatCoreDeps (before chat() ever runs) to avoid a require
 * cycle. The host cli/ai.js imports the 6 names the band defines that it re-exports/references.
 *
 * Proves: (1) the core exports its 6 host-facing names + the DI setter; (2) the public entry cli/ai.js
 * re-exports the stable surface and its `chat`/`checkModelCapability` are the exact identities the core
 * provides (wiring intact); (3) setAiChatCoreDeps is a guarded, idempotent, non-throwing DI setter (40
 * bindings via `!== undefined` guards); (4) the shared ./aiChatState singleton is the same object both modules
 * see, so a mutation propagates (this is what makes the non-byte-identical split behave like the monolith).
 *
 * chat() drives model calls / network / timers, so this test stays on the deterministic surface (export shape,
 * wiring identity, setter guard, state singleton) and never invokes a turn. Behavioural coverage lives in the
 * aiCli.* / chatStateIsolation / taskDifficultyScaffolding suites, which exercise the band through the host.
 */
const test = require('node:test');
const assert = require('node:assert');

const CORE = '../../src/cli/aiChatCore';
const HOST = '../../src/cli/ai';
const STATE = '../../src/cli/aiChatState';

const BACKREF = ['chat', '_stripHarnessScaffolding', '_assessTaskDifficulty', '_buildStructuredMessages',
  '_isContextOverflowFailure', 'checkModelCapability'];

test('core exports its host-facing surface + DI setter', () => {
  const core = require(CORE);
  assert.strictEqual(typeof core.setAiChatCoreDeps, 'function');
  for (const n of BACKREF) assert.strictEqual(typeof core[n], 'function', `core must export ${n}`);
  assert.strictEqual(core.chat.constructor.name, 'AsyncFunction');
});

test('public entry re-exports the stable surface; wiring identity is the core', () => {
  const host = require(HOST);
  const core = require(CORE);
  // Top-level surface stays intact.
  assert.strictEqual(typeof host.chat, 'function');
  assert.strictEqual(typeof host.getAiStatus, 'function');
  // The chat entry and capability checker resolve to the exact identities the core provides (core destructured
  // into the host), proving the isolated band is wired into the live surface and is not a dead copy.
  assert.strictEqual(host.chat, core.chat, 'host.chat must be the core chat (wiring intact)');
  assert.strictEqual(host.checkModelCapability, core.checkModelCapability,
    'host.checkModelCapability must be the core function (wiring intact)');
  // Test-only helpers relocated into the core are still reachable through the host __test__ surface.
  assert.strictEqual(typeof host.__test__._stripHarnessScaffolding, 'function');
  assert.strictEqual(typeof host.__test__._salvageRecentToolResult, 'function');
});

test('setAiChatCoreDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setAiChatCoreDeps } = require(CORE);
  assert.doesNotThrow(() => setAiChatCoreDeps());
  assert.doesNotThrow(() => setAiChatCoreDeps({}));
  const fn = () => {};
  const deps = {
    MAX_HISTORY: 80, EFFORT_PRESETS: {}, MODEL_CAPABILITIES: {}, COT_INJECTION_PROMPT: 'x',
    getService: fn, getGateway: fn, getSecurityDir: fn, getContextLimit: fn, getChatLatencyAutoTuner: fn,
    _getModelInfo: fn, _ensureLiveSessionId: fn, _persistLiveSession: fn,
  };
  assert.doesNotThrow(() => setAiChatCoreDeps(deps));
  assert.doesNotThrow(() => setAiChatCoreDeps(deps));
});

test('the shared aiChatState singleton is the same object both modules require', () => {
  // Loading the host wires everything; the state module must be a required-once singleton so property
  // reads/writes propagate across ai.js and aiChatCore.js (the mechanism that replaces the shared module lets).
  require(HOST);
  const s1 = require(STATE);
  const s2 = require(STATE);
  assert.strictEqual(s1, s2, 'aiChatState must be a cached singleton');
  // Expected shape (12 shared bindings) with the original initial values.
  for (const k of ['gateway', 'messages', 'studyMode', 'gatewayPreflightDone', 'gatewayPreflightInFlight',
    'pendingTaskGuard', 'lastSubstantivePrompt', 'lastSubstantiveAt', 'primedSessionId', 'lastPrimeTopicTokens',
    'currentEffort', 'thinkingEnabled']) {
    assert.ok(Object.prototype.hasOwnProperty.call(s1, k), `state must hold ${k}`);
  }
  assert.strictEqual(s1.currentEffort, 'medium');
  assert.strictEqual(s1.thinkingEnabled, true);
  assert.ok(Array.isArray(s1.messages));
  // A mutation is observed through a fresh require (proves single shared reference).
  const prev = s1.studyMode;
  s1.studyMode = !prev;
  assert.strictEqual(require(STATE).studyMode, !prev);
  s1.studyMode = prev;
});
