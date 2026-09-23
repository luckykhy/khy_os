'use strict';

/**
 * `GET /large-tasks/board` 的路由契约测试。
 *
 * 最要紧的一条断言是**路由顺序**：`/board` 必须声明在 `/:taskId` 之前，
 * 否则会被通配路由遮蔽 —— 表现为 404 或「查某个 id 为 board 的任务」，
 * 且**不会有任何守卫自然发现**（因为路由仍然存在、语法仍然正确）。
 */

const largeTasksRoute = require('../../src/routes/largeTasks');
const runtime = require('../../src/tasks/largeTaskRuntimeStore');
const board = require('../../src/tasks/largeTaskBoard');

function _makeRes() {
  return {
    statusCode: 200,
    body: null,
    req: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function _routeIndex(method, routePath) {
  const lowered = String(method || '').toLowerCase();
  return largeTasksRoute.stack.findIndex(
    (layer) => layer && layer.route && layer.route.path === routePath && layer.route.methods?.[lowered]
  );
}

async function _invokeRoute(method, routePath, reqPatch = {}) {
  const index = _routeIndex(method, routePath);
  if (index < 0) throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  const layer = largeTasksRoute.stack[index];

  const req = {
    method: String(method || '').toUpperCase(),
    headers: reqPatch.headers || {},
    body: reqPatch.body || {},
    query: reqPatch.query || {},
    params: reqPatch.params || {},
  };
  const res = _makeRes();

  const handlers = layer.route.stack.map((item) => item.handle);
  let cursor = 0;
  const next = async (error) => {
    if (error) throw error;
    const handler = handlers[cursor++];
    if (!handler) return;
    return handler(req, res, next);
  };

  await next();
  return { status: res.statusCode, body: res.body };
}

const AGENT_COMMANDS = require('../../src/services/agentLauncherRegistry').getLauncherCommands();

const SAMPLE = [
  { id: 'a1', type: 'generic', status: 'running', payload_json: { source: 'claude' }, progress_pct: 30 },
  { id: 'a2', type: 'generic', status: 'succeeded', payload_json: { source: 'codex', title: '收尾' } },
  { id: 'a3', type: 'generic', status: 'dead_letter', payload_json: { source: 'ghost' } },
  { id: 'a4', type: 'generic', status: 'paused', payload_json: {} },
  { id: 'a5', type: 'generic', status: 'bogus', payload_json: { source: 'claude' } },
];

describe('GET /large-tasks/board', () => {
  let spy;

  beforeEach(() => {
    spy = jest.spyOn(runtime, 'listTasks').mockReturnValue(SAMPLE.map((t) => ({ ...t })));
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('路由已声明，且在 /:taskId 之前（防通配遮蔽）', () => {
    const boardIndex = _routeIndex('get', '/board');
    const paramIndex = _routeIndex('get', '/:taskId');
    expect(boardIndex).toBeGreaterThanOrEqual(0);
    expect(paramIndex).toBeGreaterThanOrEqual(0);
    expect(boardIndex).toBeLessThan(paramIndex);
  });

  it('返回 success 信封，data 含 trace_id / generated_at / total / lanes / swimlanes / cards / counts', async () => {
    const { status, body } = await _invokeRoute('get', '/board');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeTruthy();
    for (const key of ['trace_id', 'generated_at', 'total', 'lanes', 'swimlanes', 'cards', 'counts']) {
      expect(Object.prototype.hasOwnProperty.call(body.data, key)).toBe(true);
    }
    expect(typeof body.data.generated_at).toBe('string');
    expect(Number.isNaN(Date.parse(body.data.generated_at))).toBe(false);
  });

  it('lanes 为 6 列且顺序与 LANE_ORDER 一致', async () => {
    const { body } = await _invokeRoute('get', '/board');
    expect(body.data.lanes.map((l) => l.id)).toEqual([...board.LANE_ORDER]);
  });

  it('swimlanes 含全部执行体 + 平台 source + 兜底，且每项带 count', async () => {
    const { body } = await _invokeRoute('get', '/board');
    const ids = body.data.swimlanes.map((s) => s.id);
    for (const command of AGENT_COMMANDS) expect(ids).toContain(command);
    expect(ids).toContain(board.FALLBACK_SWIMLANE.id);
    for (const lane of body.data.swimlanes) expect(typeof lane.count).toBe('number');
  });

  it('counts 自洽：byLane 之和 + unmapped === total === 传入任务数', async () => {
    const { body } = await _invokeRoute('get', '/board');
    const { counts, total } = body.data;
    const laneSum = Object.values(counts.byLane).reduce((a, b) => a + b, 0);
    expect(laneSum + counts.unmapped).toBe(total);
    expect(total).toBe(SAMPLE.length);
    expect(counts.unmapped).toBe(1); // a5 的 bogus 状态
  });

  it('未知状态与未登记 source 都不丢单（lane=null 但仍在 cards 里）', async () => {
    const { body } = await _invokeRoute('get', '/board');
    const card = body.data.cards.find((c) => c.id === 'a5');
    expect(card).toBeTruthy();
    expect(card.lane).toBeNull();
    expect(body.data.cards.find((c) => c.id === 'a3').swimlane).toBe(board.FALLBACK_SWIMLANE.id);
  });

  it('把 status / type / source 过滤参数透传给 listTasks', async () => {
    await _invokeRoute('get', '/board', { query: { status: 'running', type: 'generic', source: 'claude' } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ status: 'running', type: 'generic', source: 'claude' });
  });

  it('未提供过滤参数时不传 undefined 之外的键（保持 listTasks 默认语义）', async () => {
    await _invokeRoute('get', '/board', { query: {} });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ status: undefined, type: undefined, source: undefined });
  });

  it('limit 越界被钳到边界，非数字回退默认值', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      type: 'generic',
      status: 'queued',
      payload_json: { source: 'claude' },
    }));
    spy.mockReturnValue(many);

    const clampedLow = await _invokeRoute('get', '/board', { query: { limit: '0' } });
    expect(clampedLow.body.data.cards).toHaveLength(1);
    expect(clampedLow.body.data.total).toBe(10);

    const clampedHigh = await _invokeRoute('get', '/board', { query: { limit: '999999' } });
    expect(clampedHigh.body.data.cards).toHaveLength(10); // 上限 2000 > 10，全给

    const nonNumeric = await _invokeRoute('get', '/board', { query: { limit: 'abc' } });
    expect(nonNumeric.body.data.cards).toHaveLength(10); // 回退默认 500 > 10
  });

  it('listTasks 抛错时返回 fail 信封与 500（不把异常泄成 200 空看板）', async () => {
    spy.mockImplementation(() => {
      throw new Error('boom');
    });
    const { status, body } = await _invokeRoute('get', '/board');
    expect(status).toBe(500);
    expect(body.success).toBe(false);
  });

  it('空任务集仍返回完整的 6 列 + 兜底泳道（前端不需要判空）', async () => {
    spy.mockReturnValue([]);
    const { body } = await _invokeRoute('get', '/board');
    expect(body.data.total).toBe(0);
    expect(body.data.lanes).toHaveLength(board.LANE_ORDER.length);
    expect(body.data.swimlanes.map((s) => s.id)).toContain(board.FALLBACK_SWIMLANE.id);
    expect(body.data.cards).toEqual([]);
  });
});
