'use strict';

/**
 * RecordingCollector — gathers all artifacts during an Agent execution run.
 *
 * Collects:
 *   - Screenshots at each step (via screenCapture)
 *   - Operation trajectory (from ComputerUseAgent history)
 *   - Final artifacts (file hashes, etc.)
 *
 * Reuses: desktopControl.screenCapture, trajectoryProvenance.artifactHash
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let _screenCapture = null;
let _artifactHash = null;

function _loadDeps() {
  if (!_screenCapture) {
    try {
      _screenCapture = require('../../desktop/desktopControl/screenCapture');
    } catch {
      /* optional */
    }
  }
  if (!_artifactHash) {
    try {
      _artifactHash = require('../../trajectory/trajectoryReplay/artifactHash');
    } catch {
      /* optional */
    }
  }
}

class RecordingCollector {
  constructor(opts = {}) {
    this.outputDir = opts.outputDir || path.join(os.tmpdir(), 'khy-eval', String(Date.now()));
    this.screenshots = [];
    this.trajectory = [];
    this.artifacts = [];
    _loadDeps();
  }

  ensureDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Capture a screenshot for the current step.
   * @param {number} step
   * @param {object} [opts] { region, desktop }
   */
  async captureScreenshot(step, opts = {}) {
    if (!_screenCapture) {
      return null;
    }
    try {
      this.ensureDir();
      const outPath = path.join(this.outputDir, `step-${String(step).padStart(4, '0')}.png`);
      const result = await _screenCapture.capture({ ...opts, outPath });
      if (result && result.path && fs.existsSync(result.path)) {
        const sha256 = _artifactHash ? await _artifactHash.sha256Hex(result.path) : null;
        const entry = { step, path: result.path, sha256, timestamp: new Date().toISOString() };
        this.screenshots.push(entry);
        return entry;
      }
    } catch {
      /* fail-soft */
    }
    return null;
  }

  /**
   * Record one trajectory step.
   * @param {number} step
   * @param {string} action
   * @param {object} params
   * @param {*} result
   * @param {Array} rawArgs  Original method arguments (for text extraction).
   */
  recordStep(step, action, params, result, rawArgs = []) {
    const recordParams = { ...params };
    if ((action === 'type' || action === 'typeKeystrokes') && rawArgs && rawArgs[0] != null) {
      recordParams.text = String(rawArgs[0]);
    }
    const entry = {
      step,
      action,
      params: recordParams,
      result: result || {},
      timestamp: new Date().toISOString(),
    };
    this.trajectory.push(entry);
    return entry;
  }

  /**
   * Register a final artifact (file produced by the agent).
   * @param {string} filePath
   * @param {string} [description]
   */
  async registerArtifact(filePath, description = '') {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const sha256 = _artifactHash ? await _artifactHash.sha256Hex(filePath) : null;
    const stat = fs.statSync(filePath);
    const entry = {
      path: filePath,
      sha256,
      size: stat.size,
      type: path.extname(filePath).slice(1),
      description,
    };
    this.artifacts.push(entry);
    return entry;
  }

  /**
   * Finalize the run data and return the collected recordings object.
   */
  finalize() {
    return {
      screenshots: this.screenshots,
      trajectory: this.trajectory,
      artifacts: this.artifacts,
      screenRecording: null,
    };
  }
}

module.exports = { RecordingCollector };
