'use strict';

/**
 * checkpointVerifier — runs Checkpoints against a completed GuiEvalRun.
 *
 * Supported types:
 *   screenshot_match — dHash comparison between screenshots (reuses stateDetector)
 *   ui_element       — check if expected element exists in UI tree (reuses uiInspector)
 *   file_created     — verify file exists + sha256 match (reuses artifactHash)
 *   file_content     — regex / JSON path match on file content
 *   process_running  — check if process is in the task list
 *   semantic         — deferred to P6 (multimodal model required)
 *   custom_script    — execute a JS script in vm context
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let _stateDetector = null;
let _uiInspector = null;
let _artifactHash = null;

function _loadDeps() {
  if (!_stateDetector) {
    try {
      _stateDetector = require('../../desktop/computerUse/stateDetector');
    } catch {
      /* optional */
    }
  }
  if (!_uiInspector) {
    try {
      _uiInspector = require('../../desktop/desktopControl/uiInspector');
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

class CheckpointVerifier {
  constructor(opts = {}) {
    this.screenshotDir = opts.screenshotDir || path.join(os.tmpdir(), 'khy-eval-captures');
    _loadDeps();
  }

  /**
   * Run a single checkpoint against the run data.
   * @param {object} checkpoint  { id, type, description, weight, params }
   * @param {object} runData     { trajectory, recordings, artifacts }
   * @returns {{ passed: boolean, evidence: string, duration: number, autoScore: number }}
   */
  async verify(checkpoint, runData) {
    const start = Date.now();
    try {
      switch (checkpoint.type) {
        case 'screenshot_match':
          return await this._verifyScreenshotMatch(checkpoint, runData, start);
        case 'ui_element':
          return await this._verifyUiElement(checkpoint, runData, start);
        case 'file_created':
          return await this._verifyFileCreated(checkpoint, runData, start);
        case 'file_content':
          return await this._verifyFileContent(checkpoint, runData, start);
        case 'process_running':
          return await this._verifyProcessRunning(checkpoint, runData, start);
        case 'semantic':
          return await this._verifySemantic(checkpoint, runData, start);
        case 'custom_script':
          return await this._verifyCustomScript(checkpoint, runData, start);
        default:
          return {
            passed: false,
            evidence: `Unknown checkpoint type: ${checkpoint.type}`,
            duration: Date.now() - start,
            autoScore: 0,
          };
      }
    } catch (err) {
      return {
        passed: false,
        evidence: `Error: ${err.message}`,
        duration: Date.now() - start,
        autoScore: 0,
      };
    }
  }

  // ── Checkpoint type implementations ──────────────────────────────

  async _verifyScreenshotMatch(cp, runData, start) {
    const { expectedDhash, maxHamming = 5, stepIndex = -1 } = cp.params || {};
    const screenshots = runData?.recordings?.screenshots || [];
    if (!screenshots.length) {
      return {
        passed: false,
        evidence: 'No screenshots captured',
        duration: Date.now() - start,
        autoScore: 0,
      };
    }
    if (!expectedDhash || !_stateDetector) {
      return {
        passed: false,
        evidence: 'Missing expectedDhash or stateDetector unavailable',
        duration: Date.now() - start,
        autoScore: 0,
      };
    }

    const shot = stepIndex >= 0 ? screenshots[stepIndex] : screenshots[screenshots.length - 1];
    if (!shot || !shot.path || !fs.existsSync(shot.path)) {
      return {
        passed: false,
        evidence: 'Screenshot file missing',
        duration: Date.now() - start,
        autoScore: 0,
      };
    }

    try {
      const buf = fs.readFileSync(shot.path);
      const { dHash, decodePng, hammingDistance } = _stateDetector;
      const { width, height, data } = decodePng(buf);
      const actualDhash = dHash(data, width, height);
      const distance = hammingDistance(actualDhash, expectedDhash);
      const passed = distance <= maxHamming;
      return {
        passed,
        evidence: `dHash Hamming distance: ${distance} (threshold: ${maxHamming})`,
        duration: Date.now() - start,
        autoScore: passed ? 1 : 0,
      };
    } catch (err) {
      return {
        passed: false,
        evidence: `dHash compute error: ${err.message}`,
        duration: Date.now() - start,
        autoScore: 0,
      };
    }
  }

  async _verifyUiElement(cp, runData, start) {
    const { selector, role, name, required = true } = cp.params || {};
    if (!_uiInspector) {
      return {
        passed: false,
        evidence: 'uiInspector not available',
        duration: Date.now() - start,
        autoScore: 0,
      };
    }

    try {
      const scene = await _uiInspector.inspect({});
      if (!scene || !scene.success) {
        return {
          passed: false,
          evidence: 'UI inspection failed',
          duration: Date.now() - start,
          autoScore: 0,
        };
      }
      const elements = scene.elements || [];
      let found = null;
      if (selector) {
        found = elements.find((el) => el.selector === selector || el.name === selector);
      } else if (role && name) {
        found = elements.find((el) => el.role === role && el.name === name);
      } else if (name) {
        found = elements.find((el) => el.name === name);
      } else if (role) {
        found = elements.find((el) => el.role === role);
      }
      if (!found) {
        return {
          passed: false,
          evidence: `Element not found: ${JSON.stringify(cp.params)}`,
          duration: Date.now() - start,
          autoScore: 0,
        };
      }
      return {
        passed: true,
        evidence: `Found: ${found.name} (role: ${found.role})`,
        duration: Date.now() - start,
        autoScore: 1,
      };
    } catch (err) {
      return {
        passed: false,
        evidence: `UI inspection error: ${err.message}`,
        duration: Date.now() - start,
        autoScore: 0,
      };
    }
  }

  async _verifyFileCreated(cp, runData, start) {
    const { path: expectedPath, sha256: expectedHash } = cp.params || {};
    if (!expectedPath) {
      return {
        passed: false,
        evidence: 'Missing expected path',
        duration: Date.now() - start,
        autoScore: 0,
      };
    }
    if (!fs.existsSync(expectedPath)) {
      return {
        passed: false,
        evidence: `File not found: ${expectedPath}`,
        duration: Date.now() - start,
        autoScore: 0,
      };
    }

    if (expectedHash) {
      const actualHash = _artifactHash ? await _artifactHash.sha256Hex(expectedPath) : null;
      if (actualHash !== expectedHash) {
        return {
          passed: false,
          evidence: `Hash mismatch: expected ${expectedHash}, got ${actualHash}`,
          duration: Date.now() - start,
          autoScore: 0,
        };
      }
    }
    const stat = fs.statSync(expectedPath);
    return {
      passed: true,
      evidence: `File exists (${stat.size} bytes)${expectedHash ? ', hash matches' : ''}`,
      duration: Date.now() - start,
      autoScore: 1,
    };
  }

  async _verifyFileContent(cp, runData, start) {
    const { path: filePath, regex, jsonPath } = cp.params || {};
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        passed: false,
        evidence: `File not found: ${filePath}`,
        duration: Date.now() - start,
        autoScore: 0,
      };
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return {
        passed: false,
        evidence: `Read error: ${err.message}`,
        duration: Date.now() - start,
        autoScore: 0,
      };
    }

    if (regex) {
      try {
        const re = new RegExp(regex);
        const m = content.match(re);
        return {
          passed: !!m,
          evidence: m ? `Regex matched: ${m[0].slice(0, 100)}` : 'No regex match',
          duration: Date.now() - start,
          autoScore: m ? 1 : 0,
        };
      } catch {
        return {
          passed: false,
          evidence: `Invalid regex: ${regex}`,
          duration: Date.now() - start,
          autoScore: 0,
        };
      }
    }
    if (jsonPath) {
      try {
        const obj = JSON.parse(content);
        const keys = jsonPath.split('.');
        let val = obj;
        for (const k of keys) {
          val = val?.[k];
        }
        return {
          passed: val !== undefined,
          evidence: `JSON path "${jsonPath}" = ${JSON.stringify(val)}`,
          duration: Date.now() - start,
          autoScore: val !== undefined ? 1 : 0,
        };
      } catch {
        return {
          passed: false,
          evidence: 'JSON parse failed',
          duration: Date.now() - start,
          autoScore: 0,
        };
      }
    }
    return {
      passed: false,
      evidence: 'No regex or jsonPath specified',
      duration: Date.now() - start,
      autoScore: 0,
    };
  }

  async _verifyProcessRunning(cp, runData, start) {
    const { processName, expectedPid } = cp.params || {};
    try {
      let processes;
      if (process.platform === 'win32') {
        const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf-8', timeout: 5000 });
        processes = out
          .split('\n')
          .map((l) => l.split('","').map((s) => s.replace(/^"|"$/g, '').trim()));
      } else {
        const out = execSync('ps -A -o pid,comm', { encoding: 'utf-8', timeout: 5000 });
        processes = out
          .split('\n')
          .filter(Boolean)
          .map((l) => l.trim().split(/\s+/));
      }
      let found = null;
      if (expectedPid) {
        found = processes.find((p) => String(p[0]) === String(expectedPid));
      } else if (processName) {
        const lower = processName.toLowerCase();
        found = processes.find((p) => (p[1] || '').toLowerCase().includes(lower));
      }
      if (!found) {
        return {
          passed: false,
          evidence: `Process not running: ${processName || expectedPid}`,
          duration: Date.now() - start,
          autoScore: 0,
        };
      }
      return {
        passed: true,
        evidence: `Process running: PID=${found[0]}, name=${found[1] || found[0]}`,
        duration: Date.now() - start,
        autoScore: 1,
      };
    } catch (err) {
      return {
        passed: false,
        evidence: `Process check error: ${err.message}`,
        duration: Date.now() - start,
        autoScore: 0,
      };
    }
  }

  async _verifySemantic(cp, runData, start) {
    // P6 enhancement: multimodal model comparison.
    return {
      passed: false,
      evidence: 'Semantic checkpoint requires multimodal model (P6)',
      duration: Date.now() - start,
      autoScore: 0,
    };
  }

  async _verifyCustomScript(cp, runData, start) {
    const { script } = cp.params || {};
    if (!script) {
      return {
        passed: false,
        evidence: 'No script provided',
        duration: Date.now() - start,
        autoScore: 0,
      };
    }

    try {
      const result = vm.runInNewContext(
        `(function() { ${script} })()`,
        {
          runData: JSON.parse(JSON.stringify(runData)),
          fs,
          path,
          console: { log: () => {} },
          require,
          JSON,
          Math,
          Date,
          RegExp,
          Array,
          Object,
          String,
          Number,
          Boolean,
        },
        { timeout: 10000 }
      );
      return {
        passed: !!result,
        evidence: `Script returned: ${JSON.stringify(result).slice(0, 200)}`,
        duration: Date.now() - start,
        autoScore: result ? 1 : 0,
      };
    } catch (err) {
      return {
        passed: false,
        evidence: `Script error: ${err.message}`,
        duration: Date.now() - start,
        autoScore: 0,
      };
    }
  }
}

/**
 * Hamming distance between two hex dHash strings.
 * Each character is 4 bits, so XOR each char and count differing bits.
 */
function _hammingDistanceHex(a, b) {
  const hexMap = {};
  for (let i = 0; i < 16; i++) {
    hexMap[i < 10 ? String(i) : String.fromCharCode(87 + i)] = i;
  }
  let d = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const v = (hexMap[a[i]] || 0) ^ (hexMap[b[i]] || 0);
    // count set bits in v (4-bit value)
    d += (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);
  }
  return d;
}

module.exports = { CheckpointVerifier };
