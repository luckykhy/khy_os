/**
 * Cost Guard Plugin — daily token budget enforcement.
 *
 * Blocks requests when daily token usage exceeds configured budget.
 * Copy to ~/.khyquant/gateway_plugins/cost-guard.js to activate.
 *
 * Environment variables:
 *   COST_GUARD_DAILY_BUDGET=100000  (tokens per day)
 */
const DAILY_BUDGET = parseInt(process.env.COST_GUARD_DAILY_BUDGET, 10) || 100000;

let _dailyUsage = 0;
let _lastReset = Date.now();

function checkReset() {
  const now = Date.now();
  if (now - _lastReset > 24 * 60 * 60 * 1000) {
    _dailyUsage = 0;
    _lastReset = now;
  }
}

module.exports = {
  name: 'cost-guard',
  priority: 300,
  enabled: true,
  hooks: {
    onBeforeRequest: async (ctx, next) => {
      checkReset();
      if (_dailyUsage >= DAILY_BUDGET) {
        ctx.cancelled = true;
        ctx._cancelReason = `Daily token budget exceeded (${_dailyUsage}/${DAILY_BUDGET})`;
        console.warn(`[CostGuard] Request blocked: ${ctx._cancelReason}`);
      }
      return next(ctx);
    },

    onAfterResponse: async (ctx, next) => {
      // Track token usage from response
      const tokens = ctx.response?.tokenUsage;
      if (tokens) {
        _dailyUsage += (tokens.totalTokens || tokens.total_tokens || 0);
      }
      return next(ctx);
    },
  },
};
