#!/usr/bin/env node
'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FIXTURES } = require('./providerContractFixtures');

const FIXTURE_TEXT = 'quality-gate fixture';
const FIXTURE_MODEL = 'fixture-model';
const RESULT_PREFIX = '__KHY_PROVIDER_CONTRACT__=';

function fixturePayload() {
  return {
    id: 'quality-gate-fixture',
    model: FIXTURE_MODEL,
    response: FIXTURE_TEXT,
    content: [{ type: 'text', text: FIXTURE_TEXT }],
    message: { role: 'assistant', content: FIXTURE_TEXT },
    choices: [{ message: { role: 'assistant', content: FIXTURE_TEXT }, text: FIXTURE_TEXT, finish_reason: 'stop' }],
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    },
    prompt_eval_count: 2,
    eval_count: 3,
    done: true,
  };
}

function fixtureHttpBody(adapterName) {
  if (adapterName === 'claudeAdapter.js') {
    return [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"fixture-model","usage":{"input_tokens":2}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"quality-gate fixture"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
  }
  return JSON.stringify(fixturePayload());
}

function fixtureResponse(adapterName) {
  const payload = fixturePayload();
  const bodyText = fixtureHttpBody(adapterName);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': adapterName === 'claudeAdapter.js' ? 'text/event-stream' : 'application/json' }),
    body: PassThrough.from([Buffer.from(bodyText)]),
    json: async () => payload,
    text: async () => bodyText,
    arrayBuffer: async () => Buffer.from(bodyText),
  };
}

function blocked(transport, operation) {
  return () => {
    throw new Error(`unmocked ${transport}${operation ? `.${operation}` : ''} access during provider contract test`);
  };
}

