/**
 * Intelligent Strategy Service - Frontend Interface
 *
 * Corresponds to the Strategy Adaptation Layer (策略适配层) in the thesis.
 * Provides helper methods for strategy management operations
 * including type classification, parameter presets, and template loading.
 */

import request from '@/api/request';

/**
 * Get available strategy templates categorized by type.
 * @returns {Promise<Object>} Templates grouped by strategy type
 */
export async function getStrategyTemplates() {
  const { data } = await request.get('/api/strategies/templates');
  return data;
}

/**
 * Get parameter presets for a given strategy type and complexity level.
 * @param {string} type - Strategy type (trend/momentum/arbitrage/etc.)
 * @param {string} complexity - Complexity level (low/medium/high)
 * @returns {Promise<Object>} Suggested parameters
 */
export async function getParameterPresets(type, complexity = 'medium') {
  const { data } = await request.get('/api/strategies/presets', {
    params: { type, complexity }
  });
  return data;
}

export default { getStrategyTemplates, getParameterPresets };
