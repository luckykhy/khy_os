'use strict';

/**
 * capabilityRegistry — a thin facade over the tool registry that surfaces
 * "capabilities": tools authored to the capability-as-code convention.
 *
 * Background: Khyos "learns" by landing capabilities as executable code +
 * tests + auto-discovery (shipped via the wheel/npm to every user), NOT as a
 * private assistant memory note. The existing tool registry
 * (`defineTool` + `tools/index.js`) already fans one descriptor out to the
 * agent tool-loop, the CLI, and MCP. The only missing piece is making
 * "this capability has tests" a first-class, discoverable fact.
 *
 * A capability is simply a tool whose `defineTool({ capability: {...} })`
 * metadata block is present (see `_baseTool.js`). This module reads that block
 * and lets users inspect what Khyos can do and whether each capability is
 * test-covered. It deliberately does NOT run the tests (that is left to the
 * normal test runner / CI) — it only proves the declared tests EXIST, which is
 * the cheap, reliable guarantee that matters at the CLI surface.
 *
 * @pattern Facade
 */

const fs = require('fs');
const path = require('path');

// Capability `tests` paths are declared relative to the backend package root
// (e.g. 'tests/docTitleStyle.test.js'). __dirname is services/backend/src/services,
// so two levels up is services/backend.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * @typedef {object} CapabilityInfo
 * @property {string} name      - Underlying tool name.
 * @property {string} summary   - One-line human summary of the capability.
 * @property {string} learnedFrom - Provenance note (when/why it was learned).
 * @property {string[]} surfaces - Surfaces it is exposed on (cli/agent/mcp).
 * @property {string[]} tests   - Repo-relative test paths backing it.
 */

/**
 * List every registered capability (tools carrying a `.capability` block).
 * @returns {CapabilityInfo[]} sorted by name.
 */
function listCapabilities() {
  const tools = require('../tools').getAll();
  const out = [];
  for (const tool of tools.values()) {
    const cap = tool && tool.capability;
    if (!cap || typeof cap !== 'object') continue;
    out.push({
      name: tool.name,
      summary: cap.summary || tool.description || '',
      learnedFrom: cap.learnedFrom || '',
      surfaces: Array.isArray(cap.surfaces) ? [...cap.surfaces] : [],
      tests: Array.isArray(cap.tests) ? [...cap.tests] : [],
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Describe a single capability, including a presence check for each declared
 * test file. Returns null if no such capability exists.
 *
 * @param {string} name - Tool/capability name.
 * @returns {(CapabilityInfo & { testsResolved: Array<{path:string, absPath:string, exists:boolean}>, testsPresent: boolean }) | null}
 */
function describeCapability(name) {
  const info = listCapabilities().find((c) => c.name === name);
  if (!info) return null;

  const testsResolved = info.tests.map((rel) => {
    const absPath = path.resolve(PACKAGE_ROOT, rel);
    let exists = false;
    try { exists = fs.existsSync(absPath); } catch { exists = false; }
    return { path: rel, absPath, exists };
  });

  return {
    ...info,
    testsResolved,
    // A capability with NO declared tests counts as not-covered (false), which
    // is the honest signal — the convention requires at least one test.
    testsPresent: testsResolved.length > 0 && testsResolved.every((t) => t.exists),
  };
}

module.exports = { listCapabilities, describeCapability, PACKAGE_ROOT };
