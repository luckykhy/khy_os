'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  splitSystemPromptAtBoundary,
  stripSystemPromptBoundary,
} = require('../src/constants/prompts');
const { resolveMessages } = require('../src/services/gateway/adapters/_messageBuilder');

const M = SYSTEM_PROMPT_DYNAMIC_BOUNDARY;

test('splitSystemPromptAtBoundary splits prefix/suffix and removes the marker', () => {
  const sys = `STATIC PREFIX CONTENT\n\n${M}\n\nDYNAMIC SUFFIX CONTENT`;
  const { staticPrefix, dynamicSuffix } = splitSystemPromptAtBoundary(sys);
  assert.strictEqual(staticPrefix, 'STATIC PREFIX CONTENT');
  assert.strictEqual(dynamicSuffix, 'DYNAMIC SUFFIX CONTENT');
  assert.ok(!staticPrefix.includes(M));
  assert.ok(!dynamicSuffix.includes(M));
});

test('splitSystemPromptAtBoundary with no marker → empty prefix, whole text as suffix', () => {
  const sys = 'PLAIN SYSTEM PROMPT WITH NO MARKER';
  const { staticPrefix, dynamicSuffix } = splitSystemPromptAtBoundary(sys);
  assert.strictEqual(staticPrefix, '');
  assert.strictEqual(dynamicSuffix, sys);
});

test('stripSystemPromptBoundary removes the marker entirely', () => {
  const sys = `A\n\n${M}\n\nB`;
  const out = stripSystemPromptBoundary(sys);
  assert.ok(!out.includes(M), 'marker removed');
  assert.ok(out.includes('A') && out.includes('B'), 'content preserved');
});

test('stripSystemPromptBoundary is a no-op without the marker', () => {
  const sys = 'no marker here';
  assert.strictEqual(stripSystemPromptBoundary(sys), sys);
});

test('resolveMessages (openai protocol) NEVER emits the marker on the wire', () => {
  const sys = `STATIC\n\n${M}\n\nDYNAMIC`;
  const { messages, system } = resolveMessages('hi', { system: sys, messages: [] }, { protocol: 'openai' });
  assert.ok(!system.includes(M), 'returned system has no marker');
  const systemMsg = messages.find((m) => m.role === 'system');
  assert.ok(systemMsg, 'system message present');
  assert.ok(!String(systemMsg.content).includes(M), 'system message content has no marker');
});

test('resolveMessages (anthropic protocol) NEVER emits the marker on the wire', () => {
  const sys = `STATIC\n\n${M}\n\nDYNAMIC`;
  const { system } = resolveMessages('hi', { system: sys, messages: [] }, { protocol: 'anthropic' });
  assert.ok(!system.includes(M), 'returned system has no marker');
  assert.ok(system.includes('STATIC') && system.includes('DYNAMIC'), 'content preserved');
});

test('the Anthropic-native body-split shape: only the prefix block carries cache_control', () => {
  // Mirror the body construction in claudeAdapter (native path).
  const system = `STATIC PREFIX\n\n${M}\n\nDYNAMIC SUFFIX`;
  const split = splitSystemPromptAtBoundary(system);
  let systemPart;
  if (split.staticPrefix) {
    systemPart = [{ type: 'text', text: split.staticPrefix, cache_control: { type: 'ephemeral' } }];
    if (split.dynamicSuffix) systemPart.push({ type: 'text', text: split.dynamicSuffix });
  } else {
    const plain = split.dynamicSuffix;
    systemPart = plain.length > 500
      ? [{ type: 'text', text: plain, cache_control: { type: 'ephemeral' } }]
      : plain;
  }
  assert.ok(Array.isArray(systemPart));
  assert.strictEqual(systemPart.length, 2);
  assert.deepStrictEqual(systemPart[0].cache_control, { type: 'ephemeral' });
  assert.strictEqual(systemPart[1].cache_control, undefined);
  assert.ok(!systemPart[0].text.includes(M) && !systemPart[1].text.includes(M));
});

test('no-marker system falls back to single-block behavior (>500 chars cached)', () => {
  const big = 'x'.repeat(600);
  const split = splitSystemPromptAtBoundary(big);
  assert.strictEqual(split.staticPrefix, '');
  const plain = split.dynamicSuffix;
  const systemPart = plain.length > 500
    ? [{ type: 'text', text: plain, cache_control: { type: 'ephemeral' } }]
    : plain;
  assert.ok(Array.isArray(systemPart));
  assert.strictEqual(systemPart.length, 1);
  assert.deepStrictEqual(systemPart[0].cache_control, { type: 'ephemeral' });
});
