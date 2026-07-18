'use strict';

/**
 * cloneCapabilityTasks.js — 「深拷贝能力任务清单(浅克隆每 task·数组字段 patterns/requiredTools 复制)」纯 helper
 *   (纯叶子·零 IO·无状态·不 mutate 入参)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_cloneCapabilityTasks(tasks = [])`——
 *   services/capabilityAssessment(内部用·:88/:89)· services/toolUseLoopCore(内部用·:916/:917)。
 *
 * 语义:非数组入参 → [];否则仅保留对象型 task·各 `{...task}` 浅克隆并把
 *   `patterns`/`requiredTools`(若为数组)另复制一份数组(否则置 [])→ 防调用方
 *   共享同一数组引用互相污染。
 *
 * 契约:纯叶子(无 IO/状态)·不 mutate 入参。各消费方保留同名本地
 *   `const _cloneCapabilityTasks = require('../utils/cloneCapabilityTasks')`
 *   → 调用点逐字节不变。
 */

function _cloneCapabilityTasks(tasks = []) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter(task => task && typeof task === 'object')
    .map(task => ({
      ...task,
      patterns: Array.isArray(task.patterns) ? [...task.patterns] : [],
      requiredTools: Array.isArray(task.requiredTools) ? [...task.requiredTools] : [],
    }));
}

module.exports = _cloneCapabilityTasks;
