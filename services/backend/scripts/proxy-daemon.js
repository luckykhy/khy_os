#!/usr/bin/env node
/**
 * @pattern Command, Proxy
 */

/**
 * Detached runner for proxyServer.
 * Keeps proxy process alive across one-shot CLI invocations.
 */

const proxy = require('../src/services/gateway/proxyServer');

function parsePort(argv) {
  const idx = argv.indexOf('--port');
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return undefined;
  return n;
}

function parseHttpsPort(argv) {
  const idx = argv.indexOf('--https-port');
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return undefined;
  return n;
}

function parseStringArg(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  if (!raw || raw.startsWith('--')) return undefined;
  return raw;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function parseOptions(argv) {
  const options = {};
  const port = parsePort(argv);
  const httpsPort = parseHttpsPort(argv);
  const host = parseStringArg(argv, '--host');
  const tlsCertFile = parseStringArg(argv, '--tls-cert');
  const tlsKeyFile = parseStringArg(argv, '--tls-key');

  if (Number.isFinite(port)) options.port = port;
  if (Number.isFinite(httpsPort)) options.httpsPort = httpsPort;
  if (host) options.host = host;
  if (tlsCertFile) options.tlsCertFile = tlsCertFile;
  if (tlsKeyFile) options.tlsKeyFile = tlsKeyFile;
  if (hasFlag(argv, '--https')) options.https = true;
  if (hasFlag(argv, '--https-only')) options.httpsOnly = true;
  return options;
}

async function shutdown() {
  try {
    await proxy.stop();
  } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[proxy-daemon] uncaughtException:', err && err.message ? err.message : String(err));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[proxy-daemon] unhandledRejection:', err && err.message ? err.message : String(err));
  process.exit(1);
});

async function main() {
  const options = parseOptions(process.argv);
  await proxy.start(options);
}

main().catch((err) => {
  console.error('[proxy-daemon] start failed:', err && err.message ? err.message : String(err));
  process.exit(1);
});
