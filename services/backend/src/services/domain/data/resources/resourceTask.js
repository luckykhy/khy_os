'use strict';

const orchestrator = require('../../../../tasks/largeTaskOrchestrator');
const runtimeStore = require('../../../../tasks/largeTaskRuntimeStore');
const { createResourceManager } = require('./resourceManager');

function createResourceTaskAdapter(options = {}) {
  const tasks = options.orchestrator || orchestrator;
  const runtime = options.runtime || runtimeStore;
  const manager = options.manager || createResourceManager(options.managerOptions || {});

  function existingTask(idempotencyKey) {
    return runtime.listTasks({ type: 'resource_download' }).find(task => task.idempotency_key === idempotencyKey) || null;
  }

  async function fetch(id, fetchOptions = {}) {
    const item = manager.manifest.resources.find(resource => resource.id === id);
    if (!item) throw new Error(`unknown resource: ${id}`);
    const value = item.platforms[manager.platform];
    const key = `resource:${id}:${item.version}:${manager.platform}:${value ? value.sha256 : 'unsupported'}`;
    let task = existingTask(key);
    if (!task || ['failed', 'cancelled'].includes(task.status)) {
      try {
        task = tasks.createTask({
          type: 'resource_download',
          idempotency_key: key,
          max_attempts: fetchOptions.maxAttempts || 3,
          payload_json: { resource_id: id, kind: item.kind, version: item.version, platform: manager.platform, downloaded_bytes: 0, total_bytes: value && value.size || null, source: null },
        });
      } catch (err) {
        task = existingTask(key);
        if (!task) throw err;
      }
    }
    if (task.status === 'succeeded') return { task, result: task.last_result || manager.resolve(id) };
    if (!['queued', 'retry_wait'].includes(task.status)) return { task, result: manager.resolve(id) };

    const run = await tasks.runTask(task.id, async ctx => {
      let lastUpdate = 0;
      let activeSource = value && value.sources[0] || null;
      const resource = await manager.ensure(id, {
        ...fetchOptions,
        signal: ctx.signal,
        onSource(source) {
          activeSource = source;
          if (fetchOptions.onSource) fetchOptions.onSource(source);
        },
        onProgress(downloaded, total) {
          const now = Date.now();
          if (now - lastUpdate < 250 && total && downloaded < total) return;
          lastUpdate = now;
          ctx.ensureNotCancelled();
          const percent = total ? Math.min(99, Math.floor(downloaded * 100 / total)) : 0;
          ctx.reportProgress(percent);
          const current = runtime.getTask(ctx.taskId);
          runtime.updateTaskFields(ctx.taskId, { payload_json: { ...current.payload_json, downloaded_bytes: downloaded, total_bytes: total, source: activeSource } });
        },
      });
      if (!['present', 'provisioned'].includes(resource.status)) throw new Error(resource.error || `resource fetch ended with ${resource.status}`);
      ctx.reportProgress(100);
      return resource;
    }, { dry_run: false, signal: fetchOptions.signal, idle_timeout_ms: 0 });
    return { task: runtime.getTask(task.id), result: run.result || manager.resolve(id), run };
  }

  return { fetch };
}

module.exports = { createResourceTaskAdapter };
