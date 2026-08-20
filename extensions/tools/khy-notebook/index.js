'use strict';

/**
 * @pattern Command, Facade
 *
 * khy-notebook —— Jupyter Notebook (.ipynb) 单元格编辑。
 *
 * 本文件是拓展入口，**不是** BaseTool 子类。这是契约的要求而非风格选择：
 * [DESIGN-ARCH-069] §2.2 的禁止边写着「拓展 → L2 不走深层相对路径」，
 * 而 `services/backend/src/tools/_baseTool` 正是 L2 深处。拓展导出纯对象，
 * 由漏斗侧的 `pluginContribResolver.activateContributedTool()` 调
 * `defineTool()` 包装成正式工具再注册 —— 拓展一行核代码都不 import。
 *
 * 分工（与 §3.2 的字段优先级一致）：
 *   - JSON 装得下的（name/description/category/risk/inputSchema/aliases/…）
 *     写在 khy.extension.json 里，manifest 胜；
 *   - 装不下的函数（execute/prompt）写在这里，入口胜。
 * 所以下面**只有**函数，没有一个标量字段的重复声明 —— 重复即分叉。
 *
 * 行为逐字移植自原 services/backend/src/tools/NotebookEditTool/index.js，
 * 含 `insertd` 这处成功文案的拼写怪癖：迁移轮只搬不改，改动会让
 * 「迁移前后行为一致」这条验证失去意义。要修另开一轮。
 */

const fs = require('fs');
const path = require('path');

async function execute(params) {
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

    let cellIndex = params.cell_number;
    if (params.cell_id && cellIndex === undefined) {
      cellIndex = notebook.cells.findIndex((c) => c.id === params.cell_id);
      if (cellIndex < 0) {
        return { error: `Cell ID "${params.cell_id}" not found.` };
      }
    }

    const sourceLines = (new_source || '')
      .split('\n')
      .map((l, i, arr) => (i < arr.length - 1 ? l + '\n' : l));

    switch (edit_mode) {
      case 'replace': {
        if (cellIndex === undefined || cellIndex < 0 || cellIndex >= notebook.cells.length) {
          return {
            error: `Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).`,
          };
        }
        notebook.cells[cellIndex].source = sourceLines;
        if (params.cell_type) {
          notebook.cells[cellIndex].cell_type = params.cell_type;
        }
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
        const insertAt =
          cellIndex !== undefined && cellIndex >= 0
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

function prompt() {
  return `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source.
The notebook_path must be absolute. Cell numbering is 0-indexed.
Use edit_mode=insert to add a new cell; edit_mode=delete to remove a cell.`;
}

module.exports = {
  tools: [{ name: 'NotebookEdit', execute, prompt }],
};
