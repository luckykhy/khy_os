'use strict';
const {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  splitSystemPromptAtBoundary,
  stripSystemPromptBoundary,
} = require('../src/constants/prompts');
const { resolveMessages } = require('../src/services/gateway/adapters/_messageBuilder');
const M = SYSTEM_PROMPT_DYNAMIC_BOUNDARY;

describe('System Prompt Split', () => {
  test('splitSystemPromptAtBoundary splits prefix/suffix and removes the marker', () => {
      const sys = `STATIC PREFIX CONTENT\n\n${M}\n\nDYNAMIC SUFFIX CONTENT`;
      const { staticPrefix, dynamicSuffix } = splitSystemPromptAtBoundary(sys);
      expect(staticPrefix).toBe('STATIC PREFIX CONTENT');
      expect(dynamicSuffix).toBe('DYNAMIC SUFFIX CONTENT');
      expect(!staticPrefix).toContain(M);
      expect(!dynamicSuffix).toContain(M);
  });

  test('splitSystemPromptAtBoundary with no marker â†?empty prefix, whole text as suffix', () => {
      const sys = 'PLAIN SYSTEM PROMPT WITH NO MARKER';
      const { staticPrefix, dynamicSuffix } = splitSystemPromptAtBoundary(sys);
      expect(staticPrefix).toBe('');
      expect(dynamicSuffix).toBe(sys);
  });

  test('stripSystemPromptBoundary removes the marker entirely', () => {
      const sys = `A\n\n${M}\n\nB`;
      const out = stripSystemPromptBoundary(sys);
      expect(!out.includes(M)).toBeTruthy();
      expect(out.includes('A') && out.includes('B')).toBeTruthy();
  });

  test('stripSystemPromptBoundary is a no-op without the marker', () => {
      const sys = 'no marker here';
      expect(stripSystemPromptBoundary(sys)).toBe(sys);
  });

  test('resolveMessages (openai protocol) NEVER emits the marker on the wire', () => {
      const sys = `STATIC\n\n${M}\n\nDYNAMIC`;
      const { messages, system } = resolveMessages('hi', { system: sys, messages: [] }, { protocol: 'openai' });
      expect(!system.includes(M)).toBeTruthy();
      const systemMsg = messages.find((m) => m.role === 'system');
      expect(systemMsg).toBeTruthy();
      expect(!String(systemMsg.content).includes(M)).toBeTruthy();
  });

  test('resolveMessages (anthropic protocol) NEVER emits the marker on the wire', () => {
      const sys = `STATIC\n\n${M}\n\nDYNAMIC`;
      const { system } = resolveMessages('hi', { system: sys, messages: [] }, { protocol: 'anthropic' });
      expect(!system.includes(M)).toBeTruthy();
      expect(system.includes('STATIC') && system.includes('DYNAMIC')).toBeTruthy();
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
      expect(Array.isArray(systemPart).toBeTruthy());
      expect(systemPart.length).toBe(2);
      expect(systemPart[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(systemPart[1].cache_control).toBe(undefined);
      expect(!systemPart[0].text.includes(M) && !systemPart[1].text).toContain(M);
  });

  test('no-marker system falls back to single-block behavior (>500 chars cached)', () => {
      const big = 'x'.repeat(600);
      const split = splitSystemPromptAtBoundary(big);
      expect(split.staticPrefix).toBe('');
      const plain = split.dynamicSuffix;
      const systemPart = plain.length > 500
        ? [{ type: 'text', text: plain, cache_control: { type: 'ephemeral' } }]
        : plain;
      expect(Array.isArray(systemPart).toBeTruthy());
      expect(systemPart.length).toBe(1);
      expect(systemPart[0].cache_control).toEqual({ type: 'ephemeral' });
  });

});

