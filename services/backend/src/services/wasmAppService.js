'use strict';

/**
 * WASM App Service
 *
 * Executes registered app manifests with runtime=wasm.
 * Scope is intentionally minimal:
 * - Host keeps I/O/network/process logic
 * - WASM module only exposes pure compute exports
 * - Arguments are numeric-only by default for deterministic behavior
 */

const fs = require('fs');
const path = require('path');
const { TextEncoder, TextDecoder } = require('util');
const { DEFAULT_ABI } = require('../constants/wasmDefaults');

let _appRegistry;
function registry() {
  if (!_appRegistry) _appRegistry = require('./appRegistry');
  return _appRegistry;
}

let _wasmSandbox;
function wasmSandbox() {
  if (!_wasmSandbox) _wasmSandbox = require('./wasm-sandbox');
  return _wasmSandbox;
}

// Cache key: absolute wasm path
// Value: { mtimeMs, module, instance, exportsMeta }
const _instanceCache = new Map();
// Hard LRU cap so a process that loads many distinct WASM apps does not retain
// every compiled module + instance (and its linear memory) forever. Map keeps
// insertion order; we promote on hit and evict the oldest on overflow, after
// which GC reclaims the dropped module/instance. Env-tunable.
const _wasmCacheCap = (() => {
  const n = parseInt(process.env.KHY_WASM_INSTANCE_CACHE_MAX, 10);
  return Number.isFinite(n) && n > 0 ? n : 32;
})();
function _evictWasmCacheOverflow() {
  while (_instanceCache.size > _wasmCacheCap) {
    const oldest = _instanceCache.keys().next().value;
    if (oldest === undefined) break;
    _instanceCache.delete(oldest);
  }
}
const _utf8Encoder = new TextEncoder();
const _utf8Decoder = new TextDecoder('utf-8');

function _resolveModulePath(app) {
  const candidate = app?.wasm?.path || app?.entry;
  if (!candidate) {
    throw new Error('WASM app manifest missing module path');
  }
  return path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
}

function _ensureWasmApp(appName) {
  const app = registry().get(appName);
  if (!app) {
    throw new Error(`App "${appName}" is not registered`);
  }
  if ((app.runtime || 'node') !== 'wasm') {
    throw new Error(`App "${appName}" is not a WASM app`);
  }
  return app;
}

function _runtimeConfigSignature(app) {
  const wasm = app?.wasm || {};
  return JSON.stringify({
    abi: wasm.abi || DEFAULT_ABI,
    defaultExport: wasm.defaultExport || 'main',
    capabilities: wasm.capabilities || null,
    loopback: wasm.loopback || null,
    khySys: wasm.khySys || null,
    stringAbi: wasm.stringAbi || null,
  });
}

function _parseIntLike(value, label) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  throw new Error(`${label} must be an integer or integer string`);
}

function _resolveServiceId(service) {
  const sb = wasmSandbox();
  if (typeof service === 'number' || typeof service === 'string' && /^\d+$/.test(service.trim())) {
    const n = _parseIntLike(service, 'service');
    if (n < 0 || n > 0xffff) throw new Error(`service out of range: ${n}`);
    return n;
  }
  const key = String(service || '').trim().toLowerCase();
  if (key === 'fs' || key === 'service_fs') return sb.SERVICE.FS;
  if (key === 'net' || key === 'service_net') return sb.SERVICE.NET;
  if (key === 'wm' || key === 'window' || key === 'service_wm') return sb.SERVICE.WM;
  throw new Error(`Unknown service: ${service}`);
}