function installModuleFixtures(adapterName) {
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function qualityGateModuleLoad(request, parent, isMain) {
    if (adapterName === 'webRelayAdapter.js' && request === 'http') {
      return {
        createServer: () => {
          const server = new EventEmitter();
          server.listen = (_port, _host, callback) => process.nextTick(callback);
          server.address = () => ({ port: 19099 });
          server.close = (callback) => process.nextTick(() => callback?.());
          return server;
        },
      };
    }
    if (adapterName === 'webRelayAdapter.js' && request === 'ws') {
      class FixtureWebSocketServer extends EventEmitter {
        constructor() {
          super();
          const client = new EventEmitter();
          client.readyState = 1;
          client.terminate = () => {};
          client.send = (raw) => {
            const message = JSON.parse(raw);
            if (message.type === 'prompt') {
              process.nextTick(() => {
                client.emit('message', Buffer.from(JSON.stringify({
                  type: 'response',
                  id: message.id,
                  text: FIXTURE_TEXT,
                })));
              });
            }
          };
          this.clients = new Set([client]);
          process.nextTick(() => this.emit('connection', client));
        }
        close() {}
      }
      return { Server: FixtureWebSocketServer, OPEN: 1 };
    }
    if (request.endsWith('/nativeHttp') || request.endsWith('nativeHttp')) {
      return {
        requestStream: async () => ({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          stream: PassThrough.from([Buffer.from(fixtureHttpBody('claudeAdapter.js'))]),
        }),
        request: async () => ({ status: 200, headers: {}, data: fixturePayload() }),
        requestStatus: async () => ({ status: 200 }),
      };
    }
    if (adapterName === 'kiroAdapter.js' && (request.endsWith('/_cwStreamParser') || request.endsWith('_cwStreamParser'))) {
      return {
        getCWModule: async () => ({
          CodeWhispererStreaming: class FixtureCodeWhispererStreaming {
            constructor() {
              this.middlewareStack = { add: () => {} };
            }
            async send() {
              return {
                generateAssistantResponseResponse: (async function* () {
                  yield { assistantResponseEvent: { content: FIXTURE_TEXT, modelId: FIXTURE_MODEL } };
                  yield {
                    metadataEvent: {
                      tokenUsage: {
                        uncachedInputTokens: 2,
                        outputTokens: 3,
                        totalTokens: 5,
                      },
                    },
                  };
                })(),
              };
            }
          },
          GenerateAssistantResponseCommand: class FixtureGenerateAssistantResponseCommand {
            constructor(input) { Object.assign(this, input); }
          },
        }),
        resetCWModuleCache: () => {},
        parseCWStreamEvents: async () => ({
          content: FIXTURE_TEXT,
          modelId: FIXTURE_MODEL,
          tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          toolUseBlocks: [],
          thinking: '',
        }),
        repairToolUsePairing: (messages) => messages,
      };
    }
    if (
      adapterName === 'claudeAdapter.js' &&
      (request.endsWith('/_protocolPipeline') || request.endsWith('_protocolPipeline'))
    ) {
      return {
        createProtocolHandler: () => ({
          parseStreamResponse: async () => ({
            content: FIXTURE_TEXT,
            model: FIXTURE_MODEL,
            finishReason: 'end_turn',
            usage: { input_tokens: 2, output_tokens: 3 },
            toolUseBlocks: [],
            thinking: null,
          }),
        }),
      };
    }
    if (
      ['openclawAdapter.js', 'opencodeAdapter.js'].includes(adapterName) &&
      (request.endsWith('/cliToolAdapter') || request.endsWith('cliToolAdapter'))
    ) {
      return {
        generate: async () => ({
          success: true,
          content: FIXTURE_TEXT,
          model: FIXTURE_MODEL,
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          provider: 'quality-gate-cli-wrapper',
          adapter: 'cli',
        }),
      };
    }
    if (
      adapterName === 'traeAdapter.js' &&
      (request.endsWith('/traeOfficialArtifacts') || request.endsWith('traeOfficialArtifacts'))
    ) {
      return {
        collectTraeOfficialArtifacts: () => [],
        resolveTraeOfficialCredential: () => ({
          credentialMode: 'plaintext',
          officialArtifactsDetected: true,
          sourcePaths: ['quality-gate-fixture'],
          token: 'eyJ.quality-gate-credential-token-fixture.signature',
          refreshToken: null,
          endpoint: 'https://quality-gate.invalid/v1',
          expiresAt: null,
        }),
        verifyTraeOfficialSession: async () => ({ sessionVerified: true }),
        resolveTraeOfficialStoragePaths: () => [],
        resolveTraeOfficialDbPaths: () => [],
        decodeTraeOfficialAuthBlob: () => null,
        resolveNativeHostByRegion: () => 'quality-gate.invalid',
        writeBridgeAuthToken: () => {},
        TRAE_REGION_HOST_MAP: { cn: 'quality-gate.invalid' },
      };
    }
    if (request.endsWith('/multiFreeService') || request.endsWith('multiFreeService')) {
      return function fixtureMultiFreeService() {
        return {
          generateResponse: async () => ({
            success: true,
            content: FIXTURE_TEXT,
            provider: 'quality-gate-fixture',
            model: FIXTURE_MODEL,
            tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          }),
          getAvailableProviders: () => [{ key: 'quality-gate-fixture' }],
          getStatus: () => ({ available: true }),
        };
      };
    }
    if (request.endsWith('/localLLMService') || request.endsWith('localLLMService')) {
      return {
        ensureLoaded: async () => {},
        generate: async () => ({
          content: FIXTURE_TEXT,
          model: FIXTURE_MODEL,
          tokenUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        }),
        dispose: async () => {},
      };
    }
    if (request.endsWith('/fetchTimeout') || request.endsWith('fetchTimeout')) {
      return { fetchWithTimeout: async (fn, options) => fn(options || {}) };
    }
    if (request.endsWith('/_anthropicSseStream') || request.endsWith('_anthropicSseStream')) {
      return {
        parseAnthropicSseStream: async () => ({
          content: FIXTURE_TEXT,
          model: FIXTURE_MODEL,
          finishReason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 3 },
          toolUseBlocks: [],
          thinking: null,
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

function installTransportMocks(adapterName, recipe = { transports: [] }) {
  const allowed = new Set(recipe.transports || []);
  globalThis.fetch = allowed.has('fetch')
    ? async () => fixtureResponse(adapterName)
    : blocked('fetch');

  const childProcess = require('child_process');
  const stdout = adapterName === 'cliToolAdapter.js'
    ? `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: FIXTURE_TEXT }] },
      })}\n`
    : adapterName === 'codexAdapter.js'
      ? `${JSON.stringify({
          type: 'item.completed',
          item: { id: 'fixture-message', type: 'assistant_message', text: FIXTURE_TEXT },
        })}\n`
      : `${JSON.stringify(fixturePayload())}\n${FIXTURE_TEXT}\n`;
  if (allowed.has('subprocess')) {
    childProcess.execFile = (_file, _args, _options, callback) => {
      const cb = typeof _options === 'function' ? _options : callback;
      const child = new EventEmitter();
      child.kill = () => true;
      process.nextTick(() => cb?.(null, stdout, ''));
      return child;
    };
    childProcess.execFileSync = () => stdout;
    childProcess.execSync = () => stdout;
    childProcess.spawnSync = () => ({ status: 0, stdout, stderr: '', error: null });
    childProcess.spawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.stdout.end(stdout);
        child.stderr.end();
        child.emit('close', 0, null);
        child.emit('exit', 0, null);
      });
      return child;
    };
  } else {
    for (const method of ['execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync', 'fork']) {
      childProcess[method] = blocked('child_process', method);
    }
  }

  for (const moduleName of ['http', 'https']) {
    const module = require(moduleName);
    if (!allowed.has(moduleName)) {
      module.request = blocked(moduleName, 'request');
      module.get = blocked(moduleName, 'get');
      continue;
    }
    module.request = (...args) => {
      const callback = args.find((arg) => typeof arg === 'function');
      const request = new EventEmitter();
      request.write = () => true;
      request.setTimeout = () => request;
      request.destroy = () => request;
      request.abort = () => request;
      request.end = () => {
        const response = PassThrough.from([Buffer.from(fixtureHttpBody(adapterName))]);
        response.statusCode = 200;
        response.statusMessage = 'OK';
        response.headers = {
          'content-type': adapterName === 'claudeAdapter.js' ? 'text/event-stream' : 'application/json',
        };
        process.nextTick(() => callback?.(response));
      };
      return request;
    };
    module.get = (...args) => {
      const request = module.request(...args);
      request.end();
      return request;
    };
  }
  for (const moduleName of ['net', 'tls']) {
    const module = require(moduleName);
    for (const method of ['connect', 'createConnection']) module[method] = blocked(moduleName, method);
  }
}

function fixtureOptions(name) {
  return {
    env: {
      ...process.env,
      KHY_OPENCLAW: '1',
      KHY_OPENCODE: '1',
      KHY_QUALITY_GATE_FIXTURE: '1',
    },
    model: name === 'apiAdapter.js'
      ? 'openai:fixture-model'
      : name === 'ollamaAdapter.js'
        ? 'ollama:fixture-model'
        : FIXTURE_MODEL,
    apiKey: 'quality-gate-key',
    apiEndpoint: 'https://quality-gate.invalid/v1',
    timeoutMs: 2000,
  };
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) throw new Error('adapter path is required');
  const file = path.resolve(fileArg);
  const adapterName = path.basename(file);
  const probeOnly = process.argv.includes('--probe');
  const recipe = FIXTURES[adapterName] || { transports: [] };

  const tempFixtureFiles = [];
  const writeTempFixture = (label, data) => {
    const fixturePath = path.join(os.tmpdir(), `khy-quality-gate-${label}-${process.pid}.json`);
    fs.writeFileSync(fixturePath, JSON.stringify(data));
    tempFixtureFiles.push(fixturePath);
    return fixturePath;
  };

  if (adapterName === 'kiroAdapter.js') {
    process.env.KIRO_TOKEN_PATH = writeTempFixture('kiro', {
      accessToken: 'quality-gate-kiro-access-token-fixture',
      refreshToken: 'quality-gate-kiro-refresh-token-fixture',
      expiresAt: Date.now() + 3600000,
      region: 'us-east-1',
      profileArn: 'arn:aws:codewhisperer:us-east-1:000000000000:profile/quality-gate',
    });
  }
  if (adapterName === 'vscodeAdapter.js') {
    process.env.VSCODE_COPILOT_PATH = writeTempFixture('vscode', {
      'github.com': { oauth_token: 'quality-gate-vscode-copilot-token-fixture' },
    });
  }
  if (adapterName === 'windsurfAdapter.js') {
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quality-gate-windsurf-'));
    const storagePath = path.join(fixtureHome, 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage');
    fs.mkdirSync(storagePath, { recursive: true });
    fs.writeFileSync(path.join(storagePath, 'storage.json'), JSON.stringify({
      'windsurf.auth.accessToken': 'quality-gate-windsurf-access-token-fixture',
      'windsurf.auth.endpoint': 'https://quality-gate.invalid/v1',
    }));
    process.env.USERPROFILE = fixtureHome;
    process.env.HOME = fixtureHome;
    tempFixtureFiles.push(fixtureHome);
  }
  process.on('exit', () => {
    for (const fixturePath of tempFixtureFiles) {
      try {
        fs.rmSync(fixturePath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of isolated fixture files.
      }
    }
  });

  installModuleFixtures(adapterName);
  installTransportMocks(adapterName, recipe);
  const adapter = require(file);
  const hasGenerate = Boolean(adapter && typeof adapter.generate === 'function');
  if (probeOnly) {
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ hasGenerate })}\n`);
    return;
  }
  if (!hasGenerate) throw new Error(`${adapterName} does not export generate(prompt, options)`);

  const result = await adapter.generate(FIXTURE_TEXT, fixtureOptions(adapterName));
  if (typeof adapter.destroy === 'function') await adapter.destroy();
  fs.writeSync(process.stdout.fd, `${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
