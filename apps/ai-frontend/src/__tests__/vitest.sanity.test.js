import { describe, it, expect } from 'vitest';

/**
 * Vitest sanity test — verifies the test runner itself is configured.
 * Add domain-specific tests alongside this file using the same pattern.
 */

describe('frontend test infrastructure', () => {
  it('vitest is correctly configured', () => {
    expect(true).toBe(true);
  });

  it('can import Vue', async () => {
    const vue = await import('vue');
    expect(vue).toBeDefined();
    expect(typeof vue.createApp).toBe('function');
  });
});