function _resolveMethodId(serviceId, method) {
  const sb = wasmSandbox();
  if (typeof method === 'number' || typeof method === 'string' && /^\d+$/.test(method.trim())) {
    const n = _parseIntLike(method, 'method');
    if (n < 0 || n > 0xffff) throw new Error(`method out of range: ${n}`);
    return n;
  }

  const key = String(method || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!key) throw new Error('method is required');

  if (serviceId === sb.SERVICE.NET) {
    if (key === 'http_get' || key === 'get') return sb.METHOD.NET.HTTP_GET;
    if (key === 'dns_resolve' || key === 'dns') return sb.METHOD.NET.DNS_RESOLVE;
  }
  if (serviceId === sb.SERVICE.FS) {
    if (key === 'read_file' || key === 'read') return sb.METHOD.FS.READ_FILE;
    if (key === 'stat') return sb.METHOD.FS.STAT;
  }
  if (serviceId === sb.SERVICE.WM) {
    if (key === 'present_text' || key === 'present') return sb.METHOD.WM.PRESENT_TEXT;
    if (key === 'blit_rgba' || key === 'blit') return sb.METHOD.WM.BLIT_RGBA;
  }

  throw new Error(`Unknown method "${method}" for service_id=${serviceId}`);
}

function _capabilityMaskFromApp(app) {
  const sb = wasmSandbox();
  const raw = app?.wasm?.capabilities;

  if (!raw) return sb.CAP.IPC;
  const caps = Array.isArray(raw) ? raw : String(raw).split(',').map(v => v.trim()).filter(Boolean);
  if (caps.length === 0) return sb.CAP.IPC;

  const map = {
    ipc: sb.CAP.IPC,
    net: sb.CAP.NET,
    fs_read: sb.CAP.FS_READ,
    fs_write: sb.CAP.FS_WRITE,
    window: sb.CAP.WINDOW,
    shm: sb.CAP.SHM,
    irq_bind: sb.CAP.IRQ_BIND,
  };

  let mask = 0n;
  for (const cap of caps) {
    if (typeof cap === 'number' || typeof cap === 'bigint') {
      mask = mask | sb.toBigInt(cap, 'capability');
      continue;
    }
    const key = String(cap).trim().toLowerCase();
    if (!map[key]) throw new Error(`Unknown capability: ${cap}`);
    mask = mask | map[key];
  }
  return mask;
}

function _buildImportsForApp(app) {
  const sb = wasmSandbox();
  const capabilityMask = _capabilityMaskFromApp(app);
  const loopbackOptions = app?.wasm?.loopback || {};
  const transport = sb.createLoopbackTransport(loopbackOptions);
  const bridge = sb.createMoonbitHostBridge({
    transport,
    capabilityMask,
    defaultTimeoutMs: sb.IPC.DEFAULT_TIMEOUT_MS,
  });
  const khySysHost = sb.createKhySysHost({
    bridge,
    memoryExport: app?.wasm?.khySys?.memoryExport || app?.wasm?.stringAbi?.memoryExport || 'memory',
  });

  const spectest = {
    // MoonBit generated modules may depend on spectest printing hooks.
    print_char() {},
  };

  return {
    imports: {
      env: {},
      khy_sys: khySysHost.imports,
      spectest,
    },
    khySysHost,
    capabilityMask,
  };
}

