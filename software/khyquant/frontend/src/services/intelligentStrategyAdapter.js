/**
 * Intelligent Strategy Adapter - Frontend Interface
 *
 * Corresponds to the Strategy Adaptation Layer (策略适配层) in the thesis.
 * Provides client-side strategy type detection and auto-configuration
 * that mirrors backend/src/services/intelligentStrategyAdapter.js.
 *
 * The heavy lifting (language detection, complexity analysis, parameter
 * generation) is performed server-side; this module exposes a thin
 * interface for the frontend to invoke the adapter API.
 */

import request from '@/api/request';

/**
 * Analyze strategy code and return detected language, type, complexity,
 * and auto-generated configuration.
 * @param {string} code - Strategy source code
 * @returns {Promise<Object>} Analysis result from the adapter layer
 */
export async function analyzeStrategy(code) {
  const { data } = await request.post('/api/strategies/analyze', { code });
  return data;
}

export default { analyzeStrategy };
