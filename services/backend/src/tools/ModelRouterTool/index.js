const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class ModelRouterTool extends BaseTool {
  static toolName = 'ModelRouter';
  static category = 'ai';
  static risk = 'low';
  static aliases = ['model_router', 'route_model', 'select_model'];
  static searchHint = 'model routing provider selection';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Intelligent model routing across providers.

Operations:
- "list_providers" — List all registered providers
- "route_by_model" — Find best provider for a model
- "route_by_capability" — Find providers by capability
- "route_by_cost" — Find cheapest provider for a model
- "route_by_latency" — Find fastest provider for a model
- "stats" — Get routing statistics`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list_providers', 'route_by_model', 'route_by_capability', 'route_by_cost', 'route_by_latency', 'stats'],
          description: 'Operation to perform',
        },
        modelName: {
          type: 'string',
          description: 'Model name (for route_by_model/cost/latency)',
        },
        capability: {
          type: 'string',
          description: 'Capability (for route_by_capability)',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_MODEL_ROUTER_TIMEOUT_MS',
      defaultMs: 5000,
      min: 100,
      max: 30000,
    });

    try {
      const router = require('../../services/modelRouter');
      router.initDefaults();

      switch (params.operation) {
        case 'list_providers':
          return { success: true, providers: router.listProviders() };

        case 'route_by_model':
          if (!params.modelName) return { success: false, error: 'modelName is required' };
          return { success: true, route: router.routeByModel(params.modelName) };

        case 'route_by_capability':
          if (!params.capability) return { success: false, error: 'capability is required' };
          return { success: true, route: router.routeByCapability(params.capability) };

        case 'route_by_cost':
          if (!params.modelName) return { success: false, error: 'modelName is required' };
          return { success: true, route: router.routeByCost(params.modelName) };

        case 'route_by_latency':
          if (!params.modelName) return { success: false, error: 'modelName is required' };
          return { success: true, route: router.routeByLatency(params.modelName) };

        case 'stats':
          return { success: true, stats: router.getRoutingStats() };

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Model router error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `模型路由：${input.operation || ''}`;
  }
}

module.exports = ModelRouterTool;
