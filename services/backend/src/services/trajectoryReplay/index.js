'use strict';

/**
 * trajectoryReplay — deterministic trajectory replay subsystem (DESIGN-ARCH-048).
 *
 * Barrel re-export. Records a full-fidelity, replayable ledger of every tool turn
 * (replayLedger), classifies tools into replay tiers (tierRegistry), hashes
 * artifacts for reproduction verification (artifactHash), captures an environment
 * fingerprint for the "relatively static environment" gate (envFingerprint),
 * exports self-contained replay bundles (replayBundle), and re-executes a
 * trajectory without an AI to reproduce its artifacts (replayEngine).
 *
 * Modules beyond P1 are wired in as their phases land.
 */

const replayLedger = require('./replayLedger');
const tierRegistry = require('./tierRegistry');
const artifactHash = require('./artifactHash');
const envFingerprint = require('./envFingerprint');
const replayBundle = require('./replayBundle');
const replayEngine = require('./replayEngine');

module.exports = {
  replayLedger,
  tierRegistry,
  artifactHash,
  envFingerprint,
  replayBundle,
  replayEngine,
};
