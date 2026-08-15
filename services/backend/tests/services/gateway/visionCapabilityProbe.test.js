'use strict';

const test = require('node:test');
const assert = require('node:assert');
const probe = require('../../../src/services/gateway/visionCapabilityProbe');

test('vision probe: observed visual attributes mean supported', () => {
  const result = probe.interpretProbeResult({ success: true, content: 'red, blue' });
  assert.deepStrictEqual(result, {
    verdict: 'supported',
    reason: 'probe_visual_attributes_observed',
  });
});

test('vision probe: explicit image rejection means unsupported', () => {
  const result = probe.interpretProbeResult({
    success: false,
    error: 'model does not support image input',
  });
  assert.deepStrictEqual(result, {
    verdict: 'unsupported',
    reason: 'upstream_rejected_image_input',
  });
});

test('vision probe: transient failures remain unknown', () => {
  for (const result of [
    { success: false, error: 'timeout' },
    { success: false, error: '401 unauthorized' },
    { success: false, error: '429 rate limit' },
    { success: true, content: '' },
    { success: true, content: 'I can help with that.' },
  ]) {
    assert.strictEqual(probe.interpretProbeResult(result).verdict, 'unknown');
  }
});

test('vision probe: supported and unsupported TTLs are distinct', () => {
  const now = 1_000_000;
  assert.strictEqual(
    probe.shouldReprobe({ verdict: 'supported', measuredAt: now - 100 }, { KHY_VISION_CAP_SUPPORTED_TTL_MS: '200' }, now),
    false
  );
  assert.strictEqual(
    probe.shouldReprobe({ verdict: 'unsupported', measuredAt: now - 201 }, { KHY_VISION_CAP_TTL_MS: '200' }, now),
    true
  );
  assert.strictEqual(probe.shouldReprobe({ verdict: 'unknown', measuredAt: now }, {}, now), true);
});
