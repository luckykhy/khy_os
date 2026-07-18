'use strict';

/**
 * aiManagementServer 的「每用户编码项目工作区 REST 处理器」子系统。
 *
 * 承载 /api/ai/projects 的一簇 HTTP 处理器,均按 user_id 归属、经 routeRequest 分派:
 * list / create / get / update / delete + archive(归档/恢复经 body.archived)。
 * 一个 Project = 用户命名的多文件夹工作区锚点(对齐 Hermes v0.18.0 桌面 coding projects);
 * 对话经 Conversation.project_id 归属某项目,AIChat 侧栏按当前项目过滤。
 *
 * **全部可变态私有于本叶子**:_projectStore(懒加载单例)——宿主不触碰,故可无环抽出。
 *
 * **反向边经依赖注入打破**:处理器体调宿主的 sendJson / sendError / parseBody(无态响应工具)、
 * authenticateRequest(§5·态在宿主 DB)。宿主加载时调一次 setProjectsDeps 注入;被迁函数体仍按
 * **同名**引用。与 aiManagementConversationsPrompts.js 同门同形(DI 反向边 + resolveAuthUserId)。
 *
 * **刻意非纯零 IO 叶子**:懒加载 projectStore;读 DB。放置为 aiManagementServer.js 的**同目录兄弟**
 * 以保懒 require 相对路径字节不变。
 */

// 宿主注入的反向边(响应工具 + 认证),加载时由 setProjectsDeps 注入一次。
let sendJson = null;
let sendError = null;
let parseBody = null;
let authenticateRequest = null;
function setProjectsDeps(deps = {}) {
  if (typeof deps.sendJson === 'function') sendJson = deps.sendJson;
  if (typeof deps.sendError === 'function') sendError = deps.sendError;
  if (typeof deps.parseBody === 'function') parseBody = deps.parseBody;
  if (typeof deps.authenticateRequest === 'function') authenticateRequest = deps.authenticateRequest;
}

// Per-user coding projects (named multi-folder workspaces). Lazy-required so
// model/DB bootstrap only happens on first use (matches the daemon's boot-order
// idiom; mirrors getConversationStore in the sibling leaf).
let _projectStore = null;
function getProjectStore() {
  if (!_projectStore) _projectStore = require('./projectStore');
  return _projectStore;
}

// Resolve the authenticated user's id (0 for the local-owner bypass modes).
// Sends a 401 envelope and returns null when auth fails; legitimate id 0 passes.
// Same contract as the conversations leaf's resolveAuthUserId.
async function resolveAuthUserId(req, res) {
  const auth = req.authContext || await authenticateRequest(req);
  if (!auth || !auth.ok) {
    sendJson(res, 401, { success: false, message: (auth && auth.error) || 'Authentication required' });
    return null;
  }
  return auth.user?.id ?? 0;
}

async function handleListProjects(req, res, query) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const includeArchived = !!(query && (query.includeArchived === '1' || query.includeArchived === 'true'));
    const data = await getProjectStore().list(userId, { includeArchived });
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to list projects');
  }
}

async function handleCreateProject(req, res) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req);
    const data = await getProjectStore().create(userId, body || {});
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to create project');
  }
}

async function handleGetProject(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = await getProjectStore().get(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to load project');
  }
}

async function handleUpdateProject(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req);
    const data = await getProjectStore().update(userId, id, body || {});
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to update project');
  }
}

async function handleDeleteProject(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const data = await getProjectStore().remove(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to delete project');
  }
}

// Archive / restore toggle. body.archived === false restores; anything else (or
// absent) archives. Thin wrapper over the store's archive/restore guards.
async function handleArchiveProject(req, res, id) {
  const userId = await resolveAuthUserId(req, res);
  if (userId === null) return;
  try {
    const body = await parseBody(req).catch(() => ({}));
    const store = getProjectStore();
    const data = body && body.archived === false
      ? await store.restore(userId, id)
      : await store.archive(userId, id);
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendError(res, err.statusCode || 500, err.message || 'Failed to archive project');
  }
}

module.exports = {
  handleListProjects,
  handleCreateProject,
  handleGetProject,
  handleUpdateProject,
  handleDeleteProject,
  handleArchiveProject,
  // Internal (exported for tests)
  getProjectStore,
  resolveAuthUserId,
  // Dependency injection
  setProjectsDeps,
};
