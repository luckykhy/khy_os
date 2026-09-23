'use strict';

/**
 * taskStore.js — A2A 服务端任务态的单一真源（标准 A2A `task` schema）。
 *
 * 这是 S3（A2A 服务端任务面）的存储内核。khy 此前只有 A2A **出站客户端**
 * （`services/a2a/index.js`）和**发现端点**（`routes/wellKnown.js` 发布的 Agent Card），
 * 但任务面（message/send、tasks/get、tasks/cancel）的服务端实现为零 —— 别人发来一条
 * 消息，khy 无从受理，更无法用 tasks/get 查进度、用 tasks/cancel 撤销。
 *
 * 本模块提供 `TaskStore`：一个内存任务仓库，严格按 A2A v0.3.0 的 `task` 形状存储
 * （`{ id, contextId, status:{state,timestamp,message?}, history[], artifacts[], metadata }`），
 * 状态迁移走 `taskStateSpec.canTransition` 校验（终态之后不得再迁），绝不抛。
 *
 * 它**不**触碰任何传输层（REST 绑定在 `routes/a2a.js`，方法语义在 `serverMethods.js`），
 * 也不依赖私有 ACP 方言（`a2aRegistry.js` / `acpTransport.js`）—— 那是 14 个内置 agent
 * 用的另一套东西，方法集不重叠，互不相干。
 *
 * 契约：存储 IO 可注入（默认内存 Map），便于单测；状态校验失败降级为 false / null，不抛。
 * @module services/a2a/taskStore
 */

const crypto = require('crypto');
const taskStateSpec = require('./taskStateSpec');

/** 生成带前缀的任务 / 上下文 id（避免与对端 id 碰撞）。 */
function _genId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

/**
 * 构造一条规范 `TaskStatus`。
 * @param {string} a2aState
 * @param {object} [opts]
 * @returns {{ state: string, timestamp: string, message?: object }}
 */
function _makeStatus(a2aState, opts = {}) {
  const status = { state: a2aState, timestamp: new Date().toISOString() };
  if (opts.message && typeof opts.message === 'object') status.message = opts.message;
  return status;
}

class TaskStore {
  constructor() {
    /** @type {Map<string, object>} */
    this._tasks = new Map();
  }

  /**
   * 新建任务（状态 submitted）。
   * @param {object} [params]
   * @param {string} [params.contextId] 上下文 id；缺省自动生成
   * @param {object} [params.message]   触发该任务的 Message（原样留存进 history[0].message）
   * @param {object} [params.metadata]  透传元数据
   * @returns {object} Task
   */
  createTask(params = {}) {
    const id = _genId('task');
    const contextId = params.contextId || _genId('ctx');
    const status = _makeStatus('submitted', { message: params.message });
    const task = {
      id,
      contextId,
      status,
      history: [status],
      artifacts: [],
      metadata: params.metadata && typeof params.metadata === 'object' ? params.metadata : {},
    };
    this._tasks.set(id, task);
    return task;
  }

  /**
   * 取任务（不存在 → null）。
   * @param {string} id
   * @returns {object|null}
   */
  getTask(id) {
    if (!id) return null;
    return this._tasks.get(id) || null;
  }

  /**
   * 追加一条历史状态（并刷新当前 status）。迁移非法 → 返回 null 且不改状态。
   * @param {string} id
   * @param {string} a2aState 规范状态（非规范值经 taskStateSpec 归一，未知 → 'unknown'）
   * @param {object} [opts]
   * @returns {object|null} 更新后的 Task，失败 → null
   */
  appendStatus(id, a2aState, opts = {}) {
    const task = this.getTask(id);
    if (!task) return null;
    const next = taskStateSpec.toA2aState(a2aState);
    if (!taskStateSpec.canTransition(task.status.state, next)) {
      return null;
    }
    const status = _makeStatus(next, { message: opts.message });
    task.status = status;
    task.history.push(status);
    if (opts.artifact && typeof opts.artifact === 'object') {
      task.artifacts.push(opts.artifact);
    }
    return task;
  }

  /**
   * 取消任务（→ canceled 终态）。
   * @param {string} id
   * @returns {object|null}
   */
  cancelTask(id) {
    return this.appendStatus(id, 'canceled');
  }

  /**
   * 列出全部任务（浅拷贝，避免调用方改动内部 Map）。
   * @returns {object[]}
   */
  listTasks() {
    return Array.from(this._tasks.values()).map((t) => ({ ...t }));
  }

  /**
   * 清空（仅测试用）。
   */
  clear() {
    this._tasks.clear();
  }
}

module.exports = { TaskStore, _genId, _makeStatus };
