import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, parsePairingPayload } from '../src/api/runtime';

describe('mobile runtime configuration', () => {
  it('normalizes a configured API base URL', () => {
    expect(normalizeBaseUrl('https://node.example/api/')).toBe('https://node.example/api');
  });

  it('rejects credentials, query strings, and unsupported protocols', () => {
    expect(() => normalizeBaseUrl('https://user:secret@node.example')).toThrow();
    expect(() => normalizeBaseUrl('https://node.example?token=value')).toThrow();
    expect(() => normalizeBaseUrl('ws://node.example')).toThrow();
  });

  it('parses structured pairing data without dropping optional endpoints', () => {
    expect(parsePairingPayload(JSON.stringify({
      api_base_url: 'https://node.example/',
      management_ws_url: 'wss://node.example/ws',
      bridge_base_url: 'https://bridge.example',
    }))).toEqual({
      apiBaseUrl: 'https://node.example',
      managementWsUrl: 'wss://node.example/ws',
      bridgeBaseUrl: 'https://bridge.example',
      source: 'qr',
    });
  });

  it('parses a bare backend URL from the pairing QR', () => {
    expect(parsePairingPayload('http://10.0.0.5:3000')).toEqual({
      apiBaseUrl: 'http://10.0.0.5:3000',
      source: 'qr',
    });
  });

  it('rejects the browser management-page QR and names the right command', () => {
    expect(() => parsePairingPayload('http://10.0.0.5:9090/admin/ai-gateway'))
      .toThrow(/khy mobile app/);
  });
});
