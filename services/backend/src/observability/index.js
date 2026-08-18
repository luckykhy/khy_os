'use strict';

const { createMetrics, normalizePath } = require('./metrics');
const {
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
  getOpenTelemetryStatus,
} = require('./otel');
const slowRequest = require('./slowRequest');
const slowRequestCore = require('./slowRequestCore');
const eventLoopMonitor = require('./eventLoopMonitor');
const cpuProfiler = require('./cpuProfiler');
const profilerCore = require('./profilerCore');

module.exports = {
  createMetrics,
  normalizePath,
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
  getOpenTelemetryStatus,
  slowRequest,
  slowRequestCore,
  eventLoopMonitor,
  cpuProfiler,
  profilerCore,
};
