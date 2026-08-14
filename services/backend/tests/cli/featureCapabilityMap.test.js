'use strict';

const { FeatureCapabilityMap } = require('../../src/cli/featureCapabilityMap');

describe('FeatureCapabilityMap', () => {
  test('tracks parsed known command as ready', () => {
    const map = new FeatureCapabilityMap();
    map.markCommandParsed({ command: 'gateway', subCommand: 'status' });
    const snap = map.getSnapshot();

    expect(snap.command).toBe('gateway');
    expect(snap.subCommand).toBe('status');
    expect(snap.executable).toBe('ready');
    expect(snap.implementation).toContain('handlers/gateway.js');
  });

  test('marks unknown command as ai-fallback', () => {
    const map = new FeatureCapabilityMap();
    map.markCommandParsed({ command: 'unknown_cmd' });
    const snap = map.getSnapshot();

    expect(snap.executable).toBe('ai-fallback');
    expect(snap.reason).toContain('unknown command');
  });

  test('switches to delegated when route returns false', () => {
    const map = new FeatureCapabilityMap();
    map.markCommandParsed({ command: 'foo' });
    map.markRouteResult(false);
    const snap = map.getSnapshot();

    expect(snap.executable).toBe('delegated');
    expect(snap.currentFeature).toContain('AI task');
  });

  test('tracks ai tool call and tool result', () => {
    const map = new FeatureCapabilityMap();
    map.markAiTask('fix router flow', true);
    map.markToolCall('read_file', { path: 'backend/src/cli/router.js' });
    let snap = map.getSnapshot();
    expect(snap.executable).toBe('running');
    expect(snap.reason).toContain('tool call: read_file');

    map.markToolResult('read_file', true, 'Read 120 lines');
    snap = map.getSnapshot();
    expect(snap.executable).toBe('ready');
    expect(snap.reason).toContain('tool success');
  });

  test('renders steer payload with implementation and executable fields', () => {
    const map = new FeatureCapabilityMap();
    map.markCommandParsed({ command: 'docs', subCommand: 'quickstart' });
    const text = map.buildAiSteerMessage();
    expect(text).toContain('[Feature Capability Map]');
    expect(text).toContain('Implementation:');
    expect(text).toContain('Executable:');
  });

  test('reset returns map to idle state', () => {
    const map = new FeatureCapabilityMap();
    map.markAiTask('task', true);
    map.reset();
    const snap = map.getSnapshot();
    expect(snap.currentFeature).toBe('idle');
    expect(snap.executable).toBe('ready');
  });
});
