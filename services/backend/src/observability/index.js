'use strict';

const { createMetrics, normalizePath } = require('./metrics');
const {
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
  getOpenTelemetryStatus,
} = require('./otel');

module.exports = {
  createMetrics,
  normalizePath,
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
  getOpenTelemetryStatus,
};

