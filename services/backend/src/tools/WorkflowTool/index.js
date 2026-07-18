const { BaseTool } = require('../_baseTool');

class WorkflowTool extends BaseTool {
  static toolName = 'Workflow';
  static category = 'coordinator';
  static risk = 'medium';
  static aliases = ['workflow', 'run_workflow'];
  static searchHint = 'workflow automation sequence pipeline';
  static shouldDefer = true;

  isConcurrencySafe() { return false; }

  prompt() {
    return `Execute a predefined workflow.

Two supported shapes (auto-detected from the stored JSON):
  1) A canonical graph { nodes, connections } — the SAME format the visual editor
     saves and \`khy workflow import\` produces. This is EXECUTED natively here via
     the workflow interpreter (LLM / tool / code / loop / branch nodes run for real).
  2) A legacy { steps, description } list — returned for the orchestrator to drive.

Use dry_run to preview a graph's structure (node/edge counts) without running it.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name or path' },
        inputs: { type: 'object', description: 'Input parameters for the workflow' },
        dry_run: { type: 'boolean', description: 'Preview steps without executing', default: false },
      },
      required: ['name'],
    };
  }

  async execute(params, ctx = {}) {
    const fs = require('fs');
    const path = require('path');

    // Look for workflow definition. Includes the app-data store that
    // `khy workflow import` writes to, so CLI-imported graphs are runnable here.
    const searchPaths = [
      path.join(process.cwd(), '.khy', 'workflows', `${params.name}.json`),
      path.join(require('os').homedir(), '.khy', 'workflows', `${params.name}.json`),
    ];
    try {
      const { getAppDataDir } = require('../../utils/dataHome');
      searchPaths.push(path.join(getAppDataDir('workflows'), `${params.name}.json`));
    } catch { /* dataHome unavailable — fall back to .khy paths only */ }

    let workflowDef = null;
    let loadedFrom = null;
    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        try {
          workflowDef = JSON.parse(fs.readFileSync(p, 'utf-8'));
          loadedFrom = p;
          break;
        } catch { /* ignore */ }
      }
    }

    if (!workflowDef) {
      return {
        error: `Workflow "${params.name}" not found. Create one at .khy/workflows/${params.name}.json or import via \`khy workflow import\`.`,
        searchedPaths: searchPaths,
      };
    }

    // ── Canonical graph { nodes, connections }: execute natively. ──────────────
    const isGraph = Array.isArray(workflowDef.nodes) && Array.isArray(workflowDef.connections);
    if (isGraph) {
      const core = require('../../services/workflow/workflowCliCore');
      if (params.dry_run) {
        const summary = core.summarizeGraph(workflowDef);
        return {
          success: true, dry_run: true, name: params.name, kind: 'graph',
          source: loadedFrom, ...summary,
        };
      }
      const executor = require('../../services/workflow/workflowExecutor');
      const userId = ctx && ctx.userId != null ? ctx.userId : null;
      try {
        const outcome = await executor.runGraph(
          { nodes: workflowDef.nodes, connections: workflowDef.connections },
          {
            primitives: executor.defaultPrimitives({ userId }),
            vars: params.inputs || {},
          },
        );
        return {
          success: outcome.status === 'completed',
          name: params.name, kind: 'graph', status: outcome.status,
          vars: outcome.vars, log: outcome.log, source: loadedFrom,
        };
      } catch (err) {
        return {
          success: false, name: params.name, kind: 'graph',
          error: (err && err.message) || String(err),
          vars: (err && err.vars) || undefined,
        };
      }
    }

    // ── Legacy { steps } list: hand back to the orchestrator (unchanged). ──────
    if (params.dry_run) {
      return {
        success: true,
        dry_run: true,
        name: params.name,
        steps: workflowDef.steps || [],
        description: workflowDef.description || '',
      };
    }

    return {
      success: true,
      name: params.name,
      steps: workflowDef.steps || [],
      inputs: params.inputs || {},
      message: 'Workflow loaded. Steps will be executed by the AI orchestrator.',
    };
  }

  getActivityDescription(input) { return `执行工作流：${input.name}`; }
}

module.exports = WorkflowTool;
