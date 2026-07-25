'use strict';

let activeSdk = null;
let pendingStart = null;
let currentStatus = 'disabled';

const _parseBoolean = require('../utils/parseBoolean');
function parseBool(value, fallback = false) {
  return _parseBoolean(value, fallback, { extended: false });
}

function parseHeaders(raw) {
  const value = String(raw || '').trim();
  if (!value) return undefined;
  const headers = {};
  for (const pair of value.split(',')) {
    const [k, ...rest] = pair.split('=');
    const key = String(k || '').trim();
    const val = String(rest.join('=') || '').trim();
    if (key) headers[key] = val;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function resolveEnabled() {
  if (parseBool(process.env.KHY_OTEL_ENABLED, false)) return true;
  if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return true;
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return true;
  if (process.env.OTEL_TRACES_EXPORTER) return true;
  return false;
}

function createTraceExporter(mode, logger) {
  if (mode === 'none') return null;

  if (mode === 'console') {
    const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
    return new ConsoleSpanExporter();
  }

  if (mode === 'otlp-http' || mode === 'otlp') {
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const endpoint = process.env.KHY_OTEL_OTLP_ENDPOINT
      || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const headers = parseHeaders(process.env.KHY_OTEL_OTLP_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS);
    if (!endpoint) {
      logger.warn('[otel] OTLP exporter selected but endpoint is missing; using default OTLP endpoint.');
      return new OTLPTraceExporter();
    }
    return new OTLPTraceExporter({ url: endpoint, headers });
  }

  logger.warn(`[otel] Unknown exporter mode "${mode}", falling back to console exporter.`);
  const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
  return new ConsoleSpanExporter();
}

function initializeOpenTelemetry(options = {}) {
  const logger = options.logger || console;
  if (activeSdk || pendingStart) {
    return { enabled: true, status: currentStatus };
  }

  if (!resolveEnabled()) {
    currentStatus = 'disabled';
    return { enabled: false, status: currentStatus };
  }

  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { resourceFromAttributes } = require('@opentelemetry/resources');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

    const serviceName = String(
      process.env.KHY_OTEL_SERVICE_NAME
      || options.serviceName
      || 'khy-os-backend'
    );
    const serviceVersion = String(
      process.env.KHY_OTEL_SERVICE_VERSION
      || options.serviceVersion
      || ''
    ).trim();

    const exporterMode = String(
      process.env.KHY_OTEL_EXPORTER
      || (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'otlp-http' : 'console')
    ).trim().toLowerCase();

    const traceExporter = createTraceExporter(exporterMode, logger);

    const resourceAttrs = { [ATTR_SERVICE_NAME]: serviceName };
    if (serviceVersion) {
      resourceAttrs[ATTR_SERVICE_VERSION] = serviceVersion;
    }

    const sdkConfig = {
      resource: resourceFromAttributes(resourceAttrs),
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
      ],
    };

    if (traceExporter) {
      sdkConfig.traceExporter = traceExporter;
    }

    const sdk = new NodeSDK(sdkConfig);
    const startResult = sdk.start();
    const isPromise = startResult && typeof startResult.then === 'function';

    if (isPromise) {
      currentStatus = 'starting';
      pendingStart = Promise.resolve(startResult)
        .then(() => {
          activeSdk = sdk;
          currentStatus = 'started';
          pendingStart = null;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          currentStatus = 'failed';
          pendingStart = null;
          logger.warn(`[otel] Failed to start OpenTelemetry SDK: ${message}`);
        });
      return { enabled: true, status: currentStatus };
    }

    activeSdk = sdk;
    currentStatus = 'started';
    return { enabled: true, status: currentStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentStatus = 'failed';
    logger.warn(`[otel] Failed to initialize OpenTelemetry: ${message}`);
    return { enabled: false, status: currentStatus };
  }
}

async function shutdownOpenTelemetry(logger = console) {
  if (pendingStart) {
    try {
      await pendingStart;
    } catch {
      // Startup failure already logged by initializer.
    }
  }
  if (!activeSdk) return;
  try {
    await activeSdk.shutdown();
    currentStatus = 'stopped';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[otel] Failed to shutdown OpenTelemetry SDK: ${message}`);
  } finally {
    activeSdk = null;
  }
}

function getOpenTelemetryStatus() {
  return currentStatus;
}

module.exports = {
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
  getOpenTelemetryStatus,
};

