/* index.js — public entry point for the host khy-bridge.
 *
 * Re-exports the bridge class, the shared tool surface, both agent front-ends,
 * and the protocol/codec building blocks so a consumer imports one module:
 *   - KhyBridge  : the channel — translates COM2 frames <-> JSON across 3 planes.
 *   - makeTools  : the single OS capability surface (control plane as tools).
 *   - KhyAgent   : the built-in agent, in-process (requirement 1, side a).
 *   - KhyMcpServer: expose the surface to an external agent over MCP (side b).
 * Both agents drive the OS through the same KhyBridge — no duplicated protocol.
 * Pure Node stdlib underneath — no dependencies, so an agent process runs
 * independently of the kernel (loose coupling).
 *
 *   const { KhyBridge } = require('./bridge');
 *   const bridge = await new KhyBridge({ socketPath: '/tmp/khy-agent.sock' }).connect();
 *   console.log(await bridge.list('/'));
 *   bridge.on('event', (e) => console.log('event', e));
 *   bridge.onDecision((q) => q.includes('shut down') ? 'DENY' : 'ALLOW');
 *
 *   // or run the built-in agent:
 *   const { KhyAgent } = require('./bridge');
 *   const agent = await new KhyAgent({ socketPath: '/tmp/khy-agent.sock' }).start();
 */
'use strict';

const { KhyBridge, KhyStatusError } = require('./khy-bridge');
const { makeTools } = require('./khy-tools');
const { KhyAgent, defaultBrain } = require('./khy-agent');
const { makeGatewayBrain } = require('./khy-brain-gateway');
const { KhyMcpServer } = require('./khy-mcp');
const frame = require('./khy-frame');
const protocol = require('./khy-protocol');

module.exports = {
  KhyBridge, KhyStatusError,
  makeTools, KhyAgent, defaultBrain, makeGatewayBrain, KhyMcpServer,
  frame, protocol,
};

