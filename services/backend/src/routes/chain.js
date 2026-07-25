'use strict';

/**
 * chain.js — REST routes for LangChain-compatible chain execution.
 *
 * POST /api/chain/run   — execute a chain
 * GET  /api/chain/list  — list registered chains
 * GET  /api/chain/health — health check
 */

const express = require('express');
const router = express.Router();
const chainWasm = require('../services/chainWasm');
const { flexibleAuth } = require('../middleware/auth');

// Local chain registry (in-process, no Python dependency)
const _chains = new Map();

// Register a built-in echo chain for demo/testing
_chains.set('echo', {
  name: 'echo',
  type: 'llm',
  run: (input, params) => {
    const template = params?.template || 'echo: {input}';
    return chainWasm.renderTemplate(template, ['input'], [input]);
  },
});

// Register a ReAct parser chain
_chains.set('react-parse', {
  name: 'react-parse',
  type: 'tool',
  run: (input) => {
    return JSON.stringify(chainWasm.parseReactResponse(input));
  },
});

// Register a template chain
_chains.set('template', {
  name: 'template',
  type: 'llm',
  run: (input, params) => {
    const template = params?.template || '{input}';
    const keys = params?.keys || ['input'];
    const values = params?.values || [input];
    return chainWasm.renderTemplate(template, keys, values);
  },
});

/**
 * POST /run — execute a chain
 * Body: { chain: string, input: string, params?: object }
 */
router.post('/run', flexibleAuth, async (req, res) => {
  const { chain: chainName, input, params } = req.body || {};

  if (!chainName) {
    return res.status(400).json({ error: 'Missing "chain" field' });
  }

  const validation = chainWasm.validateInput(input || '', 0);
  if (validation === -2) {
    return res.status(400).json({ error: 'Input cannot be empty' });
  }

  // Try local chain first
  const localChain = _chains.get(chainName);
  if (localChain) {
    const start = Date.now();
    try {
      const output = await Promise.resolve(localChain.run(input, params || {}));
      return res.json({
        output,
        chain: chainName,
        elapsed_ms: Date.now() - start,
        source: 'local',
      });
    } catch (err) {
      return res.status(500).json({ error: err.message, chain: chainName });
    }
  }

  // Try Python service if available
  let chainService;
  try {
    chainService = require('../../../packages/khy-chain/bridge/chainService');
  } catch {
    return res.status(404).json({
      error: `Chain '${chainName}' not found (local chains: ${[..._chains.keys()].join(', ')})`,
    });
  }
  try {
    const result = await chainService.runChain(chainName, input, params || {});
    return res.json({ ...result, source: 'python' });
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.message?.includes('not found')) {
      return res.status(404).json({
        error: `Chain '${chainName}' not found (local chains: ${[..._chains.keys()].join(', ')})`,
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /list — list registered chains
 */
router.get('/list', flexibleAuth, async (_req, res) => {
  const local = [..._chains.values()].map(c => ({
    name: c.name,
    type: c.type,
    source: 'local',
  }));

  // Try to include Python chains
  try {
    const chainService = require('../../../packages/khy-chain/bridge/chainService');
    if (await chainService.isHealthy()) {
      const remote = await chainService.listChains();
      return res.json([...local, ...remote.map(c => ({ ...c, source: 'python' }))]);
    }
  } catch { /* Python service not available */ }

  res.json(local);
});

/**
 * GET /health — check chain subsystem health
 */
router.get('/health', async (_req, res) => {
  const wasmOk = chainWasm.isWasmAvailable();
  let pythonOk = false;
  try {
    const chainService = require('../../../packages/khy-chain/bridge/chainService');
    pythonOk = await chainService.isHealthy();
  } catch { /* not available */ }

  res.json({
    status: 'ok',
    wasm: wasmOk ? 'loaded' : 'fallback_js',
    python: pythonOk ? 'connected' : 'unavailable',
    chains: [..._chains.keys()],
  });
});

/**
 * Register a custom chain programmatically.
 * Used by plugins/extensions to add chains at runtime.
 */
function registerChain(name, type, runFn) {
  _chains.set(name, { name, type, run: runFn });
}

router.registerChain = registerChain;

module.exports = router;