function _coerceI32(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 0xffffffffn) {
      throw new Error(`${label} out of i32 range: ${value.toString()}`);
    }
    return Number(value);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${label} is not a finite number`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < 0 || value > 0xffffffff) {
    throw new Error(`${label} out of i32 range: ${value}`);
  }
  return value >>> 0;
}

function _getMemoryExport(instance, exportName) {
  const mem = instance.exports[exportName];
  if (!(mem instanceof WebAssembly.Memory)) {
    throw new Error(`WASM memory export "${exportName}" not found`);
  }
  return mem;
}

function _getFunctionExport(instance, exportName, kindLabel) {
  const fn = instance.exports[exportName];
  if (typeof fn !== 'function') {
    throw new Error(`WASM ${kindLabel} function "${exportName}" not found`);
  }
  return fn;
}

function _sliceMemory(memory, ptr, len) {
  const p = _coerceI32(ptr, 'ptr');
  const l = _coerceI32(len, 'len');
  const view = new Uint8Array(memory.buffer);
  if (p + l > view.byteLength) {
    throw new Error(`WASM memory out of bounds: ptr=${p} len=${l} size=${view.byteLength}`);
  }
  return view.slice(p, p + l);
}

function _unpackPtrLenFromI64(value) {
  if (typeof value !== 'bigint') {
    throw new Error('Expected i64 return for string-v2 (BigInt)');
  }
  const mask32 = 0xffffffffn;
  const ptr = Number((value >> 32n) & mask32);
  const len = Number(value & mask32);
  return { ptr, len };
}

async function _loadInstance(app) {
  const modulePath = _resolveModulePath(app);
  let stat;
  try {
    stat = await fs.promises.stat(modulePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`WASM module not found: ${modulePath}`);
    }
    throw err;
  }

  const cacheKey = `${app?.name || 'wasm-app'}::${modulePath}`;
  const configSig = _runtimeConfigSignature(app);
  const cached = _instanceCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.fileSize === stat.size &&
    cached.configSig === configSig
  ) {
    // Promote to most-recently-used (re-insert moves it to the tail).
    _instanceCache.delete(cacheKey);
    _instanceCache.set(cacheKey, cached);
    return cached;
  }

  const bytes = await fs.promises.readFile(modulePath);
  const bundle = _buildImportsForApp(app);
  const { module, instance } = await WebAssembly.instantiate(bytes, bundle.imports);
  if (bundle.khySysHost && typeof bundle.khySysHost.attachInstance === 'function') {
    bundle.khySysHost.attachInstance(instance);
  }
  const exportsMeta = WebAssembly.Module.exports(module);
  const importsMeta = WebAssembly.Module.imports(module);
  const expectedKhyMemoryExport = app?.wasm?.khySys?.memoryExport || 'memory';
  const hasKhyIpcImport = importsMeta.some(
    i => i.module === 'khy_sys' && i.kind === 'function' && i.name === 'ipc_call'
  );
  const hasExpectedKhyMemoryExport = exportsMeta.some(
    e => e.kind === 'memory' && e.name === expectedKhyMemoryExport
  );
  const record = {
    mtimeMs: stat.mtimeMs,
    fileSize: stat.size,
    modulePath,
    module,
    instance,
    exportsMeta,
    importsMeta,
    configSig,
    capabilityMask: bundle.capabilityMask.toString(),
    khySysHost: bundle.khySysHost || null,
    khySysImportInfo: {
      expectedKhyMemoryExport,
      hasKhyIpcImport,
      hasExpectedKhyMemoryExport,
    },
  };
  _instanceCache.set(cacheKey, record);
  _evictWasmCacheOverflow();
  return record;
}

function _parseNumericArg(token) {
  if (/^-?\d+n$/.test(token)) {
    return BigInt(token.slice(0, -1));
  }
  if (/^-?\d+$/.test(token)) {
    return Number(token);
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) {
    return Number(token);
  }
  throw new Error(
    `Unsupported arg "${token}". WASM runtime currently accepts numeric args only (e.g. 1, -2, 3.14, 42n).`
  );
}

function _normalizeValue(value) {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (Array.isArray(value)) return value.map(_normalizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _normalizeValue(v);
    return out;
  }
  return value;
}

function _maybeThrowKhySysAbiMismatch(app, loaded, exportName, beforeCallCount) {
  const state = loaded?.khySysHost?.state;
  if (!state) return;

  if (typeof beforeCallCount === 'number' && state.callCount <= beforeCallCount) {
    return;
  }

  const sb = wasmSandbox();
  const eproto = sb.negErrno(sb.ERRNO.EPROTO);
  if (state.lastStatus !== eproto) return;
  if (!/unsupported khy_sys IPC ABI/i.test(String(state.lastError || ''))) return;

  const expectedMemoryExport = app?.wasm?.khySys?.memoryExport || 'memory';
  throw new Error(
    [
      `khy_sys ABI mismatch while running export "${exportName}".`,
      'Module called khy_sys.ipc_call with non-pointer arguments (likely MoonBit wasm-gc externref ABI),',
      `but current host expects u32 ptr/len buffers in exported memory "${expectedMemoryExport}".`,
      'Use a pointer-based WASM ABI compatible with current khy_sys host, or keep IPC at host side via /app ipc.',
    ].join(' ')
  );
}

function _precheckNumericKhySysAbi(app, loaded, exportName) {
  const abi = app?.wasm?.abi || DEFAULT_ABI;
  if (abi !== 'numeric-v1') return;

  const info = loaded?.khySysImportInfo;
  const hasKhyIpcImport = info
    ? Boolean(info.hasKhyIpcImport)
    : (loaded?.importsMeta || []).some(
      i => i.module === 'khy_sys' && i.kind === 'function' && i.name === 'ipc_call'
    );
  if (!hasKhyIpcImport) return;

  const expectedMemoryExport = info
    ? info.expectedKhyMemoryExport
    : (app?.wasm?.khySys?.memoryExport || 'memory');
  const hasExpectedMemoryExport = info
    ? Boolean(info.hasExpectedKhyMemoryExport)
    : (loaded?.exportsMeta || []).some(
      e => e.kind === 'memory' && e.name === expectedMemoryExport
    );
  if (hasExpectedMemoryExport) return;

  throw new Error(
    [
      `khy_sys ABI mismatch while running export "${exportName}".`,
      `Module imports khy_sys.ipc_call but does not export memory "${expectedMemoryExport}".`,
      'This usually means MoonBit wasm-gc externref ABI, while current host expects u32 ptr/len buffers in linear memory.',
      'Use a pointer-based WASM ABI compatible with current khy_sys host, or keep IPC at host side via /app ipc.',
    ].join(' ')
  );
}

async function listFunctionExports(appName) {
  const app = _ensureWasmApp(appName);
  const loaded = await _loadInstance(app);
  return loaded.exportsMeta
    .filter(e => e.kind === 'function')
    .map(e => e.name);
}

function _runNumericV1(app, appName, loaded, expName, rawArgs) {
  const fn = loaded.instance.exports[expName];

  if (typeof fn !== 'function') {
    const available = loaded.exportsMeta
      .filter(e => e.kind === 'function')
      .map(e => e.name);
    throw new Error(
      `Export "${expName}" not found in module. Available: ${available.length ? available.join(', ') : '(none)'}`
    );
  }

  const args = rawArgs.map(_parseNumericArg);
  _precheckNumericKhySysAbi(app, loaded, expName);
  const beforeCallCount = loaded?.khySysHost?.state?.callCount;
  const result = fn(...args);
  _maybeThrowKhySysAbiMismatch(app, loaded, expName, beforeCallCount);

  return {
    app: appName,
    modulePath: loaded.modulePath || _resolveModulePath(app),
    exportName: expName,
    abi: 'numeric-v1',
    args: args.map(_normalizeValue),
    result: _normalizeValue(result),
  };
}

function _runStringV2(app, appName, loaded, expName, rawArgs) {
  const cfg = app?.wasm?.stringAbi || {};
  const memoryExport = cfg.memoryExport || 'memory';
  const allocExport = cfg.allocExport || 'alloc';
  const freeExport = cfg.freeExport || '';
  const returnMode = cfg.returnMode || 'i64-ptr-len';
  const inputText = rawArgs.join(' ');

  const memory = _getMemoryExport(loaded.instance, memoryExport);
  const alloc = _getFunctionExport(loaded.instance, allocExport, 'alloc');
  const runFn = _getFunctionExport(loaded.instance, expName, 'run');
  const freeFn = freeExport ? _getFunctionExport(loaded.instance, freeExport, 'free') : null;

  const inputBytes = _utf8Encoder.encode(inputText);
  const inPtr = _coerceI32(alloc(inputBytes.length), `${allocExport}()`);

  // Buffer can change if memory grows during alloc; always read current buffer after alloc.
  const inView = new Uint8Array(memory.buffer);
  if (inPtr + inputBytes.length > inView.byteLength) {
    throw new Error(`Input write out of bounds: ptr=${inPtr}, len=${inputBytes.length}, mem=${inView.byteLength}`);
  }
  inView.set(inputBytes, inPtr);

  const rawRet = runFn(inPtr, inputBytes.length);
  if (freeFn) {
    try { freeFn(inPtr, inputBytes.length); } catch { /* best effort */ }
  }

  let outPtr;
  let outLen;
  if (returnMode === 'i64-ptr-len') {
    const unpacked = _unpackPtrLenFromI64(rawRet);
    outPtr = unpacked.ptr;
    outLen = unpacked.len;
  } else {
    throw new Error(`Unsupported string-v2 return mode: ${returnMode}`);
  }

  const outBytes = _sliceMemory(memory, outPtr, outLen);
  const text = _utf8Decoder.decode(outBytes);
  if (freeFn) {
    try { freeFn(outPtr, outLen); } catch { /* best effort */ }
  }

  return {
    app: appName,
    modulePath: loaded.modulePath || _resolveModulePath(app),
    exportName: expName,
    abi: 'string-v2',
    args: [inputText],
    result: text,
    resultBytes: outLen,
  };
}

function _runJsonV2(app, appName, loaded, expName, rawArgs) {
  const inputText = rawArgs.join(' ');
  let parsedInput;
  try {
    parsedInput = JSON.parse(inputText);
  } catch (err) {
    throw new Error(`json-v2 input is not valid JSON: ${err.message}`);
  }

  const base = _runStringV2(app, appName, loaded, expName, [inputText]);
  let parsedOutput;
  try {
    parsedOutput = JSON.parse(base.result);
  } catch (err) {
    throw new Error(`json-v2 output is not valid JSON: ${err.message}`);
  }

  return {
    ...base,
    abi: 'json-v2',
    args: [parsedInput],
    result: parsedOutput,
  };
}

async function runFunction(appName, exportName, rawArgs = []) {
  const app = _ensureWasmApp(appName);
  const loaded = await _loadInstance(app);
  const expName = exportName || app?.wasm?.defaultExport || 'main';
  const abi = app?.wasm?.abi || DEFAULT_ABI;

  if (abi === 'numeric-v1') {
    return _runNumericV1(app, appName, loaded, expName, rawArgs);
  }
  if (abi === 'string-v2') {
    return _runStringV2(app, appName, loaded, expName, rawArgs);
  }
  if (abi === 'json-v2') {
    return _runJsonV2(app, appName, loaded, expName, rawArgs);
  }
  throw new Error(`Unsupported WASM ABI: ${abi}`);
}

async function runIpcCall(appName, service, method, payload = {}, options = {}) {
  const app = _ensureWasmApp(appName);
  const sb = wasmSandbox();
  const serviceId = _resolveServiceId(service);
  const methodId = _resolveMethodId(serviceId, method);
  const capabilityMask = _capabilityMaskFromApp(app);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : sb.IPC.DEFAULT_TIMEOUT_MS;

  const transport = options.transport || sb.createLoopbackTransport(app?.wasm?.loopback || {});
  const bridge = sb.createMoonbitHostBridge({
    transport,
    capabilityMask,
    defaultTimeoutMs: timeoutMs,
  });

  const result = await bridge.callJson(serviceId, methodId, payload, { timeoutMs });
  return {
    app: appName,
    serviceId,
    methodId,
    capabilityMask: capabilityMask.toString(),
    ...result,
  };
}

module.exports = {
  listFunctionExports,
  runFunction,
  runIpcCall,
};
