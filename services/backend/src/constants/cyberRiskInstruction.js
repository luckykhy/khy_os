'use strict';

/**
 * Security instruction for responsible AI tool use.
 * Ported from Claude Code's cyberRiskInstruction.ts architecture.
 */
const CYBER_RISK_INSTRUCTION =
  'IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. ' +
  'Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. ' +
  'Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: ' +
  'pentesting engagements, CTF competitions, security research, or defensive use cases.';

module.exports = { CYBER_RISK_INSTRUCTION };
