#!/usr/bin/env node
/* khy-agent-run.js — run the built-in KHY agent against a live KHY-OS, with the
 * project AI gateway as its decision brain (real model decisions).
 *
 * This is the in-process / side-a counterpart to khy-mcp.js (external / side-b):
 * it attaches the built-in KhyAgent to the kernel's COM2 channel and answers the
 * decision plane via makeGatewayBrain(). If the gateway is down or no model is
 * configured, the brain transparently degrades to the dependency-free rule set,
 * so the kernel is never blocked.
 *
 * Start KHY-OS with its agent serial first (COM2 on a unix socket), e.g.
 *   make -C kernel run-agent            # COM1 on stdio, COM2 on /tmp/khy-agent.sock
 * then in another shell:
 *   node kernel/bridge/khy-agent-run.js                 # uses /tmp/khy-agent.sock
 *   node kernel/bridge/khy-agent-run.js --socket /path  # explicit socket
 * Pick the model in-system from the OS shell:  ai use model claude/claude-sonnet-4-20250514
 * (it persists to /disk/etc/agent.conf, which this agent re-reads on SIGHUP).
 *
 * Diagnostics go to stderr only.
 */
'use strict';

const { KhyAgent } = require('./khy-agent');
const { makeGatewayBrain } = require('./khy-brain-gateway');

function log(m) { process.stderr.write(`[khy-agent] ${m}\n`); }

async function main() {
  const argv = process.argv.slice(2);
  let socketPath = process.env.KHY_COM2_SOCK || process.env.AGENT_SOCK || '/tmp/khy-agent.sock';
  const si = argv.indexOf('--socket');
  if (si >= 0 && argv[si + 1]) socketPath = argv[si + 1];

  const brain = makeGatewayBrain({ onError: (e) => log(`gateway brain fell back to rules: ${e.message}`) });
  const agent = new KhyAgent({
    socketPath,
    brain,
    onEvent: (e) => log(`event ${e.kind || e.type || ''} ${JSON.stringify(e)}`),
  });

  await agent.start();
  const cfg = agent.config && Object.keys(agent.config).length ? JSON.stringify(agent.config) : '(none)';
  log(`built-in agent attached to ${socketPath}; brain=gateway; in-system config=${cfg}`);
  log('serving the decision plane — Ctrl-C to detach. (`ai`/`agentask` in the OS shell now hit the model.)');

  // Let the user pick up a freshly-changed model without restarting: SIGHUP re-reads config.
  process.on('SIGHUP', () => {
    agent.refreshConfig()
      .then((c) => log(`config reloaded: ${JSON.stringify(c)}`))
      .catch((e) => log(`config reload failed: ${e.message}`));
  });

  const shutdown = () => { agent.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[khy-agent] fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}

module.exports = { main };
