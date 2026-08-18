'use strict';

const FIXTURES = Object.freeze({
  'apiAdapter.js': { family: 'relay', transports: [], markers: ['svc.generateResponse('] },
  'claudeAdapter.js': { family: 'http-sse', transports: ['fetch', 'http'], markers: ['buildSuccess('] },
  'cliToolAdapter.js': { family: 'cli', transports: ['subprocess'], markers: ['buildSuccess('] },
  'clipboardRelayAdapter.js': { family: 'clipboard', transports: ['subprocess'], markers: ['buildSuccess('] },
  'codexAdapter.js': { family: 'cli', transports: ['subprocess'], markers: ['buildSuccess('] },
  'cursor2apiAdapter.js': { family: 'http-sse', transports: ['http'], markers: ['buildSuccess('] },
  'cursorAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
  'kiroAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
  'localLLMAdapter.js': { family: 'local-model', transports: [], markers: ['buildSuccess('] },
  'ollamaAdapter.js': { family: 'ollama', transports: ['http'], markers: ['buildSuccess('] },
  'openclawAdapter.js': { family: 'cli-wrapper', transports: ['subprocess'], markers: ['cliToolAdapter.generate('] },
  'opencodeAdapter.js': { family: 'cli-wrapper', transports: ['subprocess'], markers: ['cliToolAdapter.generate('] },
  'relayApiAdapter.js': { family: 'relay', transports: ['https'], markers: ['buildSuccess('] },
  'traeAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
  'vscodeAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
  'warpAdapter.js': { family: 'clipboard-wrapper', transports: ['subprocess'], markers: ['buildSuccess('] },
  'webRelayAdapter.js': { family: 'relay', transports: ['https'], markers: ['buildSuccess('] },
  'windsurfAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
});

module.exports = { FIXTURES };
