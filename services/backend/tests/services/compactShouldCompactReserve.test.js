'use strict';

/**
 * shouldCompact reserve clamping — on a short window the fixed 4096-token output
 * reserve used to swallow half the context, making compaction fire far too
 * early and leaving almost no room for real input. The reserve is now clamped
 * via contextProfile so a small window keeps a usable input budget.
 */

let compact;
try {
  compact = require('../../src/services/compact');
} catch {
  compact = null;
}

const _skip = !compact || typeof compact.shouldCompact !== 'function';
const descFn = _skip ? describe.skip : describe;

descFn('compact.shouldCompact reserve', () => {
  const { shouldCompact } = compact || {};

  // 12000 chars ≈ 3000 estimated tokens (4 chars/token).
  const msgs = [{ role: 'user', content: 'x'.repeat(12000) }];

  test('short 8k window does NOT over-compact (clamped reserve keeps input budget)', () => {
    // new reserve = min(4096, 8000*0.3)=2400 → available 5600 → 3000/5600 ≈ 0.54
    const r = shouldCompact(msgs, 8000);
    expect(r.estimatedTokens).toBe(3000);
    expect(r.needed).toBe(false);
    expect(r.urgency).toBe('none');
  });

  test('large 200k window behavior is unchanged (reserve passes through)', () => {
    // reserve stays 4096; 3000 tokens is nowhere near the threshold on 200k.
    const r = shouldCompact(msgs, 200000);
    expect(r.needed).toBe(false);
  });

  test('a genuinely full short window still triggers compaction', () => {
    // ~7000 tokens (28000 chars) on an 8k window / 5600 available → usage 1.25 → now
    const full = [{ role: 'user', content: 'y'.repeat(28000) }];
    const r = shouldCompact(full, 8000);
    expect(r.needed).toBe(true);
    expect(r.urgency).toBe('now');
  });
});
