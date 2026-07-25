/**
 * NotebookEditTool — replace/insert/delete cells in Jupyter notebooks (.ipynb).
 * Aligned with Claude Code's NotebookEdit tool.
 */
const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');

class NotebookEditTool extends BaseTool {
  static toolName = 'NotebookEdit';
  static category = 'filesystem';
  static risk = 'high';
  static aliases = ['notebook_edit', 'edit_notebook'];
  static searchHint = 'jupyter notebook ipynb cell edit replace insert delete';

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source.
The notebook_path must be absolute. Cell numbering is 0-indexed.
Use edit_mode=insert to add a new cell; edit_mode=delete to remove a cell.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      required: ['notebook_path', 'new_source'],
      properties: {
        notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file.' },
        cell_number: { type: 'number', description: '0-indexed cell number to edit.' },
        cell_id: { type: 'string', description: 'Cell ID to edit (alternative to cell_number).' },
        cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type. Required for insert.' },
        edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Edit mode. Defaults to replace.' },
        new_source: { type: 'string', description: 'New source content for the cell.' },
      },
    };
  }

  async execute(params) {
    const { notebook_path, new_source, edit_mode = 'replace' } = params;

    if (!notebook_path || !path.isAbsolute(notebook_path)) {
      return { error: 'notebook_path must be an absolute path.' };
    }
    if (!notebook_path.endsWith('.ipynb')) {
      return { error: 'File must be a .ipynb notebook.' };
    }
    if (!fs.existsSync(notebook_path)) {
      return { error: `Notebook not found: ${notebook_path}` };
    }

    try {
      const raw = fs.readFileSync(notebook_path, 'utf-8');
      const notebook = JSON.parse(raw);

      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        return { error: 'Invalid notebook format: no cells array.' };
      }

      // Find cell index
      let cellIndex = params.cell_number;
      if (params.cell_id && cellIndex === undefined) {
        cellIndex = notebook.cells.findIndex(c => c.id === params.cell_id);
        if (cellIndex < 0) {
          return { error: `Cell ID "${params.cell_id}" not found.` };
        }
      }

      const sourceLines = (new_source || '').split('\n').map((l, i, arr) =>
        i < arr.length - 1 ? l + '\n' : l
      );

      switch (edit_mode) {
        case 'replace': {
          if (cellIndex === undefined || cellIndex < 0 || cellIndex >= notebook.cells.length) {
            return { error: `Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).` };
          }
          notebook.cells[cellIndex].source = sourceLines;
          if (params.cell_type) notebook.cells[cellIndex].cell_type = params.cell_type;
          // Clear outputs for code cells
          if (notebook.cells[cellIndex].cell_type === 'code') {
            notebook.cells[cellIndex].outputs = [];
            notebook.cells[cellIndex].execution_count = null;
          }
          break;
        }
        case 'insert': {
          const newCell = {
            cell_type: params.cell_type || 'code',
            source: sourceLines,
            metadata: {},
          };
          if (newCell.cell_type === 'code') {
            newCell.outputs = [];
            newCell.execution_count = null;
          }
          const insertAt = (cellIndex !== undefined && cellIndex >= 0)
            ? Math.min(cellIndex + 1, notebook.cells.length)
            : notebook.cells.length;
          notebook.cells.splice(insertAt, 0, newCell);
          break;
        }
        case 'delete': {
          if (cellIndex === undefined || cellIndex < 0 || cellIndex >= notebook.cells.length) {
            return { error: `Cell index ${cellIndex} out of range.` };
          }
          notebook.cells.splice(cellIndex, 1);
          break;
        }
        default:
          return { error: `Unknown edit_mode: ${edit_mode}` };
      }

      fs.writeFileSync(notebook_path, JSON.stringify(notebook, null, 1), 'utf-8');

      return {
        success: true,
        edit_mode,
        cellCount: notebook.cells.length,
        message: `Notebook ${edit_mode}d successfully.`,
      };
    } catch (err) {
      return { error: err.message };
    }
  }
}

module.exports = NotebookEditTool;
